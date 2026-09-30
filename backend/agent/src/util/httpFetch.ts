/**
 * A minimal fetch() over node:https with our own keep-alive agent, for the LLM provider.
 *
 * Why: under load, the agent's global fetch pool kept api.anthropic.com on ONE socket, so
 * concurrent answers waited for each other (NET_TRACE showed request N+1 sent only when
 * request N's stream ended: TTFT 3s → 13s at concurrency 4). A dedicated agent with many
 * sockets makes concurrent LLM calls actually concurrent.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const agents = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 120_000 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 120_000 })
};

export interface NodeFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export function nodeFetch(url: string, init: NodeFetchInit): Promise<Response> {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  const body = Buffer.from(init.body, 'utf8');
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) return reject(init.signal.reason ?? new Error('aborted'));
    const req = mod.request(
      u,
      {
        method: init.method,
        agent: agents[u.protocol as 'https:' | 'http:'],
        headers: { ...init.headers, 'content-length': String(body.length) }
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 500;
        const stream = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(status === 204 || status === 304 ? null : stream, { status, headers }));
      }
    );
    const onAbort = () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    req.on('error', reject);
    req.end(body);
  });
}
