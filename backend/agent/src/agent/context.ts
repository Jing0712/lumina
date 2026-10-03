/**
 * Everything one ask accumulates: the trace, the tool budget, tokens and cost, the sources
 * retrieved so far, and why it stopped. The run log, the `done` event and the `/stats` row
 * are all read out of this one object, so they cannot disagree.
 */
import type { AskMode, Depth, Locator, Source, ToolName } from '@lumina/contract';
import { env, llmPrice } from '../env.js';
import type { AskStream } from './stream.js';

export class CapReached extends Error {
  constructor(readonly which: 'tool-calls' | 'wall-clock') {
    super(which === 'tool-calls' ? 'tool-call cap reached' : 'wall-clock cap reached');
  }
}

/** A retrieved thing, before and after it gets its citation number. */
export interface Src {
  n?: number;
  kind: 'web' | 'doc';
  title: string;
  url?: string;
  docId?: string;
  locator?: Locator;
  snippet: string;
  subQuestion?: number;
  /** What the model reads. Never sent to the client. */
  text: string;
  /** Snippet checked against the raw page: true found, false not found, null could not check. */
  verified: boolean | null;
  /** Dedupe identity: url, or docId + full locator. */
  key: string;
  /** Resolves once the page fetch that backs this source has finished (web only). */
  settled?: Promise<void>;
}

export interface ToolCallLog {
  name: ToolName;
  ok: boolean;
  error?: string;
  ms: number;
  /** Ordering key for the run log: deep fan-out finishes out of order, the log should not. */
  order: number;
}

/** One deep-search subagent, as the run log records it: the branch under the plan node. */
export interface SubagentLog {
  subQuestion: number;
  question: string;
  ms: number;
  toolCalls: number;
  sources: number;
  /** Tokens the subagent's own notes call spent (its context held only its own pages). */
  tokens: number;
}

export interface RunInit {
  requestId: string;
  userId: string;
  threadId: string;
  answerId: string;
  query: string;
  mode: AskMode;
  depth: Depth;
  spaceId?: string;
  stream: AskStream;
  clientSignal: AbortSignal;
}

export class RunCtx {
  readonly started = Date.now();
  readonly deadline: number;
  readonly maxToolCalls: number;
  readonly signal: AbortSignal;
  private readonly deadlineCtl = new AbortController();
  private deadlineTimer: NodeJS.Timeout;

  step = 0;
  toolCallsUsed = 0;
  readonly toolCalls: ToolCallLog[] = [];
  tokensIn = 0;
  tokensOut = 0;
  embedTokens = 0;
  llmCostUsd = 0;
  searches = 0;
  searchHits = 0;
  ttftMs: number | null = null;
  /** Where the time went, for the per-answer log line: ms from request start to each mark. */
  readonly marks: Record<string, number> = {};
  mark(name: string): void {
    this.marks[name] ??= this.elapsedMs();
  }
  /** Everything sent as `token`, in order: what the thread stores as the answer. */
  answerText = '';
  sources: Src[] = [];
  sourcesFrozen = false;
  capHit: CapReached | null = null;
  modelsUsed = new Set<string>();
  /** Deep only: the subagent tree, and the fan-out's wall clock vs. what it would cost serially. */
  subagents: SubagentLog[] = [];
  fanOut: { wallMs: number; serialMs: number } | null = null;
  /** Quick only: the answer was replayed from the semantic answer cache. */
  answerCached = false;
  /** The query's embedding, when the answer cache computed one (reused to store the answer). */
  queryEmbedding: number[] | null = null;
  /** Long-term memories shaped this answer, so it is personal and must not be cached. */
  usedMemories = false;

  constructor(readonly init: RunInit) {
    const deep = init.depth === 'deep';
    this.maxToolCalls = deep ? env.maxToolCallsDeep : env.maxToolCalls;
    const wallMs = (deep ? env.maxWallClockSecDeep : env.maxWallClockSec) * 1000;
    this.deadline = this.started + wallMs;
    this.deadlineTimer = setTimeout(() => {
      this.capHit ??= new CapReached('wall-clock');
      this.deadlineCtl.abort(this.capHit);
    }, wallMs);
    this.signal = AbortSignal.any([init.clientSignal, this.deadlineCtl.signal]);
  }

