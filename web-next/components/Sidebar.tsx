'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentRow, HealthResponse, StatsResponse } from '@lumina/contract';
import { ACCEPTED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '@lumina/contract';
import { api } from '@/lib/api';
import { usd, type Space, type ThreadRow } from '@/lib/types';
import { Notice } from './Notice';

export function Sidebar({
  threads,
  threadsError,
  threadId,
  onPick,
  onNew,
  spaces,
  spaceId,
  onSpace,
  onSpacesChanged,
  health,
  stats,
  uid,
  onUid,
  onClose
}: {
  threads: ThreadRow[];
  threadsError: unknown;
  threadId?: string;
  onPick: (id: string) => void;
  onNew: () => void;
  spaces: Space[];
  spaceId?: string;
  onSpace: (id: string | undefined) => void;
  onSpacesChanged: () => Promise<void>;
  health: HealthResponse | null | 'down';
  stats: StatsResponse | null;
  uid: string;
  onUid: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <nav className="sidebar" aria-label="Threads and Spaces">
      <div className="side-top">
        <a className="wordmark" href="/" aria-label="Lumina home">
          <LensMark />
          Lumina
        </a>
        <button type="button" className="icon-btn close-sidebar" onClick={onClose} aria-label="Close menu">
          ×
        </button>
      </div>

      <button type="button" className="new-thread" onClick={onNew}>
        New thread
      </button>

      <section className="side-sec">
        <h2>Threads</h2>
        <Notice error={threadsError} what="the thread list" />
        {!threads.length && !threadsError ? <p className="empty">Your first question starts a thread.</p> : null}
        <ul className="thread-list">
          {threads.map((t) => (
            <li key={t.threadId}>
              <button
                type="button"
                className={t.threadId === threadId ? 'on' : ''}
                aria-current={t.threadId === threadId ? 'true' : undefined}
                onClick={() => onPick(t.threadId)}
                title={t.title}
              >
                {t.title || 'Untitled thread'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Spaces spaces={spaces} spaceId={spaceId} onSpace={onSpace} onSpacesChanged={onSpacesChanged} />

      <footer className="side-foot">
        {stats ? (
          <dl className="usage">
            <div>
              <dt>Deep searches today</dt>
              <dd>
                {stats.deepToday} of {stats.deepDailyCap}
              </dd>
            </div>
            <div>
              <dt>Spent today</dt>
              <dd>{usd(stats.costUsdToday)}</dd>
            </div>
          </dl>
        ) : null}
        <HealthLine health={health} />
        <UserId uid={uid} onUid={onUid} />
        <a className="evals-link" href="/evals">
          Evaluation report
        </a>
      </footer>
    </nav>
  );
}

function LensMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 10a4.5 4.5 0 0 1 4.5-4.5" fill="none" stroke="var(--lumen)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function HealthLine({ health }: { health: HealthResponse | null | 'down' }) {
  if (health === null) return <p className="health">Checking the service…</p>;
  if (health === 'down') {
    return (
      <p className="health down">
        <span className="dot" aria-hidden /> Can’t reach the service
      </p>
    );
  }
  const ok = health.status === 'ok' && health.db === 'ok';
  return (
    <p className={`health${ok ? '' : ' degraded'}`} title={`vector store: ${health.vectorStore}, database: ${health.db}`}>
      <span className="dot" aria-hidden /> {health.model} with {health.searchProvider}
      {ok ? '' : ', degraded'}
    </p>
  );
}

function UserId({ uid, onUid }: { uid: string; onUid: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(uid);
  useEffect(() => setDraft(uid), [uid]);
  if (!open) {
    return (
      <p className="uid">
        Signed in as <code>{uid}</code>{' '}
        <button type="button" className="link-btn" onClick={() => setOpen(true)}>
          Switch
        </button>
      </p>
    );
  }
  return (
    <form
      className="uid-form"
      onSubmit={(e) => {
        e.preventDefault();
        onUid(draft);
        setOpen(false);
      }}
    >
      <label htmlFor="uid">User id (sent as X-User-Id)</label>
      <div>
        <input id="uid" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        <button type="submit">Switch</button>
      </div>
    </form>
  );
}

const STATUS_WORDS: Record<string, string> = {
  pending: 'Queued',
  parsing: 'Reading',
  embedding: 'Indexing',
  indexed: 'Ready',
  failed: 'Failed'
};

/**
 * Upload answers 202 at once; the document then walks pending → parsing → embedding →
 * indexed on the worker, and this list polls until nothing is still moving.
 */
function Spaces({
  spaces,
  spaceId,
  onSpace,
  onSpacesChanged
}: {
  spaces: Space[];
  spaceId?: string;
  onSpace: (id: string | undefined) => void;
  onSpacesChanged: () => Promise<void>;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!spaceId) {
      setDocs([]);
      return;
    }
    api
      .listDocuments(spaceId)
      .then((r) => {
        setDocs(r.documents ?? []);
        setError(null);
      })
      .catch(setError);
  }, [spaceId]);

  useEffect(load, [load]);

  useEffect(() => {
    const moving = docs.some((d) => d.status !== 'indexed' && d.status !== 'failed');
    if (!spaceId || !moving) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [docs, spaceId, load]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    try {
      const s = await api.createSpace(n);
      setName('');
      setNaming(false);
      await onSpacesChanged();
      onSpace(s.spaceId);
    } catch (e) {
      setError(e);
    }
  };

  const upload = async (file: File) => {
    if (!spaceId) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(new Error(`${file.name} is over 25 MB. Split it or upload a smaller file.`));
      return;
    }
    setUploading(file.name);
    setError(null);
    try {
      await api.uploadDocument(spaceId, file);
      load();
    } catch (e) {
      setError(e);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const current = spaces.find((s) => s.spaceId === spaceId);

  return (
    <section className="side-sec spaces">
      <h2>
        Spaces
        <button type="button" className="link-btn" onClick={() => setNaming((v) => !v)}>
          {naming ? 'Cancel' : 'New Space'}
        </button>
      </h2>

      {naming ? (
        <form
          className="space-new"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="sr-only" htmlFor="space-name">
            Space name
          </label>
          <input
            id="space-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Course readings"
            maxLength={120}
            autoFocus
          />
          <button type="submit" disabled={!name.trim()}>
            Create
          </button>
        </form>
      ) : null}

      {!spaces.length && !naming ? (
        <p className="empty">A Space holds your documents so you can ask questions about them.</p>
      ) : null}

      <ul className="space-list">
        {spaces.map((s) => (
          <li key={s.spaceId}>
            <button
              type="button"
              className={s.spaceId === spaceId ? 'on' : ''}
              aria-pressed={s.spaceId === spaceId}
              onClick={() => onSpace(s.spaceId === spaceId ? undefined : s.spaceId)}
            >
              {s.name}
            </button>
          </li>
        ))}
      </ul>

      {current ? (
        <div
          className={`drop${drag ? ' drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void upload(f);
          }}
        >
          <input
            ref={fileRef}
            id="file"
            type="file"
            className="sr-only"
            accept={['.pdf', '.md', '.txt', ...ACCEPTED_UPLOAD_TYPES].join(',')}
            disabled={!!uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <label htmlFor="file">
            {uploading ? `Uploading ${uploading}…` : `Add a document to ${current.name}`}
          </label>
          <span>PDF, Markdown or text, up to 25 MB</span>
        </div>
      ) : null}

      <Notice error={error} what="Spaces" />

      {current && docs.length ? (
        <ul className="docs">
          {docs.map((d) => {
            const moving = d.status !== 'indexed' && d.status !== 'failed';
            return (
              <li key={d.docId} className={`doc ${d.status}`}>
                <span className="doc-title" title={d.title}>
                  {d.title}
                </span>
                <span className="doc-status">
                  {STATUS_WORDS[d.status] ?? d.status}
                  {d.status === 'indexed' && d.pages ? `, ${d.pages} pages` : ''}
                </span>
                {moving ? (
                  <span className="doc-bar" aria-hidden>
                    <i style={{ width: `${Math.max(4, d.pct)}%` }} />
                  </span>
                ) : null}
                {d.error ? <span className="doc-err">{d.error}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
