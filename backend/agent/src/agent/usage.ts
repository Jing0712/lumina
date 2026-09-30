/**
 * The deep-search spend gate: DEEP_DAILY_CAP per X-User-Id per UTC day, enforced HERE in the
 * agent service, next to the spending. A cap on the gateway could be bypassed by calling
 * this service directly.
 *
 * One Mongo document per user per day, claimed with a single conditional upsert, so the
 * count is right across restarts and across several agent instances.
 */
import { env } from '../env.js';
import { col } from '../db.js';

interface UsageRow {
  _id: string;
  userId: string;
  day: string;
  deep: number;
  createdAt: Date;
}

const today = () => new Date().toISOString().slice(0, 10);

export function nextUtcMidnight(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

export async function claimDeepSearch(userId: string): Promise<{ ok: true; used: number } | { ok: false; resetsAt: string }> {
  const day = today();
  const usage = await col<UsageRow>('usage');
  try {
    const row = await usage.findOneAndUpdate(
      { _id: `${userId}:${day}`, deep: { $lt: env.deepDailyCap } },
      { $inc: { deep: 1 }, $setOnInsert: { userId, day, createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' }
    );
    if (!row) return { ok: false, resetsAt: nextUtcMidnight() };
    return { ok: true, used: row.deep };
  } catch (err) {
    // The document exists but is at the cap: the conditional upsert collides on _id.
    if ((err as { code?: number }).code === 11000) return { ok: false, resetsAt: nextUtcMidnight() };
    throw err;
  }
}

export async function deepUsedToday(userId: string): Promise<number> {
  const usage = await col<UsageRow>('usage');
  const row = await usage.findOne({ _id: `${userId}:${today()}` });
  return row?.deep ?? 0;
}
