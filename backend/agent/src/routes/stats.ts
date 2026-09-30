/**
 * GET /stats — read out of the same `requests` and `runs` rows the per-answer log line is
 * written from, so the numbers reconcile with the log.
 */
import { asyncRouter } from '../util/asyncRouter.js';
import { env } from '../env.js';
import { col } from '../db.js';
import { deepUsedToday } from '../agent/usage.js';

export const statsRouter = asyncRouter();

statsRouter.get('/stats', async (_req, res) => {
  const userId = res.locals.userId as string;
  const startOfDay = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const [requests, runs] = await Promise.all([col('requests'), col('runs')]);

  const [requestCount, answers, recentAnswers, costToday, deepToday] = await Promise.all([
    requests.countDocuments({}),
    runs.countDocuments({}),
    requests
      .find({ answer: true, status: 200 })
      .sort({ createdAt: -1 })
      .limit(1000)
      .project<{ ttftMs?: number | null; searchCached?: boolean; searches?: number; depth?: string }>({
        ttftMs: 1,
        searchCached: 1,
        searches: 1,
        depth: 1
      })
      .toArray(),
    runs.aggregate<{ total: number }>([{ $match: { createdAt: { $gte: startOfDay } } }, { $group: { _id: null, total: { $sum: '$costUsd' } } }]).toArray(),
    deepUsedToday(userId)
  ]);

  const searched = recentAnswers.filter((a) => (a.searches ?? 0) > 0);
  const hitRate = searched.length ? (100 * searched.filter((a) => a.searchCached).length) / searched.length : 0;
  const ttfts = recentAnswers
    .filter((a) => a.depth !== 'deep' && typeof a.ttftMs === 'number')
    .map((a) => a.ttftMs as number)
    .sort((a, b) => a - b);
  const p95 = ttfts.length ? (ttfts[Math.min(ttfts.length - 1, Math.max(0, Math.ceil(0.95 * ttfts.length) - 1))] as number) : 0;

  res.json({
    requests: requestCount,
    answers,
    searchCacheHitRatePct: Number(hitRate.toFixed(1)),
    ttftP95Ms: Math.round(p95),
    costUsdToday: Number((costToday[0]?.total ?? 0).toFixed(6)),
    deepToday,
    deepDailyCap: env.deepDailyCap
  });
});
