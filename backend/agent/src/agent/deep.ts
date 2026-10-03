/**
 * The deep gear: Perplexity's Pro Search.
 *
 *   plan_research → `plan` event (before ANY retrieval) → one isolated SUBAGENT per
 *   sub-question, all in parallel → merge into one numbering → one structured, cited synthesis.
 *
 * A subagent owns one branch of the plan: it searches, reads its pages, and then writes short
 * cited notes in its OWN model context, which holds its sub-question and its pages and nothing
 * else (not the user's thread, not the other branches). The synthesis reads the notes plus the
 * merged sources. Isolation is what keeps each branch on its facet; parallelism is what keeps
 * the wall clock near the slowest branch instead of the sum of them (the run log records both
 * as `fanOut.wallMs` vs `fanOut.serialMs`, and every step carries its branch's `subQuestion`,
 * so the trace reads as a tree: plan_research at the root, one subtree per subagent).
 *
 * The tool budget is allocated up front from the plan (so the fan-out fits inside the deep
 * cap by construction), and pages another sub-question already claimed are skipped, so deep
 * reads wider rather than re-reading the same two pages.
 */
import type { SubQuestion } from '@lumina/contract';
import { env } from '../env.js';
import * as llm from '../providers/llm.js';
import { clip, normalize } from '../util/text.js';
import { AnswerWriter, formatSources } from './answer.js';
import type { RunCtx, Src } from './context.js';
import { PLAN_TOOL, deepSynthesisSystem, plannerSystem, subagentSystem } from './prompts.js';
import { recallMemory, researchDocs, researchWeb } from './tools.js';

export interface Plan {
  subQuestions: SubQuestion[];
}

export async function runDeep(ctx: RunCtx, history: llm.LlmMessage[]): Promise<{ writer: AnswerWriter; plan: Plan }> {
  const { query, mode, spaceId } = ctx.init;

  // ---- plan first; memory recall runs alongside (it is not retrieval)
  const [plan, memories] = await Promise.all([planResearch(ctx, history), recallMemory(ctx, 1)]);
  ctx.init.stream.send('plan', plan);
  ctx.init.stream.open(); // the plan is deep search's first paint

  // ---- allocate the budget from the plan
  const n = plan.subQuestions.length;
  const searchesPer = mode === 'auto' && spaceId ? 2 : 1;
  const pages =
    mode === 'docs'
      ? 0
      : Math.max(1, Math.min(env.deepPagesPerSubQuestion, Math.floor((ctx.remainingToolCalls() - n * searchesPer) / n)));

  // ---- fan out: one isolated subagent per sub-question, all at once
  const claimed = new Set<string>();
  const fanStart = Date.now();
  const results: Subagent[] = new Array(n);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= n) return;
      results[idx] = await runSubagent(ctx, plan.subQuestions[idx] as SubQuestion, n, pages, claimed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(env.deepConcurrency, n) }, lane));
  ctx.fanOut = { wallMs: Date.now() - fanStart, serialMs: results.reduce((t, r) => t + r.ms, 0) };
  ctx.mark('fanOutDone');

  // ---- merge: one numbering, deduped, in plan order; then point each subagent's local [k]
  // at the merged number, so its notes cite the same list the answer does
  for (const r of results) ctx.addSources(r.sources);
  const findings = results
    .map((r) => {
      const notes = r.notes.replace(/\[(\d{1,2})\]/g, (_m, k: string) => {
        // By key, not object: a chunk two branches both found survives the merge only once.
        const key = r.cited[Number(k) - 1]?.key;
        const merged = key ? ctx.sources.find((s) => s.key === key) : undefined;
        return merged?.n ? `[${merged.n}]` : '';
      });
      return `${r.sq.i}. ${r.sq.question}\n${notes.trim() || '(no usable pages for this sub-question)'}`;
    })
    .join('\n\n');
  for (const r of results) {
    ctx.subagents.push({
      subQuestion: r.sq.i,
      question: r.sq.question,
      ms: r.ms,
      toolCalls: ctx.toolCalls.filter((t) => t.order >= r.sq.i * 100_000 && t.order < (r.sq.i + 1) * 100_000).length,
      sources: r.sources.length,
      tokens: r.tokens
    });
  }

  const writer = new AnswerWriter(ctx);
  await writer.commit(); // sources go out as soon as the research is merged

  const planText = plan.subQuestions.map((s) => `${s.i}. ${s.question}${s.reason ? ` — ${s.reason}` : ''}`).join('\n');
  // Only the last exchange: enough to resolve a follow-up, not enough to tempt the model into
  // re-answering an earlier question (it did, before this cut).
  const messages: llm.LlmMessage[] = [
    ...history.slice(-2),
    {
      role: 'user',
      content: `QUESTION: ${query}\n\nRESEARCH PLAN:\n${planText}\n\nSUBAGENT NOTES (one per sub-question, citing the SOURCES below):\n${findings}\n\n${formatSources(ctx.sources, env.pageCharsDeep, true)}\n\nWrite the structured answer now.`
    }
  ];
  const turn = await llm.stream(
    {
      model: env.llmModelDeep,
      system: deepSynthesisSystem(memories),
      messages,
      maxTokens: env.maxDeepAnswerTokens,
      signal: ctx.signal
    },
    { onText: writer.onText }
  );
  ctx.addLlmUsage(env.llmModelDeep, turn.tokensIn, turn.tokensOut);
  await writer.finish();
  return { writer, plan };
}

interface Subagent {
  sq: SubQuestion;
  sources: Src[];
  /** The sources the notes may cite, in the subagent's local [1..k] numbering. */
  cited: Src[];
  notes: string;
  ms: number;
  tokens: number;
}

