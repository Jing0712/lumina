import type { NextFunction, Request, Response } from 'express';
import { USER_HEADER } from '@lumina/contract';
import { env } from './env.js';

/**
 * Per-user, per-minute fixed windows: one for asks (the expensive route), a wider one for
 * everything else (listing, polling an upload's status). In-process, so it is per gateway
 * instance — fine for one instance; a fleet would move this to a shared store.
 */
const windows = new Map<string, { start: number; count: number }>();

setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, w] of windows) if (w.start < cutoff) windows.delete(k);
}, 60_000).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const user = (req.header(USER_HEADER) ?? '').trim();
  if (!user) return next();
  const isAsk = req.method === 'POST' && /\/ask$/.test(req.path);
  const limit = isAsk ? env.rateLimitPerMinute : env.rateLimitPerMinute * env.rateLimitOtherMultiplier;
  const key = `${user}:${isAsk ? 'ask' : 'other'}`;
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    return next();
  }
  if (w.count >= limit) {
    const retry = Math.ceil((w.start + 60_000 - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    res.status(429).json({
      error: `rate limit: ${limit} ${isAsk ? 'asks' : 'requests'} per minute per user; retry in ${retry}s`,
      status: 429,
      requestId: String(res.locals.requestId)
    });
    return;
  }
  w.count++;
  next();
}
