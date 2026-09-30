/**
 * The tools, as the loop sees them. Each one claims a slot from the run's tool budget,
 * emits exactly one trace step, and either returns what it found or throws.
 *
 * Two kinds of failure, kept apart on purpose:
 *  - a PROVIDER failure (search API down, LLM or embeddings erroring) throws ProviderError and
 *    ends the run as a 502. It is never turned into "I couldn't find anything".
 *  - a TOOL failure (one publisher 403s, one page is JS-only) is a trace step with ok:false and
 *    the reason; the run carries on with what it could read.
 */
import { newId, type Locator } from '@lumina/contract';
import { env } from '../env.js';
import { col } from '../db.js';
import { cosine, embed } from '../providers/embed.js';
import { fetchPage } from '../providers/fetchPage.js';
import { searchWeb, type SearchResult } from '../providers/search.js';
import { ProviderError } from '../providers/llm.js';
import { hybridSearch } from '../rag/retrieve.js';
import { clip, collapse, normalize, pickSnippet } from '../util/text.js';
import { docKey, type RunCtx, type Src } from './context.js';

// ---------------------------------------------------------------- web

export interface WebResearch {
  sources: Src[];
  /** Resolves when every page fetch behind these sources has settled (snippets verified). */
  settled: Promise<void>;
  resultCount: number;
}

/**
 * web_search, then fetch_page on the top results.
 *
 * `pipeline`: when the search provider already extracted a page's text (Tavily), the source
 * is usable immediately and the fetch runs alongside the model to verify the snippet against
 * the raw page. Without an extract, the source waits for its own fetch.
 */
export async function researchWeb(
  ctx: RunCtx,
  query: string,
  opts: { pages: number; subQuestion?: number; reason: string; pipeline?: boolean; claimed?: Set<string>; order?: number }
): Promise<WebResearch> {
  if (!ctx.reserve()) return { sources: [], settled: Promise.resolve(), resultCount: 0 };
  const t0 = Date.now();
  const orderBase = opts.order ?? ctx.step * 1000;
  let outcome;
  try {
    outcome = await searchWeb(query, ctx.signal);
  } catch (err) {
    const msg = (err as Error).message;
    ctx.trace('web_search', { query }, { ok: false, ms: Date.now() - t0, error: msg, reason: opts.reason, subQuestion: opts.subQuestion, order: orderBase });
    throw err;
  }
  ctx.addSearch(outcome.cached);
  ctx.mark('searchDone');
  ctx.trace(
    'web_search',
    { query, provider: env.searchProvider, cached: outcome.cached },
    {
      ok: true,
      ms: Date.now() - t0,
      subQuestion: opts.subQuestion,
      order: orderBase,
      reason: `${opts.reason} — ${outcome.results.length} result(s)${
        outcome.cached ? `, cache hit (${outcome.tier})` : outcome.bypassedCache ? ', time-sensitive: cache bypassed' : ''
      }`
    }
  );

  // Pick the pages to read: skip ones another sub-question already claimed, so deep reads wider.
  const picks: SearchResult[] = [];
  for (const r of outcome.results) {
    if (picks.length >= opts.pages) break;
    if (opts.claimed?.has(r.url)) continue;
    if (/\.(pdf|zip|mp4|mp3|png|jpe?g)(\?|$)/i.test(r.url)) continue;
    opts.claimed?.add(r.url);
    picks.push(r);
  }

  const sources: Src[] = [];
  const waits: Promise<void>[] = [];
  let i = 0;
  for (const r of picks) {
    i++;
    if (!ctx.reserve()) break;
    const order = orderBase + i;
    const src: Src = {
      kind: 'web',
      title: r.title,
      url: r.url,
      snippet: '',
      text: '',
      verified: null,
      key: r.url,
      ...(opts.subQuestion ? { subQuestion: opts.subQuestion } : {})
    };
    if (r.rawContent && r.rawContent.length >= 200) {
      src.text = collapse(r.rawContent);
      src.snippet = pickSnippet(src.text, query, null).snippet;
    }
    // Only an abort (the run is ending) can reject here; nothing is waiting on it by then.
    const settled = readPage(ctx, src, r, query, opts.subQuestion, order).catch(() => undefined);
    src.settled = settled;
    waits.push(settled);
    sources.push(src);
  }

  const settled = Promise.all(waits).then(() => undefined);
  if (!opts.pipeline) await settled;
  else await Promise.all(sources.filter((s) => !s.text).map((s) => s.settled));

  // A source with no text at all (fetch failed and no extract) is not a source.
  return { sources: sources.filter((s) => s.text), settled, resultCount: outcome.results.length };
}