/**
 * One branch of the plan, run as an isolated subagent: retrieve, then take notes in a fresh
 * model context that holds only this sub-question and these pages. A provider failure in the
 * notes call throws like any other (one failed branch fails the deep search loudly; it is not
 * papered over with a merged answer that silently lacks a facet).
 */
async function runSubagent(ctx: RunCtx, sq: SubQuestion, of: number, pages: number, claimed: Set<string>): Promise<Subagent> {
  const t0 = Date.now();
  const sources = await researchSub(ctx, sq, of, pages, claimed);
  // Notes cite only what the answer itself may cite: verified web snippets and doc chunks.
  const cited = sources.filter((s) => s.verified === true);
  let notes = '';
  let tokens = 0;
  if (cited.length) {
    const pagesText = cited
      .map((s, k) => `[${k + 1}] ${s.title}\n${s.url ?? s.title}\n${clip(s.text, env.pageCharsDeep)}`)
      .join('\n\n');
    const r = await llm.complete({
      model: env.llmModelSubagent,
      system: subagentSystem(),
      messages: [{ role: 'user', content: `SUB-QUESTION: ${sq.question}\n\nPAGES:\n\n${pagesText}` }],
      maxTokens: env.maxSubagentTokens,
      temperature: 0.2,
      signal: ctx.signal
    });
    ctx.addLlmUsage(env.llmModelSubagent, r.tokensIn, r.tokensOut);
    tokens = r.tokensIn + r.tokensOut;
    notes = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
  return { sq, sources, cited, notes, ms: Date.now() - t0, tokens };
}

async function researchSub(ctx: RunCtx, sq: SubQuestion, of: number, pages: number, claimed: Set<string>): Promise<Src[]> {
  const { mode, spaceId } = ctx.init;
  const order = sq.i * 100_000;
  const label = `subagent ${sq.i}/${of}`;

  if (mode === 'docs') {
    if (!spaceId) return [];
    const d = await researchDocs(ctx, sq.question, { subQuestion: sq.i, reason: `${label}: searching the Space`, limit: 4, order });
    return d.sources;
  }
  if (mode === 'auto' && spaceId) {
    const d = await researchDocs(ctx, sq.question, {
      subQuestion: sq.i,
      reason: `${label}: checking the Space first`,
      limit: 4,
      order,
      decide: (best) => (best >= env.autoDocMinScore ? 'documents answer it' : 'documents weak, also searching the web')
    });
    if (d.sources.length && d.bestScore >= env.autoDocMinScore) return d.sources;
    const w = await researchWeb(ctx, sq.question, { pages, subQuestion: sq.i, reason: `${label}: web`, claimed, order: order + 50_000 });
    return [...d.sources, ...w.sources];
  }
  const w = await researchWeb(ctx, sq.question, { pages, subQuestion: sq.i, reason: `${label}: searching the web`, claimed, order });
  return w.sources;
}

/** plan_research: decompose the question. Deep only — it is never offered to a quick run. */
async function planResearch(ctx: RunCtx, history: llm.LlmMessage[]): Promise<Plan> {
  const min = env.deepSubQuestionsMin;
  const max = Math.max(min, Math.min(env.deepSubQuestionsMax, env.deepSubQuestionsTarget));
  if (!ctx.reserve()) throw new Error('no tool budget left to plan');
  const t0 = Date.now();

  const ask = async (extra?: string) => {
    // Streamed, not complete(): only a streamed call is hedged against the provider's slow
    // starts (LLM_HEDGE_MS), and the plan is deep search's first paint (deep_plan_p95_ms).
    const r = await llm.stream({
      model: env.llmModelPlanner,
      system: plannerSystem(min, max),
      messages: [...history.slice(-2), { role: 'user', content: extra ? `${ctx.init.query}\n\n${extra}` : ctx.init.query }],
      tools: [PLAN_TOOL(min, max)],
      toolChoice: { type: 'tool', name: 'plan_research' },
      maxTokens: 500,
      temperature: 0.3,
      signal: ctx.signal
    });
    ctx.addLlmUsage(env.llmModelPlanner, r.tokensIn, r.tokensOut);
    const use = r.content.find((b) => b.type === 'tool_use');
    const input = (use && use.type === 'tool_use' ? use.input : {}) as {
      subQuestions?: { question?: unknown; reason?: unknown }[];
    };
    const seen = new Set<string>();
    const subs = (Array.isArray(input.subQuestions) ? input.subQuestions : [])
      .map((s) => ({ question: String(s?.question ?? '').trim(), reason: String(s?.reason ?? '').trim() }))
      .filter((s) => {
        const k = normalize(s.question);
        if (!k || seen.has(k) || k === normalize(ctx.init.query)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, max);
    return { subs };
  };

  let out;
  try {
    out = await ask();
    if (out.subs.length < min) {
      out = await ask(`Your previous plan had ${out.subs.length} usable sub-question(s). Give at least ${min}, each a distinct facet.`);
    }
  } catch (err) {
    ctx.trace('plan_research', { query: ctx.init.query }, { ok: false, ms: Date.now() - t0, error: (err as Error).message, order: 0 });
    throw err;
  }
  if (out.subs.length < 2) {
    const msg = `planner returned ${out.subs.length} sub-question(s)`;
    ctx.trace('plan_research', { query: ctx.init.query }, { ok: false, ms: Date.now() - t0, error: msg, order: 0 });
    throw new llm.ProviderError('anthropic', msg);
  }

  const subQuestions: SubQuestion[] = out.subs.map((s, i) => ({ i: i + 1, question: s.question, ...(s.reason ? { reason: s.reason } : {}) }));
  ctx.trace(
    'plan_research',
    { query: ctx.init.query },
    { ok: true, ms: Date.now() - t0, order: 0, reason: `${subQuestions.length} sub-questions` }
  );
  return { subQuestions };
}
