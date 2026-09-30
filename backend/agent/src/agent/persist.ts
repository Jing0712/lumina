/**
 * After an answer: the run log (file + `runs` collection), the `requests` row /stats reads,
 * and one pino line. All three are built from the same RunCtx, so they reconcile.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoneEvent, RunLog, Terminated } from '@lumina/contract';
import { env } from '../env.js';
import { col } from '../db.js';
import { log } from '../log.js';
import type { RunCtx } from './context.js';

export function runLogOf(ctx: RunCtx, terminated: Terminated): RunLog {
  const toolCalls = [...ctx.toolCalls]
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ name: t.name, ok: t.ok, ...(t.ok ? {} : { error: t.error ?? 'failed' }), ms: t.ms }));
  return {
    tokens: ctx.tokensIn + ctx.tokensOut,
    wallClockSec: Number((ctx.elapsedMs() / 1000).toFixed(2)),
    costUsd: ctx.costUsd,
    terminated,
    depth: ctx.init.depth,
    toolCalls
  };
}

export async function persistRun(
  ctx: RunCtx,
  terminated: Terminated,
  done: DoneEvent | null,
  status: number,
  errorMessage?: string
): Promise<void> {
  const { requestId, userId, threadId, answerId, query, depth } = ctx.init;
  const runLog = runLogOf(ctx, terminated);
  const now = new Date();

  // A request the browser abandoned is not an answer: it gets a request row and a log line,
  // but no run log (the gates grade answers).
  const abandoned = status === 499;

  // 1. The file the gates read. Written first and synchronously: it is the evidence.
  if (!abandoned) {
    try {
      mkdirSync(env.runsDir, { recursive: true });
      writeFileSync(join(env.runsDir, `${safe(requestId)}.json`), JSON.stringify(runLog, null, 2));
    } catch (err) {
      log.error({ requestId, err: (err as Error).message }, 'could not write run log file');
    }
  }

  // 2. The same log in Mongo (a deployed instance's disk is ephemeral; export-runs reads this).
  // 3. The request row behind /stats.
  try {
    const [runs, requests] = await Promise.all([col('runs'), col('requests')]);
    await Promise.all([
      abandoned
        ? Promise.resolve()
        : runs.updateOne(
            { requestId },
            { $set: { ...runLog, requestId, userId, threadId, answerId, query, createdAt: now } },
            { upsert: true }
          ),
      requests.insertOne({
        requestId,
        userId,
        route: 'POST /threads/:threadId/ask',
        status,
        ms: ctx.elapsedMs(),
        tokensIn: ctx.tokensIn,
        tokensOut: ctx.tokensOut,
        costUsd: ctx.costUsd,
        toolCalls: ctx.toolCalls.length,
        terminated,
        depth,
        ttftMs: done?.ttftMs ?? null,
        searchCached: ctx.searchCached,
        searches: ctx.searches,
        answer: true,
        createdAt: now
      })
    ]);
  } catch (err) {
    log.error({ requestId, err: (err as Error).message }, 'could not persist run/request rows');
  }

  // 4. One line per answer, the fields SPEC 10 names.
  log.info(
    {
      requestId,
      userId,
      threadId,
      depth,
      toolCalls: ctx.toolCalls.length,
      terminated,
      tokens: { in: ctx.tokensIn, out: ctx.tokensOut },
      costUsd: ctx.costUsd,
      searchCached: ctx.searchCached,
      ttftMs: done?.ttftMs ?? null,
      latencyMs: done?.latencyMs ?? ctx.elapsedMs(),
      sources: ctx.sources.length,
      marks: ctx.marks,
      ...(errorMessage ? { error: errorMessage } : {})
    },
    'answer'
  );
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
