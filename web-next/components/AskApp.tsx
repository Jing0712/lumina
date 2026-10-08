'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskMode, Depth, HealthResponse, StatsResponse } from '@lumina/contract';
import { api, ApiError, askStream, setUserId, userId } from '@/lib/api';
import { localId, type Space, type ThreadRow, type UiMessage } from '@/lib/types';
import { Composer } from './Composer';
import { Turn } from './Answer';
import { Inspector, type Tab } from './Inspector';
import { Notice } from './Notice';
import { Sidebar } from './Sidebar';

const STARTERS = [
  'What changed in the latest Node.js LTS release?',
  'Compare MongoDB Atlas Vector Search with pgvector for a small team',
  'Explain how server-sent events differ from WebSockets'
];

export function AskApp() {
  const [uid, setUid] = useState('');
  const [health, setHealth] = useState<HealthResponse | null | 'down'>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [threadsError, setThreadsError] = useState<unknown>(null);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spaceId, setSpaceId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [memoryKey, setMemoryKey] = useState(0);
  const [selected, setSelected] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>('sources');
  const [focus, setFocus] = useState<{ n: number; tick: number } | undefined>();
  const [sideOpen, setSideOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // localStorage only exists in the browser; read the id after mount.
  useEffect(() => setUid(userId()), []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth('down'));
  }, []);

  const loadStats = useCallback(() => {
    api.stats().then(setStats).catch(() => setStats(null));
  }, []);

  const loadThreads = useCallback(() => {
    api
      .listThreads()
      .then((r) => {
        setThreads(r.threads ?? []);
        setThreadsError(null);
      })
      .catch((e) => {
        setThreads([]);
        setThreadsError(e);
      });
  }, []);

  const loadSpaces = useCallback(async () => {
    try {
      const r = await api.listSpaces();
      setSpaces(r.spaces ?? []);
    } catch {
      setSpaces([]);
    }
  }, []);

  useEffect(() => {
    if (!uid) return;
    loadThreads();
    void loadSpaces();
    loadStats();
  }, [uid, loadThreads, loadSpaces, loadStats]);

  // A new question scrolls to the top of the reading area, and the answer writes in below it.
  const [scrollTo, setScrollTo] = useState<string | undefined>();
  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(`turn-${scrollTo}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setScrollTo(undefined);
  }, [scrollTo, messages]);

  const resetView = () => {
    abortRef.current?.abort();
    setThreadId(undefined);
    setMessages([]);
    setError(null);
    setSelected(undefined);
    setFocus(undefined);
  };

  const openThread = async (id: string) => {
    resetView();
    setThreadId(id);
    setSideOpen(false);
    try {
      const r = await api.getThread(id);
      const rows: UiMessage[] = (r.messages ?? []).map((m) => ({
        id: localId(),
        role: m.role,
        content: m.content,
        sources: m.sources ?? [],
        trace: [],
        answerId: m.answerId,
        done: m.done,
        depth: m.done?.depth
      }));
      setMessages(rows);
      setSelected(rows.filter((m) => m.role === 'assistant').at(-1)?.id);
    } catch (e) {
      setError(e);
    }
  };

  const patch = (id: string, fn: (m: UiMessage) => UiMessage) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  const ask = async (query: string, mode: AskMode, depth: Depth, space?: string) => {
    setBusy(true);
    setError(null);

    let id = threadId;
    try {
      if (!id) {
        id = (await api.createThread(query.slice(0, 120))).threadId;
        setThreadId(id);
      }
    } catch (e) {
      setError(e);
      setBusy(false);
      return;
    }

    const qId = localId();
    const aId = localId();
    setMessages((prev) => [
      ...prev,
      { id: qId, role: 'user', content: query, sources: [], trace: [] },
      { id: aId, role: 'assistant', content: '', sources: [], trace: [], depth, streaming: true }
    ]);
    setSelected(aId);
    setScrollTo(qId);
    setFocus(undefined);
    setTab(depth === 'deep' ? 'steps' : 'sources');

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      await askStream(
        id,
        { query, mode, depth, spaceId: space },
        {
          onPlan: (p) => patch(aId, (m) => ({ ...m, plan: p })),
          onTrace: (t) => patch(aId, (m) => ({ ...m, trace: [...m.trace, t] })),
          onSources: (s) => patch(aId, (m) => ({ ...m, sources: s })),
          onToken: (text) => patch(aId, (m) => ({ ...m, content: m.content + text })),
          onDone: (d) => patch(aId, (m) => ({ ...m, done: d, depth: d.depth, answerId: d.answerId, streaming: false })),
          onError: (e) => {
            patch(aId, (m) => ({ ...m, streaming: false, failed: `The answer stopped: ${e.error}` }));
            setError(new ApiError(e.status, e.error));
          }
        },
        ctrl.signal
      );
      if (ctrl.signal.aborted) patch(aId, (m) => ({ ...m, streaming: false, failed: m.content ? 'Stopped.' : 'Stopped before an answer arrived.' }));
    } catch (e) {
      patch(aId, (m) => ({ ...m, streaming: false }));
      setError(e);
    } finally {
      patch(aId, (m) => (m.streaming ? { ...m, streaming: false } : m));
      abortRef.current = null;
      setBusy(false);
      setMemoryKey((k) => k + 1);
      loadThreads();
      loadStats();
    }
  };

  const turns = useMemo(() => {
    const out: { q: UiMessage; a?: UiMessage }[] = [];
    for (const m of messages) {
      if (m.role === 'user') out.push({ q: m });
      else if (out.length && !out[out.length - 1]!.a) out[out.length - 1]!.a = m;
      else out.push({ q: { ...m, role: 'user', content: '' }, a: m });
    }
    return out;
  }, [messages]);

  const selectedAnswer =
    messages.find((m) => m.id === selected && m.role === 'assistant') ??
    messages.filter((m) => m.role === 'assistant').at(-1);

  const cite = (answerId: string, n: number) => {
    setSelected(answerId);
    setTab('sources');
    setFocus({ n, tick: Date.now() });
    setInspectOpen(true);
  };

  const deepLeft = stats ? { used: stats.deepToday, cap: stats.deepDailyCap } : undefined;
  const empty = !messages.length;

  return (
    <div className={`shell${sideOpen ? ' side-open' : ''}${inspectOpen ? ' inspect-open' : ''}`}>
      <Sidebar
        threads={threads}
        threadsError={threadsError}
        threadId={threadId}
        onPick={openThread}
        onNew={() => {
          resetView();
          setSideOpen(false);
        }}
        spaces={spaces}
        spaceId={spaceId}
        onSpace={setSpaceId}
        onSpacesChanged={loadSpaces}
        health={health}
        stats={stats}
        uid={uid}
        onUid={(id) => {
          setUserId(id);
          setUid(userId());
          resetView();
        }}
        onClose={() => setSideOpen(false)}
      />

      <div className="scrim" onClick={() => (setSideOpen(false), setInspectOpen(false))} aria-hidden />

      <main className={`reader${empty ? ' is-empty' : ''}`}>
        <div className="mobile-bar">
          <button type="button" className="icon-btn" onClick={() => setSideOpen(true)} aria-label="Open threads and Spaces">
            <Burger />
          </button>
          <span className="mobile-title">Lumina</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              if (empty) setTab('memory');
              setInspectOpen(true);
            }}
          >
            {empty ? 'Memory' : 'Evidence'}
          </button>
        </div>

        {empty ? (
          <section className="hero">
            <h1>Ask, and see where every answer comes from.</h1>
            <p>
              Lumina searches the web and your documents, writes an answer as it reads, and marks each
              claim with the source it rests on.
            </p>
          </section>
        ) : null}

        {!empty ? (
          <div className="turns">
            {turns.map(({ q, a }) => (
              <Turn
                key={q.id}
                id={`turn-${q.id}`}
                question={q.content}
                answer={a}
                selected={!!a && a.id === selectedAnswer?.id}
                onSelect={() => a && setSelected(a.id)}
                onCite={(n) => a && cite(a.id, n)}
              />
            ))}
          </div>
        ) : null}

        {error ? (
          <div className="reader-notice">
            <Notice error={error} what="asking a question" />
          </div>
        ) : null}

        <div className="dock">
          <Composer
            onAsk={ask}
            onStop={() => abortRef.current?.abort()}
            busy={busy}
            spaces={spaces}
            spaceId={spaceId}
            onSpace={setSpaceId}
            deepLeft={deepLeft}
            compact={!empty}
          />
          {empty ? (
            <ul className="starters" aria-label="Example questions">
              {STARTERS.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => void ask(s, 'auto', 'quick', spaceId)} disabled={busy}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </main>

      <Inspector
        answer={selectedAnswer}
        tab={tab}
        onTab={setTab}
        focus={focus}
        memoryKey={memoryKey}
        onClose={() => setInspectOpen(false)}
      />
    </div>
  );
}

function Burger() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
