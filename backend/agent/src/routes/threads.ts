import { asyncRouter } from '../util/asyncRouter.js';
import { CreateThreadBody, newId, type ThreadMessage } from '@lumina/contract';
import { col } from '../db.js';

export const threadsRouter = asyncRouter();

interface ThreadRow {
  _id: string;
  userId: string;
  title: string;
  createdAt: Date;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === 'string' ? d : new Date().toISOString());

threadsRouter.post('/threads', async (req, res) => {
  const parsed = CreateThreadBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body', status: 400, requestId: res.locals.requestId });
    return;
  }
  const threadId = newId('thr');
  const threads = await col<ThreadRow>('threads');
  await threads.insertOne({
    _id: threadId,
    userId: res.locals.userId as string,
    title: parsed.data.title ?? 'New thread',
    createdAt: new Date()
  });
  res.status(201).json({ threadId });
});

threadsRouter.get('/threads', async (_req, res) => {
  const threads = await col<ThreadRow>('threads');
  const rows = await threads.find({ userId: res.locals.userId as string }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ threads: rows.map((t) => ({ threadId: t._id, title: t.title, createdAt: iso(t.createdAt) })) });
});

threadsRouter.get('/threads/:threadId', async (req, res) => {
  const userId = res.locals.userId as string;
  const threads = await col<ThreadRow>('threads');
  const thread = await threads.findOne({ _id: req.params.threadId, userId });
  if (!thread) {
    res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404, requestId: res.locals.requestId });
    return;
  }
  const messages = await (await col('messages')).find({ threadId: thread._id, userId }).sort({ createdAt: 1 }).toArray();
  const out: (ThreadMessage & { subQuestions?: unknown })[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: String(m.content ?? ''),
    ...(Array.isArray(m.sources) && m.sources.length ? { sources: m.sources } : {}),
    ...(m.answerId ? { answerId: m.answerId as string } : {}),
    ...(m.done ? { done: m.done } : {}),
    ...(m.subQuestions ? { subQuestions: m.subQuestions } : {}),
    createdAt: iso(m.createdAt)
  }));
  res.json({ threadId: thread._id, title: thread.title, messages: out });
});
