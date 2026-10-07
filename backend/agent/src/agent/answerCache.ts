/**
 * Semantic answer cache: a near-duplicate of a question this user asked recently is answered
 * by replaying that answer (its text and the sources it cited) without searching again.
 *
 * The freshness guard is what makes this safe to ship:
 *  - a time-sensitive question ("latest", "today", this year...) is never looked up and never
 *    stored, so a stale answer cannot be served to it, however similar it looks;
 *  - every entry expires after ANSWER_CACHE_TTL_SECONDS (default: the search cache's TTL, so a
 *    replayed answer is never older than the search results it would otherwise have reused);
 *  - only clean answers are stored: quick, web, finished `done`, at least one citation, no Space
 *    (documents change under it) and no long-term memories (the answer was personal).
 *
 * Scope is per user. Matching is cosine over text-embedding-3-small vectors; an exact repeat
 * (same normalized text) matches without an embedding call. Entries live in process (the agent
 * runs as one machine) and are written through to Mongo with a TTL index, so a restart warms
 * from there. A cache failure is a miss, logged, never an answer: the run then searches.
 */
import { env } from '../env.js';
import { col } from '../db.js';
import { log } from '../log.js';
import { cosine, embed } from '../providers/embed.js';
import { normalizeQuery } from '../providers/search.js';
import { isTimeSensitive } from '../util/text.js';
import { AnswerWriter } from './answer.js';
import { hasMemories } from './tools.js';
import type { RunCtx, Src } from './context.js';
import type { Source, Terminated } from '@lumina/contract';

interface Entry {
  _id: string;
  userId: string;
  query: string;
  normalized: string;
  embedding: number[];
  text: string;
  sources: Source[];
  createdAt: Date;
  expiresAt: Date;
}

const MAX_ENTRIES = 1000;
let entries: Entry[] = [];
let warm: Promise<void> | null = null;

/** A follow-up that leans on the thread ("what about its price?") is not a standalone question. */
const REFERS_BACK = /\b(it|its|that|this|they|them|their|those|these|he|she|his|her)\b/i;

export function answerCacheEligible(ctx: RunCtx, hasHistory: boolean): boolean {
  const { query, depth, mode, spaceId } = ctx.init;
  if (!env.answerCacheEnabled || depth !== 'quick' || spaceId || mode === 'docs') return false;
  if (isTimeSensitive(query)) return false;
  if (normalizeQuery(query).split(' ').length < 3) return false;
  if (hasHistory && REFERS_BACK.test(query)) return false;
  return true;
}

function warmUp(): Promise<void> {
  warm ??= (async () => {
    try {
      const c = await col<Entry>('answerCache');
      await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      const rows = await c.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(MAX_ENTRIES).toArray();
      entries = [...rows.reverse(), ...entries];
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'answerCache warm-up failed; starting empty');
    }
  })();
  return warm;
}

export interface CacheHit {
  entry: Entry;
  similarity: number;
}

export async function lookupAnswer(ctx: RunCtx): Promise<CacheHit | null> {
  await warmUp();
  const now = Date.now();
  entries = entries.filter((e) => e.expiresAt.getTime() > now);
  const mine = entries.filter((e) => e.userId === ctx.init.userId);
  if (!mine.length) return null;

  const normalized = normalizeQuery(ctx.init.query);
  const exact = [...mine].reverse().find((e) => e.normalized === normalized);
  if (exact) return { entry: exact, similarity: 1 };

  let vector: number[];
  try {
    const e = await embed([ctx.init.query], ctx.signal);
    ctx.embedTokens += e.tokens;
    vector = e.vectors[0] as number[];
    ctx.queryEmbedding = vector;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    log.warn({ requestId: ctx.init.requestId, err: (err as Error).message }, 'answerCache lookup failed; treating as a miss');
    return null;
  }
  let best: CacheHit | null = null;
  for (const entry of mine) {
    const similarity = cosine(vector, entry.embedding);
    if (similarity >= env.answerCacheMinSimilarity && (!best || similarity > best.similarity)) best = { entry, similarity };
  }
  return best;
}

/**
 * Replay a cached answer. The trace says exactly what happened: one web_search step served from
 * the answer cache (so the run counts one search, and it was a hit), naming the question it
 * matched, how similar it was, and how old the answer is. No provider is called.
 */
export async function serveCached(ctx: RunCtx, hit: CacheHit): Promise<AnswerWriter> {
  const t0 = Date.now();
  const { entry, similarity } = hit;
  if (!ctx.reserve()) throw ctx.capHit;
  ctx.addSearch(true);
  ctx.answerCached = true;
  const ageMin = Math.round((Date.now() - entry.createdAt.getTime()) / 60000);
  ctx.trace(
    'web_search',
    { query: ctx.init.query, cached: true, answerCache: true, matched: entry.query },
    {
      ok: true,
      ms: Date.now() - t0,
      order: 2000,
      reason:
        `semantic answer cache hit (cosine ${similarity.toFixed(3)} with "${entry.query.slice(0, 120)}", answered ${ageMin} min ago, ` +
        `expires in ${Math.max(0, Math.round((entry.expiresAt.getTime() - Date.now()) / 60000))} min): replaying that answer and its ` +
        `${entry.sources.length} retrieved source(s); no search or LLM call. Time-sensitive questions never take this path.`
    }
  );
  ctx.mark('retrievalDone');
  ctx.addSources(entry.sources.map(toSrc));
  const writer = new AnswerWriter(ctx);
  writer.onText(entry.text);
  await writer.finish();
  return writer;
}

const toSrc = (s: Source): Src => ({
  kind: s.kind,
  title: s.title,
  snippet: s.snippet,
  text: s.snippet,
  // Verified when the answer was first written; the snippet and citation numbers are replayed as-is.
  verified: true,
  key: s.url ?? `${s.docId}:${s.locator?.page ?? ''}:${s.locator?.heading ?? ''}:${s.locator?.line ?? ''}`,
  ...(s.url ? { url: s.url } : {}),
  ...(s.docId ? { docId: s.docId } : {}),
  ...(s.locator ? { locator: s.locator } : {}),
  ...(s.subQuestion ? { subQuestion: s.subQuestion } : {})
});

/** After the response: keep a clean answer for its near-duplicates. Never on the TTFT path. */
export async function storeAnswer(ctx: RunCtx, terminated: Terminated, hasHistory: boolean, wire: Source[]): Promise<void> {
  if (ctx.answerCached || terminated !== 'done' || ctx.usedMemories || ctx.capHit) return;
  if (!answerCacheEligible(ctx, hasHistory)) return;
  if (!wire.length || !/\[\d+\]/.test(ctx.answerText)) return;
  try {
    // usedMemories alone is not enough: a memory saved seconds ago can be missing from recall.
    if (await hasMemories(ctx.init.userId)) return;
    let embedding = ctx.queryEmbedding;
    if (!embedding) {
      const e = await embed([ctx.init.query]);
      embedding = e.vectors[0] as number[];
    }
    const now = new Date();
    const entry: Entry = {
      _id: ctx.init.answerId,
      userId: ctx.init.userId,
      query: ctx.init.query,
      normalized: normalizeQuery(ctx.init.query),
      embedding,
      text: ctx.answerText,
      sources: wire,
      createdAt: now,
      expiresAt: new Date(now.getTime() + env.answerCacheTtlSeconds * 1000)
    };
    await warmUp();
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    await (await col<Entry>('answerCache')).insertOne(entry);
  } catch (err) {
    log.warn({ requestId: ctx.init.requestId, err: (err as Error).message }, 'answerCache write failed');
  }
}
