/**
 * LUMINA agent service — the AI backend. Provider keys live only in this process.
 *
 * Only the gateway should ever reach this service (deploy it on a private network). It
 * still enforces X-User-Id itself, and it is where the deep-search spend cap lives: a cap
 * the edge enforced could be bypassed by calling this service directly.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { HealthResponse, REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from './env.js';
import { col, pingDb } from './db.js';
import { log } from './log.js';
import { askRouter } from './routes/ask.js';
import { threadsRouter } from './routes/threads.js';
import { memoryRouter } from './routes/memory.js';
import { spacesRouter } from './routes/spaces.js';
import { statsRouter } from './routes/stats.js';
import { startWorker } from './jobs/worker.js';
import { startKeepWarm } from './util/keepWarm.js';
import { startNetTrace } from './util/netTrace.js';

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST' ? next() : express.json({ limit: '1mb' })(req, res, next)
);

mkdirSync(env.runsDir, { recursive: true });
if (process.env.NET_TRACE === '1') startNetTrace(env.runsDir);

// ---- request id: reuse the gateway's, so one id greps across both logs
app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? '').trim() || `req_${randomUUID().slice(0, 12)}`;
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

// ---- /health (no user header needed)
app.get('/health', async (_req, res) => {
  const dbStatus = await pingDb();
  const body: HealthResponse = {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel === env.llmModelDeep ? env.llmModel : `${env.llmModel} (deep: ${env.llmModelDeep})`,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' },
    version: '1.0.0'
  };
  res.status(dbStatus === 'ok' ? 200 : 503).json(body);
});

// ---- identity: required here too (defence in depth; the gateway checks first)
app.use((req, res, next) => {
  const userId = (req.header(USER_HEADER) ?? '').trim();
  if (!userId) {
    res.status(401).json({ error: 'X-User-Id header is required', status: 401, requestId: res.locals.requestId });
    return;
  }
  res.locals.userId = userId.slice(0, 128);
  next();
});

// ---- one `requests` row per non-ask request (the ask route writes its own, richer one)
app.use((req, res, next) => {
  if (/\/ask$/.test(req.path)) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    col('requests')
      .then((c) =>
        c.insertOne({
          requestId: res.locals.requestId,
          userId: res.locals.userId,
          route: `${req.method} ${req.route?.path ?? req.path}`,
          status: res.statusCode,
          ms: Date.now() - t0,
          createdAt: new Date()
        })
      )
      .catch((err: Error) => log.warn({ err: err.message }, 'could not record request'));
  });
  next();
});

app.use(askRouter);
app.use(threadsRouter);
app.use(memoryRouter);
app.use(spacesRouter);
app.use(statsRouter);

app.use((req, res) => res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404, requestId: res.locals.requestId }));

// A thrown error is a 502 with a log line, never a 200 with a plausible body (rule A1).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ requestId: res.locals.requestId, err: err.message, stack: err.stack }, 'agent error');
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(502).json({ error: err.message || 'upstream failure', status: 502, requestId: res.locals.requestId });
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
});

const server = app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      deepModel: env.llmModelDeep,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      },
      embeddedWorker: env.embeddedWorker
    },
    'agent up'
  );
  if (env.embeddedWorker) startWorker();
  if (process.env.KEEP_WARM !== 'off') startKeepWarm();
});
// Keep idle upstream sockets open longer than any client pool keeps them (undici: 4s), so a
// reused keep-alive connection is never closed under an in-flight request.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
