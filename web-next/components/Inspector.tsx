'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Memory, PlanEvent, TraceEvent } from '@lumina/contract';
import { api } from '@/lib/api';
import { docLabel, hostOf, ms, type UiMessage } from '@/lib/types';
import { Notice } from './Notice';
import { toolVerb } from './Answer';

export type Tab = 'sources' | 'steps' | 'memory';

/**
 * The evidence for the selected answer: every source with the passage it was cited for,
 * every step the loop took and why, and everything Lumina remembers about you.
 */
export function Inspector({
  answer,
  tab,
  onTab,
  focus,
  memoryKey,
  onClose
}: {
  answer?: UiMessage;
  tab: Tab;
  onTab: (t: Tab) => void;
  focus?: { n: number; tick: number };
  memoryKey: number;
  onClose: () => void;
}) {
  const counts = {
    sources: answer?.sources.length ?? 0,
    steps: answer?.trace.length ?? 0
  };

  return (
    <aside className="inspector" aria-label="Evidence">
      <div className="tabs" role="tablist">
        <TabBtn id="sources" tab={tab} onTab={onTab} label="Sources" count={counts.sources} />
        <TabBtn id="steps" tab={tab} onTab={onTab} label="Steps" count={counts.steps} />
        <TabBtn id="memory" tab={tab} onTab={onTab} label="Memory" />
        <button type="button" className="icon-btn close-inspector" onClick={onClose} aria-label="Close evidence panel">
          ×
        </button>
      </div>

      <div className="tab-body" role="tabpanel">
        {tab === 'sources' ? <Sources answer={answer} focus={focus} /> : null}
        {tab === 'steps' ? <Steps answer={answer} /> : null}
        {tab === 'memory' ? <MemoryList refreshKey={memoryKey} /> : null}
      </div>
    </aside>
  );
}

function TabBtn({ id, tab, onTab, label, count }: { id: Tab; tab: Tab; onTab: (t: Tab) => void; label: string; count?: number }) {
  return (
    <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => onTab(id)}>
      {label}
      {count ? <span className="count">{count}</span> : null}
    </button>
  );
}

