/**
 * The jobs worker: `index_document` is the only job kind.
 *
 *   claim (atomic) → parse → chunk → embed → upsert → READ-YOUR-WRITE PROBE → indexed
 *
 * Crash-safe: a worker killed mid-job leaves the row `running` with a stale `claimedAt`, and
 * the sweeper returns it to `pending`. Finished stages are not re-run: chunks are upserted by
 * a deterministic id and only chunks without an embedding are embedded.
 */
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Locator } from '@lumina/contract';
import { env } from '../env.js';
import { col, uploadsBucket } from '../db.js';
import { log } from '../log.js';
import { embed } from '../providers/embed.js';
import { parseDocument } from './parse.js';

const workerId = `wrk_${randomUUID().slice(0, 8)}`;
let wake: (() => void) | null = null;
let running = false;

/** Called by the upload route so a new job starts now rather than on the next poll. */
export function wakeWorker(): void {
  wake?.();
}

interface JobRow {
  _id: string;
  kind: 'index_document';
  status: 'pending' | 'running' | 'done' | 'failed';
  payload: { docId?: string };
  userId: string;
  claimedAt?: Date;
  workerId?: string;
  attempts: number;
  error?: string;
  createdAt: Date;
}

interface DocRow {
  _id: string;
  spaceId: string;
  userId: string;
  title: string;
  mimeType: string;
  status: string;
  pct: number;
  fileId: string;
  stage?: 'chunked';
  pages?: number;
  chunks?: number;
}

interface ChunkRow {
  _id: string;
  docId: string;
  spaceId: string;
  userId: string;
  text: string;
  locator: Locator;
  ord: number;
  embedding?: number[];
  createdAt: Date;
}

export function startWorker(): void {
  if (running) return;
  running = true;
  log.info({ workerId }, 'jobs worker started');
  void loop();
}

async function loop(): Promise<void> {
  let lastSweep = 0;
  for (;;) {
    try {
      if (Date.now() - lastSweep > 15000) {
        await sweep();
        lastSweep = Date.now();
      }
      const job = await claim();
      if (job) {
        await processJob(job);
        continue;
      }
    } catch (err) {
      log.error({ workerId, err: (err as Error).message }, 'worker loop error');
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, env.workerPollMs);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  }
}

