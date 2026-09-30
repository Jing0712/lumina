/**
 * Hybrid retrieval over one Space: dense ($vectorSearch) + lexical ($search, BM25), fused
 * with reciprocal rank fusion.
 *
 * The Space filter lives INSIDE $vectorSearch (spaceId is a declared filter field), never in
 * a later $match — filtering afterwards returns another Space's chunks first and hides them,
 * which quietly wrecks recall.
 *
 * Re-rank: deliberately skipped. RRF over two retrievers that fail differently already
 * reaches the recall target on the gold set, and a cross-encoder would add a provider call to
 * the TTFT path of every document question. Revisit if recall@5 slips.
 */
import type { Locator } from '@lumina/contract';
import { env } from '../env.js';
import { col } from '../db.js';
import { cosine, embed } from '../providers/embed.js';
import { normalize } from '../util/text.js';

export interface ChunkHit {
  chunkId: string;
  docId: string;
  title: string;
  text: string;
  locator: Locator;
  rrf: number;
  vectorScore: number | null;
}

export interface HybridResult {
  chunks: ChunkHit[];
  /** Best cosine similarity from the dense half (not Atlas's rescaled score). */
  bestVectorScore: number;
  embedTokens: number;
  backend: string;
}

interface ChunkRow {
  _id: string;
  docId: string;
  spaceId: string;
  userId: string;
  text: string;
  locator: Locator;
  ord: number;
  embedding?: number[];
}

interface Ranked {
  _id: string;
  docId: string;
  text: string;
  locator: Locator;
  score: number;
}

export async function hybridSearch(args: {
  userId: string;
  spaceId: string;
  query: string;
  signal?: AbortSignal;
}): Promise<HybridResult> {
  const { userId, spaceId, query, signal } = args;
  const e = await embed([query], signal);
  const vector = e.vectors[0] as number[];

  let dense: Ranked[];
  let lexical: Ranked[];
  if (env.vectorBackend === 'atlas-vector-search') {
    [dense, lexical] = await Promise.all([atlasVector(spaceId, userId, vector), atlasText(spaceId, userId, query)]);
    // Atlas reports cosine similarity as (1 + cos) / 2; convert back so thresholds mean cosine.
    dense = dense.map((d) => ({ ...d, score: d.score * 2 - 1 }));
  } else {
    [dense, lexical] = await cosineScan(spaceId, userId, vector, query);
  }

  // Only documents that finished indexing are searchable; a half-ingested one is not an answer.
  const docIds = [...new Set([...dense, ...lexical].map((c) => c.docId))];
  const documents = await col<{ _id: string; title: string; status: string }>('documents');
  const docs = await documents.find({ _id: { $in: docIds }, spaceId, userId, status: 'indexed' }).project<{ _id: string; title: string }>({ title: 1 }).toArray();
  const titles = new Map(docs.map((d) => [d._id, d.title]));

  const fused = new Map<string, ChunkHit>();
  const add = (list: Ranked[], dense: boolean) => {
    list.forEach((c, i) => {
      const title = titles.get(c.docId);
      if (!title) return;
      const prev = fused.get(c._id);
      const inc = 1 / (env.ragRrfK + i + 1);
      if (prev) {
        prev.rrf += inc;
        if (dense) prev.vectorScore = c.score;
      } else {
        fused.set(c._id, {
          chunkId: c._id,
          docId: c.docId,
          title,
          text: c.text,
          locator: c.locator,
          rrf: inc,
          vectorScore: dense ? c.score : null
        });
      }
    });
  };
  add(dense, true);
  add(lexical, false);

  const chunks = [...fused.values()].sort((a, b) => b.rrf - a.rrf);
  const bestVectorScore = dense.filter((d) => titles.has(d.docId)).reduce((m, d) => Math.max(m, d.score), 0);
  return { chunks, bestVectorScore, embedTokens: e.tokens, backend: env.vectorBackend };
}

async function atlasVector(spaceId: string, userId: string, vector: number[]): Promise<Ranked[]> {
  const chunks = await col<ChunkRow>('chunks');
  return chunks
    .aggregate<Ranked>([
      {
        $vectorSearch: {
          index: 'chunks_vector',
          path: 'embedding',
          queryVector: vector,
          numCandidates: env.ragNumCandidates,
          limit: env.ragCandidates,
          filter: { spaceId, userId }
        }
      },
      { $project: { _id: 1, docId: 1, text: 1, locator: 1, score: { $meta: 'vectorSearchScore' } } }
    ])
    .toArray();
}

async function atlasText(spaceId: string, userId: string, query: string): Promise<Ranked[]> {
  const chunks = await col<ChunkRow>('chunks');
  return chunks
    .aggregate<Ranked>([
      {
        $search: {
          index: 'chunks_text',
          compound: {
            must: [{ text: { query: query.slice(0, 500), path: 'text' } }],
            filter: [
              { equals: { path: 'spaceId', value: spaceId } },
              { equals: { path: 'userId', value: userId } }
            ]
          }
        }
      },
      { $limit: env.ragCandidates },
      { $project: { _id: 1, docId: 1, text: 1, locator: 1, score: { $meta: 'searchScore' } } }
    ])
    .toArray();
}

/**
 * Local-dev fallback for a plain mongod with no Atlas Search: exact cosine over the Space's
 * chunks plus a small in-process BM25. Fine to a few thousand chunks. /health says it is live.
 */
async function cosineScan(spaceId: string, userId: string, vector: number[], query: string): Promise<[Ranked[], Ranked[]]> {
  const chunks = await col<ChunkRow>('chunks');
  const rows = await chunks.find({ spaceId, userId, embedding: { $exists: true } }).limit(5000).toArray();

  const dense = rows
    .map((r) => ({ _id: r._id, docId: r.docId, text: r.text, locator: r.locator, score: cosine(vector, r.embedding ?? []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, env.ragCandidates);

  const terms = normalize(query).split(' ').filter((t) => t.length > 1);
  const docsTokens = rows.map((r) => normalize(r.text).split(' '));
  const avgLen = docsTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, docsTokens.length);
  const df = new Map<string, number>();
  for (const toks of docsTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = rows.length;
  const k1 = 1.2;
  const b = 0.75;
  const lexical = rows
    .map((r, i) => {
      const toks = docsTokens[i] as string[];
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const q of terms) {
        const f = tf.get(q) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgLen));
      }
      return { _id: r._id, docId: r.docId, text: r.text, locator: r.locator, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, env.ragCandidates);

  return [dense, lexical];
}
