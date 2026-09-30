/**
 * fetch() to the agent over node:http with a dedicated keep-alive pool.
 *
 * Why not the global fetch: deployed on Fly, the global fetch pool sent concurrent asks to the
 * agent one at a time (agent logs: each answer began only when the previous one ended, so at
 * concurrency 4 TTFT climbed 3 s → 20 s while every answer took ~2 s inside the agent). The
 * agent service had the same symptom towards its LLM provider and the same cure: our own
 * http.Agent with many sockets.
 *
 * Returns a standard web Response, so callers stream `.body` exactly as before.
 */
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 })
};

export interface AgentFetchInit {
  method: string;
  headers: Record<string, string>;
  /** A string, or a Node stream piped through untouched (the multipart upload). */
  body?: string | NodeJS.ReadableStream;
  signal?: AbortSignal;
}

export function agentFetch(url: string, init: AgentFetchInit): Promise<Response> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) return reject(init.signal.reason ?? new Error('aborted'));
    const headers: Record<string, string> = { ...init.headers };
    if (typeof init.body === 'string') headers['content-length'] = String(Buffer.byteLength(init.body));
    const req = mod.request(u, { method: init.method, headers, agent: agents[u.protocol === 'https:' ? 'https:' : 'http:'] }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
        else if (v !== undefined) h.set(k, v);
      }
      const status = res.statusCode ?? 502;
      const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers: h }));
    });
    const onAbort = () => req.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    req.on('error', reject);
    if (init.body === undefined) req.end();
    else if (typeof init.body === 'string') req.end(init.body);
    else init.body.pipe(req);
  });
}
