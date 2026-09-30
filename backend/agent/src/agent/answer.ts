/**
 * The writer between the model's text and the wire.
 *
 * Holds the first few characters of a turn back until it is clear the turn is an answer and
 * not a preamble to a tool call; on the first real text it freezes the source list, sends
 * `sources`, opens the stream, and from then on passes every delta through the citation
 * filter and out as a `token` — so `sources` always precedes the first token.
 */
import type { Source } from '@lumina/contract';
import { CitationFilter } from './citations.js';
import type { RunCtx, Src } from './context.js';
import type { LlmMessage } from '../providers/llm.js';
import { clip, stripCitations } from '../util/text.js';

const COMMIT_AFTER_CHARS = 8;

export class AnswerWriter {
  text = '';
  committed = false;
  wire: Source[] = [];
  private buffer = '';
  private filter: CitationFilter | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: RunCtx,
    private readonly beforeCommit: () => Promise<void> = async () => undefined
  ) {}

  /** Synchronous hook for the LLM stream; work is chained so order is preserved. */
  onText = (delta: string): void => {
    this.chain = this.chain.then(() => this.handle(delta));
  };

  private async handle(delta: string): Promise<void> {
    if (this.committed) {
      this.emitFiltered(delta);
      return;
    }
    this.buffer += delta;
    if (this.buffer.length >= COMMIT_AFTER_CHARS) await this.commit();
  }

  /** Freeze sources, send them, open the stream, then release held text. */
  async commit(): Promise<void> {
    if (this.committed) return;
    this.committed = true;
    await this.beforeCommit();
    this.ctx.mark('verifyDone');
    this.ctx.sourcesFrozen = true;
    this.ctx.number();
    this.wire = this.ctx.wireSources();
    this.ctx.init.stream.send('sources', this.wire);
    this.ctx.init.stream.open();
    this.filter = new CitationFilter(this.ctx.citable());
    const held = this.buffer;
    this.buffer = '';
    if (held) this.emitFiltered(held);
  }

  /** End of one model turn. A short preamble before a tool call is dropped, not sent. */
  async endTurn(calledTools: boolean): Promise<void> {
    await this.chain;
    if (!this.committed && calledTools) this.buffer = '';
  }

  async finish(): Promise<void> {
    await this.chain;
    if (!this.committed) await this.commit();
    const rest = this.plain(this.filter?.flush() ?? '') + this.flushPlain();
    if (rest) this.emit(rest);
  }

  /** Text the harness itself adds (a cap notice). Never contains a citation. */
  note(text: string): void {
    this.emit(text);
  }

  private emitFiltered(t: string): void {
    const out = this.filter ? this.filter.push(t) : t;
    const plain = this.plain(out);
    if (plain) this.emit(plain);
  }

  // The UI renders plain text, so Markdown emphasis and heading marks are stripped on the way
  // out (the prompt asks for plain text; this makes it true). A trailing "*" or "#"/newline is
  // held for one chunk so a "**" split across two deltas is still caught.
  private tail = '';
  private plain(t: string): string {
    let s = this.tail + t;
    this.tail = '';
    const hold = /(\*+|\n#*)$/.exec(s);
    if (hold && hold[0] && s.length > 0) {
      this.tail = hold[0];
      s = s.slice(0, s.length - hold[0].length);
    }
    return s.replace(/\*\*|__/g, '').replace(/(^|\n)#{1,6} /g, '$1');
  }

  private flushPlain(): string {
    const rest = this.tail.replace(/\*\*|__/g, '');
    this.tail = '';
    return rest;
  }

  private emit(t: string): void {
    if (this.ctx.ttftMs === null) {
      this.ctx.ttftMs = this.ctx.elapsedMs();
      this.ctx.mark('firstToken');
    }
    this.ctx.init.stream.send('token', { text: t });
    this.text += t;
    this.ctx.answerText += t;
  }
}

/** How sources are shown to the model: number, where it came from, and the text it may use. */
export function formatSources(sources: Src[], maxChars: number, withSubQuestion = false): string {
  if (!sources.length) return 'SOURCES: none. Retrieval found nothing usable for this question.';
  return (
    'SOURCES:\n\n' +
    sources
      .map((s) => {
        const where =
          s.kind === 'web'
            ? s.url
            : `${s.title}${s.locator?.page ? `, p. ${s.locator.page}` : s.locator?.heading ? `, § ${s.locator.heading}` : s.locator?.line ? `, line ${s.locator.line}` : ''}`;
        const sq = withSubQuestion && s.subQuestion ? ` (sub-question ${s.subQuestion})` : '';
        return `[${s.n}]${sq} ${s.title}\n${where}\n${clip(s.text, maxChars)}`;
      })
      .join('\n\n')
  );
}

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The thread so far, as alternating user/assistant turns the model can read. Old citation
 * markers are stripped: they point into an earlier answer's numbering, not this one's.
 */
export function historyMessages(stored: StoredMessage[], maxTurns = 6): LlmMessage[] {
  const recent = stored.filter((m) => m.content?.trim()).slice(-maxTurns);
  const out: LlmMessage[] = [];
  for (const m of recent) {
    const content = clip(m.role === 'assistant' ? stripCitations(m.content) : m.content, 1500);
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content as string}\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0]?.role !== 'user') out.shift();
  // The new question is a user turn, so history must end on an assistant turn.
  while (out.length && out[out.length - 1]?.role !== 'assistant') out.pop();
  return out;
}
