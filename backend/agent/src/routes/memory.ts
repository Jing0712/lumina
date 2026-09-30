/**
 * Long-term memory, visible and deletable. Nothing is remembered that GET /memory does not
 * show: recall reads the same collection this lists, and DELETE removes the row (and its
 * embedding with it), so the effect disappears with it.
 */
import { asyncRouter } from '../util/asyncRouter.js';
import { col } from '../db.js';

export const memoryRouter = asyncRouter();

interface MemoryRow {
  _id: string;
  userId: string;
  text: string;
  sourceThread?: string;
  createdAt: Date;
}

memoryRouter.get('/memory', async (_req, res) => {
  const memories = await col<MemoryRow>('memories');
  const rows = await memories
    .find({ userId: res.locals.userId as string })
    .project<Omit<MemoryRow, 'userId'>>({ embedding: 0, userId: 0 })
    .sort({ createdAt: -1 })
    .limit(500)
    .toArray();
  res.json({
    memories: rows.map((m) => ({
      id: m._id,
      text: m.text,
      ...(m.sourceThread ? { sourceThread: m.sourceThread } : {}),
      createdAt: (m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt)).toISOString()
    }))
  });
});

memoryRouter.delete('/memory/:memoryId', async (req, res) => {
  const memories = await col<MemoryRow>('memories');
  const r = await memories.deleteOne({ _id: req.params.memoryId, userId: res.locals.userId as string });
  if (!r.deletedCount) {
    res.status(404).json({ error: `no memory ${req.params.memoryId}`, status: 404, requestId: res.locals.requestId });
    return;
  }
  res.status(204).end();
});
