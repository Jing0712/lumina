/**
 * The gateway → agent hop. Three shapes: JSON routes, the multipart upload (streamed through
 * untouched), and the SSE answer stream (passed through frame by frame, flushed, never
 * buffered, and cancelled upstream when the browser goes away).
 *
 * If the agent is unreachable or fails, the browser gets a 502 — never a 2xx.
 */
import type { Request, Response } from 'express';
import {
  CreateSpaceResponse, CreateThreadResponse, ErrorBody, GetThreadResponse,
  ListDocumentsResponse, ListMemoryResponse, ListSpacesResponse, ListThreadsResponse,
  MAX_UPLOAD_BYTES, REQUEST_HEADER, StatsResponse, UploadDocumentResponse, USER_HEADER
} from '@lumina/contract';
import type { ZodTypeAny } from 'zod';
import { env } from './env.js';
import { log } from './log.js';
import { SseCompletion, sseHeaders, sseSend } from './sse.js';
import { agentFetch, type AgentFetchInit } from './agentFetch.js';

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
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(502).json({ error: message, status: 502, requestId: String(res.locals.requestId) });
}

const RESPONSES: Record<string, { status: number; schema?: ZodTypeAny }> = {
  'POST /threads': { status: 201, schema: CreateThreadResponse },
  'GET /threads': { status: 200, schema: ListThreadsResponse },
  'GET /threads/:threadId': { status: 200, schema: GetThreadResponse },
  'GET /memory': { status: 200, schema: ListMemoryResponse },
  'DELETE /memory/:memoryId': { status: 204 },
  'POST /spaces': { status: 201, schema: CreateSpaceResponse },
  'GET /spaces': { status: 200, schema: ListSpacesResponse },
  'POST /spaces/:spaceId/documents': { status: 202, schema: UploadDocumentResponse },
  'GET /spaces/:spaceId/documents': { status: 200, schema: ListDocumentsResponse },
  'GET /stats': { status: 200, schema: StatsResponse }
};
const ERROR_STATUSES = new Set([400, 401, 404, 413, 429, 501, 502]);

async function relay(upstream: globalThis.Response, req: Request, res: Response): Promise<void> {
  const contract = RESPONSES[`${req.method} ${req.route.path}`];
  if (upstream.ok && (!contract || upstream.status !== contract.status)) {
    await upstream.body?.cancel();
    throw new Error(`agent returned unexpected status ${upstream.status}`);
  }
  if (!upstream.ok && !ERROR_STATUSES.has(upstream.status)) {
    await upstream.body?.cancel();
    throw new Error(`agent returned HTTP ${upstream.status}`);
  }
  const retry = upstream.headers.get('retry-after');
  if (retry) res.setHeader('retry-after', retry);
  if (upstream.status === 204) {
    res.status(204).end();
    return;
  }
  const body = await upstream.json();
  const parsed = (upstream.ok ? contract?.schema : ErrorBody)?.safeParse(body);
  if (!parsed?.success) throw new Error('agent response does not match the API contract');
  res.status(upstream.status).json(parsed.data);
}

/**
 * Safe reads may retry one failed connection. A reset before response headers does NOT
 * prove the agent did no work: replaying a POST can create duplicate state or spend twice.
 */
const RETRYABLE = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
function causeCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code ?? '';
}
async function fetchAgent(url: string, init: AgentFetchInit): Promise<globalThis.Response> {
  try {
    return await agentFetch(url, init);
  } catch (err) {
    const code = causeCode(err);
    if (!['GET', 'HEAD'].includes(init.method) || !RETRYABLE.has(code) || init.signal?.aborted || init.body !== undefined) {
      throw withCode(err, code);
    }
    log.warn({ url, code }, 'agent connection failed before a response; retrying once');
    await new Promise((r) => setTimeout(r, 250));
    try {
      return await agentFetch(url, init);
    } catch (err2) {
      throw withCode(err2, causeCode(err2));
    }
  }
}
function withCode(err: unknown, code: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  if (code && !e.message.includes(code)) e.message = `${e.message} (${code})`;
  return e;
}

