/**
 * POST /threads/:threadId/ask — the answer stream.
 *
 * Checks that must be real HTTP statuses happen BEFORE the stream opens: 400 (body), 404
 * (thread / space), 429 (deep cap). After that the run owns the response: it ends `done`
 * (terminated done or cap), or as an error — a 502 if nothing was streamed yet, an `error`
 * frame if it was.
 */
import type { Request, Response } from 'express';
import { asyncRouter } from '../util/asyncRouter.js';
import { AskBody, newId, type DoneEvent, type Terminated } from '@lumina/contract';
import { env } from '../env.js';
import { col } from '../db.js';
import { log } from '../log.js';
import { AskStream } from '../agent/stream.js';
import { CapReached, RunCtx } from '../agent/context.js';
import { historyMessages, type AnswerWriter } from '../agent/answer.js';
import { runQuick } from '../agent/quick.js';
import { runDeep, type Plan } from '../agent/deep.js';
import { persistRun } from '../agent/persist.js';
import { storeAnswer } from '../agent/answerCache.js';
import { claimDeepSearch } from '../agent/usage.js';

export const askRouter = asyncRouter();

const CAP_NOTE = {
  'tool-calls': '\n\n_(Stopped at the tool-call cap for this search depth, so this answer may be incomplete.)_',
  'wall-clock': '\n\n_(Stopped at the time cap for this search depth, so this answer may be incomplete.)_'
} as const;

askRouter.post('/threads/:threadId/ask', async (req: Request, res: Response) => {
  const userId = res.locals.userId as string;
  const requestId = res.locals.requestId as string;
  const threadId = req.params.threadId as string;

  const parsed = AskBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json({ error: msg, status: 400, requestId });
    return;
  }
  const body = parsed.data;

  const threads = await col<{ _id: string; userId: string; title: string }>('threads');
  const thread = await threads.findOne({ _id: threadId, userId });
  if (!thread) {
    res.status(404).json({ error: `no thread ${threadId}`, status: 404, requestId });
    return;
  }
  if (body.spaceId) {
    const space = await (await col<{ _id: string; userId: string }>('spaces')).findOne({ _id: body.spaceId, userId });
    if (!space) {
      res.status(404).json({ error: `no space ${body.spaceId}`, status: 404, requestId });
      return;
    }
  }

  // Deep is opted into by the client and never upgraded by the server. It is also the
  // expensive gear, so it is gated here, next to the spending.
  if (body.depth === 'deep') {
    const claim = await claimDeepSearch(userId);
    if (!claim.ok) {
      res.status(429).json({
        error: `deep-search daily cap reached (${env.deepDailyCap} per user per day)`,
        status: 429,
        resetsAt: claim.resetsAt,
        requestId
      });
      return;
    }
  }

  const clientGone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) clientGone.abort(new Error('client disconnected'));
  });

  const stream = new AskStream(res, requestId);
  const answerId = newId('ans');
  const messages = await col<{ _id: string; [k: string]: unknown }>('messages');
  const prior = await messages
    .find({ threadId, userId })
    .sort({ createdAt: 1 })
    .project<{ role: 'user' | 'assistant'; content: string }>({ role: 1, content: 1 })
    .toArray();
  await messages.insertOne({
    _id: messageId(),
    threadId,
    userId,
    role: 'user',
    content: body.query,
    createdAt: new Date()
  });
  if (!prior.length && (!thread.title || thread.title === 'New thread')) {
    await threads.updateOne({ _id: threadId }, { $set: { title: body.query.slice(0, 80) } });
  }

  const ctx = new RunCtx({
    requestId,
    userId,
    threadId,
    answerId,
    query: body.query,
    mode: body.mode,
    depth: body.depth,
    ...(body.spaceId ? { spaceId: body.spaceId } : {}),
    stream,
    clientSignal: clientGone.signal
  });
  const history = historyMessages(prior);

  let terminated: Terminated = 'done';
  let writer: AnswerWriter | null = null;
  let plan: Plan | null = null;
  let text = '';
  let errorMessage: string | undefined;

  try {
    if (body.depth === 'deep') ({ writer, plan } = await runDeep(ctx, history));
    else writer = await runQuick(ctx, history);
    if (ctx.capHit) {
      terminated = 'cap';
      writer.note(CAP_NOTE[ctx.capHit.which]);
    }
    text = ctx.answerText;
  } catch (err) {
    if (clientGone.signal.aborted) {
      terminated = 'error';
      errorMessage = 'client disconnected';
    } else if (ctx.capHit && (err === ctx.capHit || err instanceof CapReached || ctx.signal.aborted)) {
      // A cap is an outcome, not a crash: close honestly with what exists.
      terminated = 'cap';
      capFinish(ctx, CAP_NOTE[ctx.capHit.which]);
      text = ctx.answerText;
    } else {
      terminated = 'error';
      errorMessage = (err as Error).message || 'unknown failure';
      log.error({ requestId, err: errorMessage, stack: (err as Error).stack }, 'ask failed');
      // Any upstream failure (LLM, search, embeddings, database) is a 502. Never a plausible answer.
      stream.fail(502, errorMessage);
    }
  } finally {
    ctx.dispose();
  }

  let done: DoneEvent | null = null;
  if (terminated !== 'error') {
    done = {
      answerId,
      latencyMs: ctx.elapsedMs(),
      ttftMs: ctx.ttftMs ?? ctx.elapsedMs(),
      model: body.depth === 'deep' ? env.llmModelDeep : env.llmModel,
      tokens: { in: ctx.tokensIn, out: ctx.tokensOut },
      costUsd: ctx.costUsd,
      searchCached: ctx.searchCached,
      terminated,
      depth: body.depth,
      subQuestions: plan?.subQuestions.length ?? 0
    };
    // answerCached is beyond the contract's DoneEvent (zod passes unknown keys through).
    stream.send('done', { ...done, answerCached: ctx.answerCached });
    stream.end();
    await messages.insertOne({
      _id: messageId(),
      threadId,
      userId,
      role: 'assistant',
      content: text,
      answerId,
      sources: writer?.wire.length ? writer.wire : ctx.wireSources(),
      done,
      ...(plan ? { subQuestions: plan.subQuestions } : {}),
      createdAt: new Date()
    });
  } else if (!stream.isEnded) {
    stream.end();
  }

  if (body.depth === 'quick') await storeAnswer(ctx, terminated, history.length > 0, writer?.wire ?? []);
  await persistRun(ctx, terminated, done, terminated === 'error' ? (clientGone.signal.aborted ? 499 : 502) : 200, errorMessage);
});

/** Close a capped run that was interrupted mid-flight: sources (if not sent), then the notice. */
function capFinish(ctx: RunCtx, note: string): void {
  const stream = ctx.init.stream;
  if (!stream.isOpen || !ctx.sourcesFrozen) {
    ctx.sourcesFrozen = true;
    ctx.number();
    stream.send('sources', ctx.wireSources());
    stream.open();
  }
  const msg = ctx.ttftMs === null ? `I ran out of budget before I could write an answer.${note}` : note;
  if (ctx.ttftMs === null) ctx.ttftMs = ctx.elapsedMs();
  stream.send('token', { text: msg });
  ctx.answerText += msg;
}

const messageId = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
