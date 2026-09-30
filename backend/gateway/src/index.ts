/**
 * LUMINA gateway — the only service the browser talks to. It holds no provider key and
 * makes no AI decision. Its whole job is the edge:
 *
 *   CORS · request id · one log line per request · X-User-Id (401) · zod validation from the
 *   contract (400) · per-user rate limit (429) · proxy to the agent (502 when it fails) ·
 *   SSE pass-through without buffering · serve web/dist · serve the eval report.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ZodTypeAny } from 'zod';
import { AskBody, CreateSpaceBody, CreateThreadBody, HealthResponse, REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { log } from './log.js';
import { rateLimit } from './rateLimit.js';
import { proxyAsk, proxyJson, proxyUpload } from './proxy.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

// One request id, reused if the caller sent one, generated if not, forwarded to the agent
// service and logged by both. This is what makes one request greppable end to end.
app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? '').trim() || `req_${randomUUID().slice(0, 12)}`;
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

// One JSON line per request: method, route, status, ms, requestId, userId.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('close', () => {
    log.info(
      {
        method: req.method,
        route: req.route?.path ? String(req.route.path) : req.path,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - t0,
        requestId: res.locals.requestId,
        userId: req.header(USER_HEADER) || null,
        aborted: !res.writableFinished
      },
      'request'
    );
  });
  next();
});

// JSON everywhere except the multipart upload, which is streamed through untouched.
app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST' ? next() : express.json({ limit: '1mb' })(req, res, next)
);

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

// ---------------------------------------------------------------- /health (no auth)

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await upstream.json()) as Record<string, unknown>;
    ai = { ...body, status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    // Health tells the truth about a dead dependency. It never pretends.
    ai = { status: 'down', error: (err as Error).message };
  }
  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(ai.model ?? 'unset'),
    searchProvider: String(ai.searchProvider ?? 'unknown'),
    vectorStore: String(ai.vectorStore ?? 'unknown'),
    db: (ai.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- /evals/report.json (no auth)

// The grader's tooling pulls this with no header. It is the eval skill's output, verbatim.
app.get(
  '/evals/report.json',
  handle(async (_req, res) => {
    if (!existsSync(env.reportPath)) {
      res.status(404).json({ error: 'no report yet — run /fde-lumina-eval against this deployment', status: 404, requestId: String(res.locals.requestId) });
      return;
    }
    res.setHeader('cache-control', 'no-cache');
    res.type('application/json').send(await readFile(env.reportPath, 'utf8'));
  })
);

// ---------------------------------------------------------------- the API: auth → limit → validate → proxy

const API = /^\/(threads|memory|spaces|stats)(\/|$)/;

app.use((req, res, next) => {
  if (!API.test(req.path)) return next();
  if (!(req.header(USER_HEADER) ?? '').trim()) {
    res.status(401).json({ error: 'X-User-Id header is required', status: 401, requestId: String(res.locals.requestId) });
    return;
  }
  rateLimit(req, res, next);
});

const validate =
  (schema: ZodTypeAny) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      res.status(400).json({ error: msg, status: 400, requestId: String(res.locals.requestId) });
      return;
    }
    req.body = parsed.data;
    next();
  };

app.post('/threads/:threadId/ask', validate(AskBody), handle(proxyAsk));
app.post('/threads', validate(CreateThreadBody), handle(proxyJson));
app.get('/threads', handle(proxyJson));
app.get('/threads/:threadId', handle(proxyJson));
app.get('/memory', handle(proxyJson));
app.delete('/memory/:memoryId', handle(proxyJson));
app.post('/spaces', validate(CreateSpaceBody), handle(proxyJson));
app.get('/spaces', handle(proxyJson));
app.post('/spaces/:spaceId/documents', handle(proxyUpload));
app.get('/spaces/:spaceId/documents', handle(proxyJson));
app.get('/stats', handle(proxyJson));

// ---------------------------------------------------------------- static UI

// In production the gateway can serve the built UI too, so / and /evals come from one origin.
if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|evals\/report\.json)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404, requestId: String(res.locals.requestId) });
});

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'body is not valid JSON', status: 400, requestId: String(res.locals.requestId) });
    return;
  }
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'body too large', status: 413, requestId: String(res.locals.requestId) });
    return;
  }
  log.error({ err: err.message, requestId: res.locals.requestId }, 'gateway error');
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(502).json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
});

app.listen(env.port, () => {
  log.info({ port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins, rateLimitPerMinute: env.rateLimitPerMinute }, 'gateway up');
});