/** Cancel both headers and body on timeout or downstream disconnect, on every proxy route. */
function lifetime(req: Request, res: Response, timeoutMs: number) {
  const controller = new AbortController();
  let clientGone = false;
  const disconnect = () => {
    if (res.writableFinished) return;
    clientGone = true;
    controller.abort(new Error('client disconnected'));
  };
  res.once('close', disconnect);
  req.once('aborted', disconnect);
  const timer = setTimeout(() => controller.abort(new Error('agent request timed out')), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    clientGone: () => clientGone,
    dispose: () => {
      clearTimeout(timer);
      res.off('close', disconnect);
      req.off('aborted', disconnect);
    }
  };
}

/** Plain JSON routes. */
export async function proxyJson(req: Request, res: Response): Promise<void> {
  const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  const request = lifetime(req, res, env.upstreamTimeoutMs);
  try {
    const upstream = await fetchAgent(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers: upstreamHeaders(req, res, hasBody ? { 'content-type': 'application/json' } : {}),
      ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      signal: request.signal
    });
    await relay(upstream, req, res);
  } catch (err) {
    if (!request.clientGone()) badGateway(res, err, 'agent request failed');
  } finally {
    request.dispose();
  }
}

/** Multipart upload: stream the body straight through; the agent owns parsing it. */
export async function proxyUpload(req: Request, res: Response): Promise<void> {
  const length = Number(req.header('content-length') ?? 0);
  if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
    res.status(413).json({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)`, status: 413, requestId: String(res.locals.requestId) });
    return;
  }
  const request = lifetime(req, res, Math.max(env.upstreamTimeoutMs, 120000));
  try {
    const upstream = await fetchAgent(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: upstreamHeaders(req, res, {
        'content-type': req.header('content-type') ?? 'application/octet-stream',
        ...(length ? { 'content-length': String(length) } : {})
      }),
      body: req,
      signal: request.signal
    });
    await relay(upstream, req, res);
  } catch (err) {
    if (!request.clientGone()) badGateway(res, withCode(err, causeCode(err)), 'agent upload failed');
  } finally {
    request.dispose();
  }
}

/** The answer stream. */
export async function proxyAsk(req: Request, res: Response): Promise<void> {
  const request = lifetime(req, res, env.upstreamAskTimeoutMs);
  const completion = new SseCompletion();
  try {
    const upstream = await fetchAgent(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: upstreamHeaders(req, res, { 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify(req.body ?? {}),
      signal: request.signal
    });
    if (!upstream.ok) {
      await relay(upstream, req, res);
      return;
    }
    const type = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (upstream.status !== 200 || type !== 'text/event-stream' || !upstream.body) {
      await upstream.body?.cancel();
      throw new Error('agent ask response must be HTTP 200 text/event-stream');
    }

    sseHeaders(res);
    res.socket?.setNoDelay(true);
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        completion.push(value);
        if (request.clientGone()) return;
        if (!res.write(Buffer.from(value))) {
          // Slow clients exert backpressure; do not accumulate the entire answer in memory.
          await new Promise<void>((resolve, reject) => {
            const drained = () => { cleanup(); resolve(); };
            const aborted = () => { cleanup(); reject(request.signal.reason); };
            const cleanup = () => { res.off('drain', drained); request.signal.removeEventListener('abort', aborted); };
            res.once('drain', drained);
            request.signal.addEventListener('abort', aborted, { once: true });
            if (request.signal.aborted) aborted();
          });
        }
        const flush = (res as unknown as { flush?: () => void }).flush;
        if (typeof flush === 'function') flush.call(res);
      }
      if (!completion.terminal) throw new Error('agent stream ended without done or error');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (err) {
    if (!request.clientGone() && !res.destroyed && !res.writableEnded) {
      if (!res.headersSent) badGateway(res, err, 'agent ask failed');
      else {
        log.error({ requestId: res.locals.requestId, err: (err as Error).message }, 'agent stream interrupted');
        // Terminate a partially relayed frame before writing a complete error frame.
        if (completion.partialFrame) res.write('\n\n');
        sseSend(res, 'error', { status: 502, error: `agent stream interrupted: ${(err as Error).message}` });
      }
    }
  } finally {
    request.dispose();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}
