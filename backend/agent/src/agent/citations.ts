/**
 * A streaming filter over the answer text that makes one promise: every `[n]` that leaves
 * this service resolves to a source in this answer's `sources` event.
 *
 * The prompt asks the model to cite only listed numbers; this is what enforces it. A marker
 * for an unknown number (or a source whose snippet failed verification) is removed before it
 * is sent, and `[1, 3]` is rewritten as `[1][3]` so the UI and the grader both see it.
 * Held-back text is at most one unfinished `[…` at the tail of a chunk.
 */
const COMPLETE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
const OPEN_TAIL = /\[[\d,\s]{0,14}$/;

export class CitationFilter {
  private pending = '';
  readonly used = new Set<number>();

  constructor(private readonly allowed: ReadonlySet<number>) {}

  push(text: string): string {
    this.pending += text;
    const tail = OPEN_TAIL.exec(this.pending);
    let ready = this.pending;
    if (tail) {
      ready = this.pending.slice(0, tail.index);
      this.pending = this.pending.slice(tail.index);
    } else {
      this.pending = '';
    }
    return this.rewrite(ready);
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    // An unfinished "[12" at the very end is not a citation; drop the digits' bracket.
    return this.rewrite(rest.replace(OPEN_TAIL, ''));
  }

  private rewrite(text: string): string {
    return text.replace(COMPLETE, (_m, inner: string) => {
      const nums = inner
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => this.allowed.has(n));
      for (const n of nums) this.used.add(n);
      return [...new Set(nums)].map((n) => `[${n}]`).join('');
    });
  }
}
