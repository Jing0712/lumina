/**
 * Keep one pooled TLS connection to each provider (and the Mongo pool) warm.
 *
 * Why: the first answer after a deploy or an idle spell paid for DNS + TCP + TLS to the search
 * provider and the LLM inside its TTFT (measured: web_search 2.0 s cold vs ~0.7 s warm, TTFT
 * 2.98 s on the first smoke query, over the 2.5 s target; the same query warm is ~1.3 s). The
 * smoke gate is five sequential queries, so its p95 is its slowest one: one cold start fails it.
 *
 * A ping is an unauthenticated GET that spends no tokens and no search credits. It is not a
 * provider call in the fail-loud sense: nothing reads its result, and a failed ping is only
 * logged at debug level. The real call that follows still fails loud on its own.
 */
import { env } from '../env.js';
import { pingDb } from '../db.js';
import { log } from '../log.js';
import { nodeFetch } from './httpFetch.js';

const INTERVAL_MS = 30_000;

async function ping(url: string): Promise<void> {
  try {
    const res = await nodeFetch(url, { method: 'GET', headers: {}, body: '', signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer().catch(() => undefined); // drain, so the socket returns to the pool
  } catch (err) {
    log.debug({ url, err: (err as Error).message }, 'keep-warm ping failed');
  }
}

export function startKeepWarm(): void {
  const targets = [env.anthropicBaseUrl, env.openaiBaseUrl, ...(env.searchProvider === 'tavily' ? [env.tavilyBaseUrl] : [])];
  const tick = () => {
    for (const t of targets) void ping(`${t}/`);
    void pingDb().catch(() => undefined);
  };
  tick();
  setInterval(tick, INTERVAL_MS).unref();
}
