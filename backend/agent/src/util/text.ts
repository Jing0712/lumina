/**
 * Text helpers, including the grounding arithmetic. `normalize`, `snippetIsGrounded` and
 * `stripHtml` deliberately mirror benchmark/lib.mjs and benchmark/bench.mjs: the agent picks a
 * citation's snippet by checking it the same way the grader will, so "grounded" is verified
 * at the source instead of hoped for.
 */

export const normalize = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();

export function snippetIsGrounded(snippet: string, haystackNormalized: string, minTokens = 12): boolean {
  const need = normalize(snippet).split(' ').filter(Boolean);
  const hay = haystackNormalized;
  if (!need.length || !hay) return false;
  if (need.length <= minTokens) return hay.includes(need.join(' '));
  for (let i = 0; i + minTokens <= need.length; i++) {
    if (hay.includes(need.slice(i, i + minTokens).join(' '))) return true;
  }
  return false;
}

/** What the bench sees when it fetches a page: raw HTML with the tags knocked out. */
export const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');

const STOP = new Set(
  (
    'a an and are as at be by can could did do does for from has have how i if in into is it its ' +
    'me my of on or our should so than that the their them then there these they this to was we ' +
    'what when where which who why will with would you your about vs versus between compare ' +
    'explain tell give please much many most more does doing done'
  ).split(' ')
);

export function keywords(query: string): string[] {
  return [...new Set(normalize(query).split(' ').filter((w) => w.length > 2 && !STOP.has(w)))];
}

export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function sentences(text: string): string[] {
  return collapse(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“‘])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface PickedSnippet {
  snippet: string;
  /** true: found in the raw page the way the grader will look. false: checked and not found. null: nothing to check against. */
  verified: boolean | null;
}

/**
 * Share of letters that are Latin a–z. normalize() (like the grader's) keeps only a–z0–9, so a
 * snippet in another script collapses to a few stray Latin words and can never be checked
 * against the page. For a Latin-script question, such snippets and pages are not citable.
 */
export function latinShare(s: string): number {
  const letters = String(s ?? '').match(/\p{L}/gu) ?? [];
  if (!letters.length) return 1;
  let latin = 0;
  for (const ch of letters) if (/[a-z]/i.test(ch)) latin++;
  return latin / letters.length;
}

/**
 * Choose the passage a citation rests on: the window of consecutive sentences that best
 * matches the question, preferring one that is verifiably present in the raw page.
 */
export function pickSnippet(
  text: string,
  query: string,
  rawNormalized: string | null,
  maxChars = 360
): PickedSnippet {
  const sents = sentences(text).filter((s) => s.split(' ').length >= 4 && s.length < 600);
  // A Latin-script question gets Latin-script snippets only (see latinShare).
  const latinQuery = latinShare(query) >= 0.9;
  const kws = keywords(query);
  const candidates: { s: string; score: number; ord: number }[] = [];

  for (let i = 0; i < sents.length && i < 400; i++) {
    let win = '';
    for (let j = i; j < Math.min(sents.length, i + 3); j++) {
      win = win ? `${win} ${sents[j]}` : (sents[j] as string);
      const words = win.split(' ').length;
      if (words < 14 && j < Math.min(sents.length, i + 3) - 1) continue;
      if (win.length > maxChars) break;
      if (latinQuery && latinShare(win) < 0.97) continue;
      const low = normalize(win);
      let score = 0;
      for (const k of kws) if (low.includes(k)) score += 2;
      score += Math.min(words, 45) / 45; // mild preference for fuller passages
      candidates.push({ s: win, score, ord: i });
    }
  }

  if (!candidates.length) {
    const fallback = collapse(text).slice(0, maxChars).replace(/\s+\S*$/, '');
    const verified = rawNormalized === null ? null : snippetIsGrounded(fallback, rawNormalized);
    return { snippet: fallback || collapse(text).slice(0, maxChars), verified };
  }

  candidates.sort((a, b) => b.score - a.score || a.ord - b.ord);
  if (rawNormalized === null) return { snippet: candidates[0]!.s, verified: null };

  // One whole-snippet scan per candidate (a whole match implies the grader's 12-token window
  // match). Scanning every window of every candidate against a multi-MB page is quadratic and
  // blocks the event loop for seconds under load.
  for (const c of candidates.slice(0, 12)) {
    const n = normalize(c.s);
    if (n && rawNormalized.includes(n)) return { snippet: c.s, verified: true };
  }
  return { snippet: candidates[0]!.s, verified: false };
}

/** Trim to a character budget on a word boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/\s+\S*$/, '')} …`;
}

/** Citation markers from an earlier answer mean nothing in a new numbering; drop them from history. */
export const stripCitations = (s: string): string => s.replace(/\s?\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '');

/** Time-sensitive queries bypass the search cache (SPEC 5.2 Should). */
export function isTimeSensitive(query: string, now = new Date()): boolean {
  const q = query.toLowerCase();
  if (/\b(today|tonight|latest|breaking|this week|right now|currently|current|news|yesterday)\b/.test(q)) return true;
  const year = now.getUTCFullYear();
  for (const m of q.matchAll(/\b(20\d\d)\b/g)) if (Number(m[1]) >= year) return true;
  return false;
}
