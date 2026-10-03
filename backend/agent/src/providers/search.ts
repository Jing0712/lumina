/**
 * web_search: Tavily or SerpApi, chosen by SEARCH_PROVIDER with no code change, behind a
 * two-tier cache (in-process LRU → Mongo `searchCache` with a TTL index).
 *
 * Key = sha256(normalized query, provider). A provider failure throws: an empty result list
 * means "the web had nothing", never "the provider was down".
 */
import { createHash } from 'node:crypto';
import { env, secrets } from '../env.js';
import { col } from '../db.js';
import { log } from '../log.js';
import { Lru } from '../util/lru.js';
import { isTimeSensitive } from '../util/text.js';
import { ProviderError } from './llm.js';
import { nodeFetch } from '../util/httpFetch.js';

export interface SearchResult {
  title: string;
  url: string;
  /** The provider's snippet. Never cited on its own. */
  content: string;
  /** Full page text when the provider extracted it (Tavily), else null. */
  rawContent: string | null;
}

export interface SearchOutcome {
  results: SearchResult[];
  cached: boolean;
  /** Which tier answered: memory, mongo, or the provider itself. */
  tier: 'lru' | 'mongo' | 'provider';
  bypassedCache: boolean;
}

const lru = new Lru<SearchResult[]>(500, env.searchCacheTtlSeconds * 1000);

export const normalizeQuery = (q: string): string =>
  q.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!\s]+$/, '').trim();

export const cacheKey = (q: string, provider: string): string =>
  createHash('sha256').update(`${normalizeQuery(q)}\u0000${provider}`).digest('hex');

interface CacheRow {
  _id: string;
  provider: 'tavily' | 'serpapi';
  query: string;
  results: SearchResult[];
  expiresAt: Date;
  createdAt: Date;
}

export async function searchWeb(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const provider = env.searchProvider;
  const key = cacheKey(query, provider);
  const bypass = isTimeSensitive(query);

  if (!bypass) {
    const hit = lru.get(key);
    if (hit) return { results: hit, cached: true, tier: 'lru', bypassedCache: false };
    try {
      const cache = await col<CacheRow>('searchCache');
      const row = await cache.findOne({ _id: key, expiresAt: { $gt: new Date() } });
      if (row) {
        const ttl = row.expiresAt.getTime() - Date.now();
        lru.set(key, row.results, ttl);
        return { results: row.results, cached: true, tier: 'mongo', bypassedCache: false };
      }
    } catch (err) {
      // The cache is disposable; losing it costs latency and money, not correctness.
      log.warn({ err: (err as Error).message }, 'searchCache read failed; treating as a miss');
    }
  }

  const results = provider === 'serpapi' ? await serpapi(query, signal) : await tavily(query, signal);

  if (!bypass) {
    lru.set(key, results);
    const now = new Date();
    col<CacheRow>('searchCache')
      .then((cache) =>
        cache.replaceOne(
          { _id: key },
          {
            provider,
            query: normalizeQuery(query),
            results,
            expiresAt: new Date(now.getTime() + env.searchCacheTtlSeconds * 1000),
            createdAt: now
          },
          { upsert: true }
        )
      )
      .catch((err: Error) => log.warn({ err: err.message }, 'searchCache write failed'));
  }
  return { results, cached: false, tier: 'provider', bypassedCache: bypass };
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(env.searchTimeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function tavily(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!secrets.tavily) throw new ProviderError('tavily', 'TAVILY_API_KEY is not set');
  let res: Response;
  try {
    res = await nodeFetch(`${env.tavilyBaseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.tavily}` },
      body: JSON.stringify({
        query: query.slice(0, 400),
        max_results: env.searchResults,
        search_depth: env.searchDepth,
        include_answer: false,
        include_raw_content: 'text'
      }),
      signal: withTimeout(signal)
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProviderError('tavily', `request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError('tavily', `${res.status} ${text.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string; raw_content?: string | null }[];
  };
  return (json.results ?? [])
    .filter((r) => r.url && /^https?:\/\//.test(r.url))
    .map((r) => ({
      title: (r.title || r.url || 'untitled').slice(0, 300),
      url: r.url as string,
      content: (r.content ?? '').slice(0, 1000),
      rawContent: r.raw_content ? r.raw_content.slice(0, 20000) : null
    }));
}

async function serpapi(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  if (!secrets.serpapi) throw new ProviderError('serpapi', 'SERPAPI_API_KEY is not set');
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query.slice(0, 400));
  url.searchParams.set('num', String(env.searchResults));
  url.searchParams.set('api_key', secrets.serpapi);
  let res: Response;
  try {
    res = await fetch(url, { signal: withTimeout(signal) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProviderError('serpapi', `request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError('serpapi', `${res.status} ${text.slice(0, 200)}`, res.status);
  }
  const json = (await res.json()) as {
    error?: string;
    organic_results?: { title?: string; link?: string; snippet?: string }[];
  };
  if (json.error && !/hasn't returned any results/i.test(json.error)) {
    throw new ProviderError('serpapi', json.error);
  }
  return (json.organic_results ?? [])
    .filter((r) => r.link && /^https?:\/\//.test(r.link))
    .slice(0, env.searchResults)
    .map((r) => ({
      title: (r.title || r.link || 'untitled').slice(0, 300),
      url: r.link as string,
      content: (r.snippet ?? '').slice(0, 1000),
      rawContent: null
    }));
}