async function claim(): Promise<JobRow | null> {
  const jobs = await col<JobRow>('jobs');
  return jobs.findOneAndUpdate(
    { status: 'pending', kind: 'index_document' },
    { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
}

/** Return crashed jobs (running, claim gone stale) to pending. */
async function sweep(): Promise<void> {
  const jobs = await col<JobRow>('jobs');
  const stale = new Date(Date.now() - env.jobStaleSec * 1000);
  const r = await jobs.updateMany({ status: 'running', claimedAt: { $lt: stale } }, { $set: { status: 'pending' }, $unset: { workerId: '' } });
  if (r.modifiedCount) log.warn({ workerId, count: r.modifiedCount }, 'swept stale jobs back to pending');
}

async function processJob(job: JobRow): Promise<void> {
  const jobs = await col<JobRow>('jobs');
  const documents = await col<DocRow>('documents');
  const docId = job.payload.docId;
  const t0 = Date.now();
  const doc = docId ? await documents.findOne({ _id: docId }) : null;
  if (!doc) {
    await jobs.updateOne({ _id: job._id }, { $set: { status: 'failed', error: `document ${docId ?? '?'} not found` } });
    return;
  }
  try {
    await indexDocument(doc);
    await jobs.updateOne({ _id: job._id }, { $set: { status: 'done' }, $unset: { error: '' } });
    log.info({ workerId, jobId: job._id, docId, ms: Date.now() - t0 }, 'document indexed');
  } catch (err) {
    const message = (err as Error).message || 'indexing failed';
    const final = job.attempts >= env.jobMaxAttempts;
    log.error({ workerId, jobId: job._id, docId, attempt: job.attempts, final, err: message }, 'index_document failed');
    await jobs.updateOne({ _id: job._id }, { $set: { status: final ? 'failed' : 'pending', error: message } });
    if (final) await documents.updateOne({ _id: doc._id }, { $set: { status: 'failed', error: message } });
  }
}

async function indexDocument(doc: DocRow): Promise<void> {
  const documents = await col<DocRow>('documents');
  const chunks = await col<ChunkRow>('chunks');
  const setDoc = (fields: Partial<DocRow>) => documents.updateOne({ _id: doc._id }, { $set: fields });

  // ---- stage 1: parse + chunk (skipped if a previous attempt finished it)
  if (doc.stage !== 'chunked') {
    await setDoc({ status: 'parsing', pct: 5 });
    const buf = await readUpload(doc.fileId);
    const parsed = await parseDocument(buf, doc.mimeType);
    if (!parsed.chunks.length) throw new Error('no extractable text in this file (scanned PDF?)');
    const now = new Date();
    await chunks.bulkWrite(
      parsed.chunks.map((c, ord) => ({
        updateOne: {
          filter: { _id: `${doc._id}:${ord}` },
          update: {
            $set: { docId: doc._id, spaceId: doc.spaceId, userId: doc.userId, text: c.text, locator: c.locator, ord },
            $setOnInsert: { createdAt: now }
          },
          upsert: true
        }
      })),
      { ordered: false }
    );
    // A re-parse that produced fewer chunks must not leave stale ones behind.
    await chunks.deleteMany({ docId: doc._id, ord: { $gte: parsed.chunks.length } });
    await setDoc({ stage: 'chunked', status: 'embedding', pct: 25, chunks: parsed.chunks.length, ...(parsed.pages ? { pages: parsed.pages } : {}) });
  } else {
    await setDoc({ status: 'embedding' });
  }

  // ---- stage 2: embed whatever is not embedded yet
  const total = await chunks.countDocuments({ docId: doc._id });
  const todo = await chunks.find({ docId: doc._id, embedding: { $exists: false } }).sort({ ord: 1 }).toArray();
  let done = total - todo.length;
  const BATCH = 64;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const { vectors } = await embed(batch.map((c) => `${doc.title}\n${c.text}`));
    await chunks.bulkWrite(
      batch.map((c, j) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { embedding: vectors[j] as number[] } } } })),
      { ordered: false }
    );
    done += batch.length;
    await setDoc({ pct: Math.round(25 + (65 * done) / Math.max(1, total)) });
  }

  // ---- stage 3: read-your-write probe. "Upserted" is not "searchable".
  await setDoc({ pct: 92 });
  await probe(doc);
  await documents.updateOne({ _id: doc._id }, { $set: { status: 'indexed', pct: 100 }, $unset: { error: '' } });
}

async function readUpload(fileId: string): Promise<Buffer> {
  const bucket = await uploadsBucket();
  const parts: Buffer[] = [];
  for await (const part of bucket.openDownloadStream(new ObjectId(fileId))) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/**
 * Query the vector index for one of the chunks just written, scoped exactly as a real
 * question would be, and wait until it comes back. Atlas Search indexes are eventually
 * consistent; this is what earns `indexed`.
 */
async function probe(doc: DocRow): Promise<void> {
  const chunks = await col<ChunkRow>('chunks');
  const sample = await chunks.findOne({ docId: doc._id, embedding: { $exists: true } }, { sort: { ord: 1 } });
  if (!sample?.embedding) throw new Error('probe: no embedded chunk to look for');

  if (env.vectorBackend !== 'atlas-vector-search') return; // an exact scan reads its own writes

  const deadline = Date.now() + env.probeTimeoutMs;
  let delay = 500;
  for (;;) {
    const hits = await chunks
      .aggregate<{ _id: string }>([
        {
          $vectorSearch: {
            index: 'chunks_vector',
            path: 'embedding',
            queryVector: sample.embedding,
            numCandidates: 50,
            limit: 10,
            filter: { spaceId: doc.spaceId, userId: doc.userId }
          }
        },
        { $project: { _id: 1 } }
      ])
      .toArray();
    if (hits.some((h) => h._id === sample._id)) return;
    if (Date.now() > deadline) throw new Error(`probe: chunk ${sample._id} not searchable after ${env.probeTimeoutMs}ms (is chunks_vector queryable?)`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 4000);
  }
}
