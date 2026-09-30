/**
 * Dev-only network trace (NET_TRACE=1): every outbound fetch's lifecycle — created, socket
 * connected, headers sent, body sent, response headers — appended to runs/net-trace.log.
 * Answers "was the request sent late, or did the provider answer late?".
 */
import { subscribe } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function startNetTrace(dir: string): void {
  const file = join(dir, 'net-trace.log');
  const ids = new WeakMap<object, { id: number; t0: number; origin: string }>();
  let seq = 0;
  let inflight = 0;
  const line = (s: string) => appendFileSync(file, `${new Date().toISOString().slice(11, 23)} ${s}\n`);
  const tag = (req: { origin?: string; path?: string }) => ids.get(req as object);
  subscribe('undici:request:create', (m) => {
    const req = (m as { request: { origin?: string; path?: string } }).request;
    const t = { id: ++seq, t0: Date.now(), origin: String(req.origin ?? '') };
    ids.set(req as object, t);
    inflight++;
    line(`#${t.id} create ${t.origin}${req.path ?? ''} inflight=${inflight}`);
  });
  subscribe('undici:client:connected', (m) => {
    const p = (m as { connectParams?: { host?: string } }).connectParams;
    line(`   connected new socket ${p?.host ?? '?'}`);
  });
  subscribe('undici:client:sendHeaders', (m) => {
    const t = tag((m as { request: object }).request as never);
    if (t) line(`#${t.id} sentHeaders +${Date.now() - t.t0}ms ${t.origin}`);
  });
  subscribe('undici:request:bodySent', (m) => {
    const t = tag((m as { request: object }).request as never);
    if (t) line(`#${t.id} bodySent +${Date.now() - t.t0}ms ${t.origin}`);
  });
  subscribe('undici:request:headers', (m) => {
    const t = tag((m as { request: object }).request as never);
    if (t) line(`#${t.id} RESPONSE headers +${Date.now() - t.t0}ms ${t.origin} status=${(m as { response?: { statusCode?: number } }).response?.statusCode}`);
  });
  const end = (label: string) => (m: unknown) => {
    const t = tag((m as { request: object }).request as never);
    inflight = Math.max(0, inflight - 1);
    if (t) line(`#${t.id} ${label} +${Date.now() - t.t0}ms ${t.origin} inflight=${inflight}`);
  };
  subscribe('undici:request:trailers', end('end'));
  subscribe('undici:request:error', end('error'));
  line('---- trace started');
}