  get deep(): boolean {
    return this.init.depth === 'deep';
  }

  dispose(): void {
    clearTimeout(this.deadlineTimer);
  }

  /** Claim one tool call from the budget. False means the cap is reached: stop, honestly. */
  reserve(): boolean {
    if (this.toolCallsUsed >= this.maxToolCalls) {
      this.capHit ??= new CapReached('tool-calls');
      return false;
    }
    this.toolCallsUsed++;
    return true;
  }

  remainingToolCalls(): number {
    return Math.max(0, this.maxToolCalls - this.toolCallsUsed);
  }

  /** Emit a trace step and record it for the run log. */
  trace(
    tool: ToolName,
    input: Record<string, unknown>,
    r: { ok: boolean; ms: number; reason?: string; error?: string; subQuestion?: number; order?: number }
  ): void {
    this.step++;
    const error = r.ok ? undefined : (r.error?.trim() || 'failed without a message');
    this.init.stream.send('trace', {
      step: this.step,
      tool,
      input,
      ok: r.ok,
      ms: Math.max(0, Math.round(r.ms)),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(error ? { error } : {}),
      ...(r.subQuestion ? { subQuestion: r.subQuestion } : {})
    });
    this.toolCalls.push({ name: tool, ok: r.ok, ...(error ? { error } : {}), ms: Math.round(r.ms), order: r.order ?? this.step * 1000 });
  }

  addLlmUsage(model: string, tokensIn: number, tokensOut: number): void {
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    const p = llmPrice(model);
    this.llmCostUsd += (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out;
    this.modelsUsed.add(model);
  }

  addSearch(cached: boolean): void {
    this.searches++;
    if (cached) this.searchHits++;
  }

  get costUsd(): number {
    const searchCost = (this.searches - this.searchHits) * env.priceSearchPerCall;
    const embedCost = (this.embedTokens / 1e6) * env.priceEmbeddingPerMTok;
    return Number((this.llmCostUsd + searchCost + embedCost).toFixed(6));
  }

  /** true only when EVERY search in the request was a cache hit (and there was one). */
  get searchCached(): boolean {
    return this.searches > 0 && this.searchHits === this.searches;
  }

  /** Add sources, skipping ones already held (same url, or same doc + locator). */
  addSources(list: Src[]): Src[] {
    const have = new Set(this.sources.map((s) => s.key));
    const added: Src[] = [];
    for (const s of list) {
      if (have.has(s.key)) continue;
      have.add(s.key);
      this.sources.push(s);
      added.push(s);
    }
    this.number();
    return added;
  }

  /** Contiguous numbering from 1, in the order sources were kept. */
  number(): void {
    this.sources.forEach((s, i) => (s.n = i + 1));
  }

  /**
   * Numbers the answer may cite: only sources whose snippet was FOUND in the raw page (doc
   * chunks are their own haystack). `null` used to count as citable, but null also means "the
   * verify fetch had not finished when the answer started", and those snippets come from the
   * search provider's extract, which the raw page often does not contain (the likely cause of
   * the ungrounded citation in the Oct 1 smoke run). An unverified source stays readable, just
   * not citable.
   */
  citable(): Set<number> {
    return new Set(this.sources.filter((s) => s.verified === true && s.n).map((s) => s.n as number));
  }

  wireSources(): Source[] {
    return this.sources.map((s) => ({
      n: s.n as number,
      kind: s.kind,
      title: s.title,
      snippet: s.snippet || s.title,
      ...(s.url ? { url: s.url } : {}),
      ...(s.docId ? { docId: s.docId } : {}),
      ...(s.locator ? { locator: s.locator } : {}),
      ...(s.subQuestion ? { subQuestion: s.subQuestion } : {})
    }));
  }

  elapsedMs(): number {
    return Date.now() - this.started;
  }
}

export const docKey = (docId: string, l: Locator): string => `${docId}:${l.page ?? ''}:${l.heading ?? ''}:${l.line ?? ''}`;
