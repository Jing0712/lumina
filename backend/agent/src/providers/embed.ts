import { EMBEDDING_DIMS } from '@lumina/contract';
import { env, secrets } from '../env.js';
import { ProviderError } from './llm.js';
import { nodeFetch } from '../util/httpFetch.js';

export interface Embedded {
  vectors: number[][];
  tokens: number;
}

/** OpenAI embeddings over fetch. Batches; throws on any failure (no zero vectors, ever). */
export async function embed(inputs: string[], signal?: AbortSignal): Promise<Embedded> {
  if (!inputs.length) return { vectors: [], tokens: 0 };
  if (!secrets.openai) throw new ProviderError('openai', 'OPENAI_API_KEY is not set');

  const vectors: number[][] = [];
  let tokens = 0;
  const BATCH = 96;

  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH).map((s) => s.slice(0, 24000) || ' ');
    let res: Response;
    try {
      res = await nodeFetch(`${env.openaiBaseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.openai}` },
        body: JSON.stringify({ model: env.embeddingModel, input: batch }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ProviderError('openai', `embeddings request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError('openai', `embeddings ${res.status} ${text.slice(0, 200)}`, res.status);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const d of sorted) {
      if (d.embedding.length !== EMBEDDING_DIMS) {
        throw new ProviderError('openai', `embedding has ${d.embedding.length} dims, the index expects ${EMBEDDING_DIMS}`);
      }
      vectors.push(d.embedding);
    }
    tokens += json.usage?.total_tokens ?? 0;
  }
  return { vectors, tokens };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