async function readPage(ctx: RunCtx, src: Src, r: SearchResult, query: string, subQuestion: number | undefined, order: number): Promise<void> {
  const t0 = Date.now();
  const hadExtract = Boolean(src.text);
  // With the provider's extract in hand, fetch the raw page only to verify against (no jsdom).
  const page = await fetchPage(r.url, ctx.signal, { readText: !hadExtract });
  if (page.ok && page.text) {
    src.text = page.text;
    if (page.title && page.title.length > 3) src.title = page.title.slice(0, 300);
  }
  if (src.text) {
    const picked = pickSnippet(src.text, query, page.rawNormalized);
    src.snippet = picked.snippet;
    src.verified = picked.verified;
  }
  const reason = page.ok
    ? `${hadExtract ? `fetched the raw page (${src.text.length.toLocaleString('en-US')} chars of text via the search provider's extract)` : `read ${page.text.length.toLocaleString('en-US')} chars`}${src.verified === true ? '; citation snippet verified in the raw page' : src.verified === false ? '; no passage verifiable in the raw page, so it will not be cited' : ''}`
    : hadExtract
      ? `publisher fetch failed; reading the search provider's extract of the page instead (snippet unverifiable)`
      : 'could not read the page; skipped';
  ctx.trace(
    'fetch_page',
    { url: r.url },
    { ok: page.ok, ms: Date.now() - t0, error: page.error, reason, subQuestion, order }
  );
}

/** fetch_page as a tool the model can call on its own, for a URL it chose. */
export async function fetchOne(ctx: RunCtx, url: string, query: string): Promise<Src | null> {
  if (!/^https?:\/\//.test(url)) {
    if (!ctx.reserve()) return null;
    ctx.trace('fetch_page', { url }, { ok: false, ms: 0, error: 'not an http(s) URL', reason: 'requested by the model' });
    return null;
  }
  if (!ctx.reserve()) return null;
  const t0 = Date.now();
  const page = await fetchPage(url, ctx.signal);
  const picked = page.ok ? pickSnippet(page.text, query, page.rawNormalized) : null;
  ctx.trace('fetch_page', { url }, { ok: page.ok, ms: Date.now() - t0, error: page.error, reason: 'requested by the model' });
  if (!page.ok || !picked) return null;
  return {
    kind: 'web',
    title: (page.title || url).slice(0, 300),
    url,
    snippet: picked.snippet,
    text: page.text,
    verified: picked.verified,
    key: url
  };
}

// ---------------------------------------------------------------- documents

export interface DocResearch {
  sources: Src[];
  bestScore: number;
}

export async function researchDocs(
  ctx: RunCtx,
  query: string,
  opts: { subQuestion?: number; reason: string; limit?: number; order?: number; decide?: (best: number) => string }
): Promise<DocResearch> {
  const spaceId = ctx.init.spaceId;
  if (!spaceId) return { sources: [], bestScore: 0 };
  if (!ctx.reserve()) return { sources: [], bestScore: 0 };
  const t0 = Date.now();
  let hits;
  try {
    hits = await hybridSearch({ userId: ctx.init.userId, spaceId, query, signal: ctx.signal });
  } catch (err) {
    ctx.trace('search_documents', { query, spaceId }, { ok: false, ms: Date.now() - t0, error: (err as Error).message, reason: opts.reason, subQuestion: opts.subQuestion, order: opts.order });
    throw err;
  }
  ctx.embedTokens += hits.embedTokens;
  const top = hits.chunks.slice(0, opts.limit ?? env.ragTopK);
  ctx.trace(
    'search_documents',
    { query, spaceId },
    {
      ok: true,
      ms: Date.now() - t0,
      subQuestion: opts.subQuestion,
      order: opts.order,
      reason:
        `${opts.reason} — ${top.length} chunk(s) via ${hits.backend}, best cosine ${hits.bestVectorScore.toFixed(2)}` +
        (opts.decide ? `; ${opts.decide(hits.bestVectorScore)}` : '')
    }
  );
  const sources: Src[] = top.map((c) => ({
    kind: 'doc',
    title: c.title,
    docId: c.docId,
    locator: c.locator as Locator,
    snippet: clip(c.text, 1400),
    text: c.text,
    verified: true,
    key: docKey(c.docId, c.locator as Locator),
    ...(opts.subQuestion ? { subQuestion: opts.subQuestion } : {})
  }));
  return { sources, bestScore: hits.bestVectorScore };
}

// ---------------------------------------------------------------- memory

interface MemoryRow {
  _id: string;
  userId: string;
  text: string;
  embedding: number[];
  sourceThread?: string;
  createdAt: Date;
}

export async function recallMemory(ctx: RunCtx, order?: number): Promise<string[]> {
  if (!ctx.reserve()) return [];
  const t0 = Date.now();
  const memories = await col<MemoryRow>('memories');
  const count = await memories.countDocuments({ userId: ctx.init.userId });
  if (count === 0) {
    ctx.trace('recall_memory', { query: ctx.init.query }, { ok: true, ms: Date.now() - t0, reason: 'no long-term memories stored for this user', order });
    return [];
  }

  let vector: number[];
  try {
    const e = await embed([ctx.init.query], ctx.signal);
    ctx.embedTokens += e.tokens;
    vector = e.vectors[0] as number[];
  } catch (err) {
    ctx.trace('recall_memory', { query: ctx.init.query }, { ok: false, ms: Date.now() - t0, error: (err as Error).message, order });
    throw err;
  }

  let rows: { text: string; score: number }[];
  if (env.vectorBackend === 'atlas-vector-search') {
    rows = await memories
      .aggregate<{ text: string; score: number }>([
        {
          $vectorSearch: {
            index: 'memories_vector',
            path: 'embedding',
            queryVector: vector,
            numCandidates: 100,
            limit: env.memoryTopK,
            filter: { userId: ctx.init.userId }
          }
        },
        { $project: { _id: 0, text: 1, score: { $meta: 'vectorSearchScore' } } }
      ])
      .toArray();
    // Atlas reports cosine as (1 + cos) / 2; convert back so the floor means cosine.
    rows = rows.map((r) => ({ ...r, score: r.score * 2 - 1 })).filter((r) => r.score >= env.memoryMinScore);
  } else {
    const all = await memories.find({ userId: ctx.init.userId }).limit(500).toArray();
    rows = all
      .map((m) => ({ text: m.text, score: cosine(vector, m.embedding) }))
      .filter((r) => r.score >= env.memoryMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, env.memoryTopK);
  }

  // Cap what is injected (~1 000 tokens).
  const texts: string[] = [];
  let chars = 0;
  for (const r of rows) {
    if (chars + r.text.length > 4000) break;
    texts.push(r.text);
    chars += r.text.length;
  }
  ctx.trace(
    'recall_memory',
    { query: ctx.init.query },
    {
      ok: true,
      ms: Date.now() - t0,
      order,
      reason: texts.length ? `recalled ${texts.length} memory item(s): ${texts.map((t) => `"${clip(t, 80)}"`).join('; ')}` : 'no stored memory is relevant to this question'
    }
  );
  return texts;
}

export async function saveMemory(ctx: RunCtx, text: string): Promise<{ ok: boolean; id?: string; message: string }> {
  const clean = collapse(String(text ?? '')).slice(0, 500);
  if (!ctx.reserve()) return { ok: false, message: 'tool-call cap reached; memory not saved' };
  const t0 = Date.now();
  if (clean.length < 3) {
    ctx.trace('save_memory', { text: clean }, { ok: false, ms: 0, error: 'empty memory text' });
    return { ok: false, message: 'empty memory text' };
  }
  const memories = await col<MemoryRow>('memories');
  const existing = await memories.find({ userId: ctx.init.userId }).project<{ _id: string; text: string }>({ text: 1 }).limit(500).toArray();
  const dupe = existing.find((m) => normalize(m.text) === normalize(clean));
  if (dupe) {
    ctx.trace('save_memory', { text: clean }, { ok: true, ms: Date.now() - t0, reason: `already stored as ${dupe._id}` });
    return { ok: true, id: dupe._id, message: 'already remembered' };
  }
  let vector: number[];
  try {
    const e = await embed([clean], ctx.signal);
    ctx.embedTokens += e.tokens;
    vector = e.vectors[0] as number[];
  } catch (err) {
    ctx.trace('save_memory', { text: clean }, { ok: false, ms: Date.now() - t0, error: (err as Error).message });
    throw err;
  }
  const id = newId('mem');
  await memories.insertOne({
    _id: id,
    userId: ctx.init.userId,
    text: clean,
    embedding: vector,
    sourceThread: ctx.init.threadId,
    createdAt: new Date()
  });
  ctx.trace('save_memory', { text: clean }, { ok: true, ms: Date.now() - t0, reason: `stored as ${id}; visible and deletable at /memory` });
  return { ok: true, id, message: `saved as ${id}` };
}

export { ProviderError };
