/**
 * The gateway → agent hop. Three shapes: JSON routes, the multipart upload (streamed through
 * untouched), and the SSE answer stream (passed through frame by frame, flushed, never
 * buffered, and cancelled upstream when the browser goes away).
 *
 * If the agent is unreachable or fails, the browser gets a 502 — never a 2xx.
 */
import type { Request, Response } from 'express';
import { MAX_UPLOAD_BYTES, REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { log } from './log.js';
import { sseHeaders, sseSend } from './sse.js';

function upstreamHeaders(req: Request, res: Response, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [USER_HEADER]: (req.header(USER_HEADER) ?? '').trim(),
    [REQUEST_HEADER]: String(res.locals.requestId),
    ...extra
  };
}

function badGateway(res: Response, err: unknown, what: string): void {
  const message = `${what}: ${(err as Error)?.message ?? String(err)}`;
  log.error({ requestId: res.locals.requestId, err: message }, 'upstream failure');
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(502).json({ error: message, status: 502, requestId: String(res.locals.requestId) });
}

async function relay(upstream: globalThis.Response, res: Response): Promise<void> {
  res.status(upstream.status);
  if (upstream.status === 204) {
    res.end();
    return;
  }
  const type = upstream.headers.get('content-type');
  if (type) res.setHeader('content-type', type);
  const retry = upstream.headers.get('retry-after');
  if (retry) res.setHeader('retry-after', retry);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

/** Plain JSON routes. */
export async function proxyJson(req: Request, res: Response): Promise<void> {
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers: upstreamHeaders(req, res, hasBody ? { 'content-type': 'application/json' } : {}),
      ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      signal: AbortSignal.timeout(env.upstreamTimeoutMs)
    });
  } catch (err) {
    return badGateway(res, err, 'agent service unreachable');
  }
  await relay(upstream, res);
}

/** Multipart upload: stream the body straight through; the agent owns parsing it. */
export async function proxyUpload(req: Request, res: Response): Promise<void> {
  const length = Number(req.header('content-length') ?? 0);
  if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
    res.status(413).json({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)`, status: 413, requestId: String(res.locals.requestId) });
    return;
  }
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: upstreamHeaders(req, res, {
        'content-type': req.header('content-type') ?? 'application/octet-stream',
        ...(length ? { 'content-length': String(length) } : {})
      }),
      body: req as unknown as NonNullable<RequestInit['body']>,
      duplex: 'half',
      signal: AbortSignal.timeout(Math.max(env.upstreamTimeoutMs, 120000))
    } as RequestInit & { duplex: 'half' });
  } catch (err) {
    return badGateway(res, err, 'agent service unreachable');
  }
  await relay(upstream, res);
}

/** The answer stream. */
export async function proxyAsk(req: Request, res: Response): Promise<void> {
  const cancel = new AbortController();
  res.on('close', () => {
    // The browser left: stop the agent too, or it keeps spending on an answer nobody reads.
    if (!res.writableFinished) cancel.abort();
  });

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: upstreamHeaders(req, res, { 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify(req.body ?? {}),
      signal: cancel.signal
    });
  } catch (err) {
    if (cancel.signal.aborted) return;
    return badGateway(res, err, 'agent service unreachable');
  }

  const type = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !type.includes('text/event-stream') || !upstream.body) {
    // 400 / 404 / 429 (deep cap) / 502 before the stream opened: pass status and body through.
    await relay(upstream, res);
    return;
  }

  sseHeaders(res);
  res.socket?.setNoDelay(true);
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      const flush = (res as unknown as { flush?: () => void }).flush;
      if (typeof flush === 'function') flush.call(res);
    }
  } catch (err) {
    if (!cancel.signal.aborted && !res.writableEnded) {
      // The agent died mid-answer: say so on the stream rather than just stopping.
      log.error({ requestId: res.locals.requestId, err: (err as Error).message }, 'agent stream interrupted');
      sseSend(res, 'error', { status: 502, error: `agent stream interrupted: ${(err as Error).message}` });
    }
  }
  if (!res.writableEnded) res.end();
}