function Sources({ answer, focus }: { answer?: UiMessage; focus?: { n: number; tick: number } }) {
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`src-${focus.n}`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }, [focus]);

  if (!answer?.sources.length) {
    return <p className="empty">Sources for the selected answer show up here before its first word arrives.</p>;
  }
  const plan = answer.plan;
  return (
    <ol className="sources">
      {answer.sources.map((s) => (
        <li key={s.n} id={`src-${s.n}`} className={`source${focus?.n === s.n ? ' focus' : ''}`}>
          <span className="src-n">{s.n}</span>
          <div className="src-body">
            {s.kind === 'web' && s.url ? (
              <a className="src-title" href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title}
              </a>
            ) : (
              <span className="src-title">{s.title}</span>
            )}
            <span className="src-where">
              {s.kind === 'web' ? hostOf(s.url) : `Your document, ${docLabel(s)}`}
              {s.subQuestion ? <SubTag n={s.subQuestion} plan={plan} /> : null}
            </span>
            <blockquote className="src-snip">{s.snippet}</blockquote>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SubTag({ n, plan }: { n: number; plan?: PlanEvent }) {
  const q = plan?.subQuestions.find((s) => s.i === n)?.question;
  return (
    <span className="subtag" title={q}>
      for part {n}
    </span>
  );
}

/**
 * Quick search: a flat list. Deep search: a tree, one branch per sub-question, so the
 * parallel research reads as what it is.
 */
function Steps({ answer }: { answer?: UiMessage }) {
  if (!answer?.trace.length) {
    return <p className="empty">Every tool call behind the selected answer shows up here, in order, with why it ran.</p>;
  }
  const deep = !!answer.plan || answer.trace.some((t) => t.subQuestion);
  if (!deep) {
    return (
      <ol className="steps">
        {answer.trace.map((t, i) => (
          <Step key={`${t.step}-${i}`} t={t} />
        ))}
      </ol>
    );
  }

  const root = answer.trace.filter((t) => !t.subQuestion);
  const branches = new Map<number, TraceEvent[]>();
  for (const t of answer.trace) {
    if (!t.subQuestion) continue;
    branches.set(t.subQuestion, [...(branches.get(t.subQuestion) ?? []), t]);
  }
  const order = answer.plan?.subQuestions.map((s) => s.i) ?? [...branches.keys()].sort((a, b) => a - b);

  return (
    <div className="tree">
      {root.length ? (
        <ol className="steps">
          {root.map((t, i) => (
            <Step key={`r${t.step}-${i}`} t={t} />
          ))}
        </ol>
      ) : null}
      {order.map((i) => {
        const steps = branches.get(i) ?? [];
        const q = answer.plan?.subQuestions.find((s) => s.i === i)?.question;
        const span = steps.reduce((a, t) => a + t.ms, 0);
        return (
          <details key={i} className="branch" open>
            <summary>
              <span className="sq-n">{i}</span>
              <span className="branch-q">{q ?? `Part ${i}`}</span>
              <span className="branch-meta">{steps.length ? `${steps.length} steps, ${ms(span)}` : 'waiting'}</span>
            </summary>
            <ol className="steps">
              {steps.map((t, j) => (
                <Step key={`${t.step}-${j}`} t={t} />
              ))}
            </ol>
          </details>
        );
      })}
    </div>
  );
}

function Step({ t }: { t: TraceEvent }) {
  const detail = describeInput(t);
  return (
    <li className={`step${t.ok ? '' : ' failed'}`}>
      <span className="step-n">{t.step}</span>
      <div className="step-body">
        <div className="step-head">
          <span className="step-what">{toolVerb(t.tool)}</span>
          <span className="step-ms">{ms(t.ms)}</span>
        </div>
        {detail ? <div className="step-input">{detail}</div> : null}
        {t.ok ? (t.reason ? <div className="step-why">{t.reason}</div> : null) : <div className="step-err">{t.error ?? 'Failed'}</div>}
        <code className="step-tool">{t.tool}</code>
      </div>
    </li>
  );
}

function describeInput(t: TraceEvent): string | null {
  const i = t.input ?? {};
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  const v = pick('query') ?? pick('url') ?? pick('text') ?? pick('question');
  if (!v) return null;
  return v.length > 140 ? `${v.slice(0, 140)}…` : v;
}

function MemoryList({ refreshKey }: { refreshKey: number }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listMemory()
      .then((r) => {
        setMemories(r.memories ?? []);
        setError(null);
      })
      .catch((e) => {
        setMemories([]);
        setError(e);
      });
  }, []);

  useEffect(load, [load, refreshKey]);

  const remove = async (id: string) => {
    setRemoving(id);
    try {
      await api.deleteMemory(id);
      setMemories((m) => (m ?? []).filter((x) => x.id !== id));
    } catch (e) {
      setError(e);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="memory">
      <p className="memory-lede">
        What Lumina keeps between conversations. Delete anything and it stops shaping answers.
      </p>
      <Notice error={error} what="your memory" />
      {memories === null ? <p className="empty">Loading…</p> : null}
      {memories && !memories.length && !error ? (
        <p className="empty">
          Nothing yet. Tell it a preference, like “keep answers under 100 words”, and it will appear here and
          carry into new threads.
        </p>
      ) : null}
      <ul>
        {memories?.map((m) => (
          <li key={m.id}>
            <span className="mem-text">{m.text}</span>
            <span className="mem-meta">
              {new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              <button type="button" className="link-btn danger" disabled={removing === m.id} onClick={() => remove(m.id)}>
                {removing === m.id ? 'Deleting' : 'Delete'}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="link-btn" onClick={load}>
        Refresh
      </button>
    </div>
  );
}
