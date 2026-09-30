/**
 * Spaces and document upload. The upload path does exactly four cheap things — store the
 * bytes in GridFS, insert a `pending` document, insert a `jobs` row, wake the worker — and
 * answers 202. Parsing, chunking, embedding and indexing never run on this request.
 */
import type { NextFunction, Request, Response } from 'express';
import { asyncRouter } from '../util/asyncRouter.js';
import multer from 'multer';
import { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';
import { ACCEPTED_UPLOAD_TYPES, CreateSpaceBody, MAX_UPLOAD_BYTES, newId } from '@lumina/contract';
import { col, uploadsBucket } from '../db.js';
import { wakeWorker } from '../jobs/worker.js';

export const spacesRouter = asyncRouter();

interface SpaceRow {
  _id: string;
  userId: string;
  name: string;
  createdAt: Date;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

spacesRouter.post('/spaces', async (req, res) => {
  const parsed = CreateSpaceBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body', status: 400, requestId: res.locals.requestId });
    return;
  }
  const spaceId = newId('spc');
  await (await col<SpaceRow>('spaces')).insertOne({
    _id: spaceId,
    userId: res.locals.userId as string,
    name: parsed.data.name,
    createdAt: new Date()
  });
  res.status(201).json({ spaceId, name: parsed.data.name });
});

spacesRouter.get('/spaces', async (_req, res) => {
  const rows = await (await col<SpaceRow>('spaces')).find({ userId: res.locals.userId as string }).sort({ createdAt: -1 }).toArray();
  res.json({ spaces: rows.map((s) => ({ spaceId: s._id, name: s.name, createdAt: iso(s.createdAt) })) });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

function receiveFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const e = err as { code?: string; message?: string };
    if (e.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `file too large (max ${MAX_UPLOAD_BYTES} bytes)`, status: 413, requestId: res.locals.requestId });
      return;
    }
    res.status(400).json({ error: e.message ?? 'bad upload', status: 400, requestId: res.locals.requestId });
  });
}

function mimeOf(name: string, declared: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'txt') return 'text/plain';
  return (ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(declared) ? declared : null;
}

spacesRouter.post('/spaces/:spaceId/documents', async (req, res, next) => {
  // Check the Space before accepting a body, so a wrong id is a fast 404.
  const userId = res.locals.userId as string;
  const space = await (await col<SpaceRow>('spaces')).findOne({ _id: req.params.spaceId, userId });
  if (!space) {
    res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404, requestId: res.locals.requestId });
    return;
  }
  res.locals.space = space;
  next();
}, receiveFile, async (req, res) => {
  const userId = res.locals.userId as string;
  const space = res.locals.space as SpaceRow;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'multipart field "file" is required', status: 400, requestId: res.locals.requestId });
    return;
  }
  const mimeType = mimeOf(file.originalname, file.mimetype);
  if (!mimeType) {
    res.status(400).json({ error: `unsupported file type (accepted: ${ACCEPTED_UPLOAD_TYPES.join(', ')})`, status: 400, requestId: res.locals.requestId });
    return;
  }

  const docId = newId('doc');
  const now = new Date();
  // The bytes and the document row are written together; the job row goes last, so the worker
  // can never claim a job whose file is not fully stored yet.
  const fileObjectId = new ObjectId();
  const bucket = await uploadsBucket();
  const [documents, jobs] = await Promise.all([
    col<{ _id: string; [k: string]: unknown }>('documents'),
    col<{ _id: string; [k: string]: unknown }>('jobs')
  ]);
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      const up = bucket.openUploadStreamWithId(fileObjectId, file.originalname, { metadata: { docId, spaceId: space._id, userId, mimeType } });
      Readable.from(file.buffer).pipe(up).on('error', reject).on('finish', () => resolve());
    }),
    documents.insertOne({
      _id: docId,
      spaceId: space._id,
      userId,
      title: file.originalname.slice(0, 200),
      mimeType,
      bytes: file.size,
      status: 'pending',
      pct: 0,
      fileId: String(fileObjectId),
      createdAt: now
    })
  ]);
  await jobs.insertOne({
      _id: newId('doc').replace('doc_', 'job_'),
      kind: 'index_document',
      status: 'pending',
      payload: { docId },
      userId,
      attempts: 0,
      createdAt: now
    });
  wakeWorker();
  res.status(202).json({ docId, status: 'pending' });
});

spacesRouter.get('/spaces/:spaceId/documents', async (req, res) => {
  const userId = res.locals.userId as string;
  const space = await (await col<SpaceRow>('spaces')).findOne({ _id: req.params.spaceId, userId });
  if (!space) {
    res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404, requestId: res.locals.requestId });
    return;
  }
  const rows = await (await col<{ _id: string; [k: string]: unknown }>('documents')).find({ spaceId: space._id, userId }).sort({ createdAt: 1 }).toArray();
  res.json({
    documents: rows.map((d) => ({
      docId: d._id as string,
      title: String(d.title),
      status: d.status as string,
      pct: Math.max(0, Math.min(100, Number(d.pct ?? 0))),
      ...(d.pages ? { pages: d.pages as number } : {}),
      ...(typeof d.chunks === 'number' ? { chunks: d.chunks } : {}),
      ...(d.error ? { error: String(d.error) } : {})
    }))
  });
});
