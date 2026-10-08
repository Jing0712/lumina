'use client';

import { useEffect, useRef, useState } from 'react';
import type { AskMode, Depth } from '@lumina/contract';
import type { Space } from '@/lib/types';

const MODES: { value: AskMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Lumina picks the web or your documents, and the steps show which' },
  { value: 'web', label: 'Web', hint: 'Search the live web only' },
  { value: 'docs', label: 'Documents', hint: 'Answer from the selected Space only' }
];

export function Composer({
  onAsk,
  onStop,
  busy,
  spaces,
  spaceId,
  onSpace,
  deepLeft,
  compact
}: {
  onAsk: (query: string, mode: AskMode, depth: Depth, spaceId?: string) => void;
  onStop: () => void;
  busy: boolean;
  spaces: Space[];
  spaceId?: string;
  onSpace: (id: string | undefined) => void;
  deepLeft?: { used: number; cap: number };
  compact: boolean;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<AskMode>('auto');
  const [depth, setDepth] = useState<Depth>('quick');
  const ref = useRef<HTMLTextAreaElement>(null);

  const left = deepLeft ? Math.max(0, deepLeft.cap - deepLeft.used) : undefined;
  const capped = left === 0;

  // Deep is opted into per question, and never left on once the allowance is gone.
  useEffect(() => {
    if (capped && depth === 'deep') setDepth('quick');
  }, [capped, depth]);

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [query]);

  const docsWithoutSpace = mode === 'docs' && !spaceId;

  const submit = () => {
    const q = query.trim();
    if (!q || busy || docsWithoutSpace) return;
    onAsk(q, mode, depth, mode === 'web' ? undefined : spaceId);
    setQuery('');
  };

  return (
    <form
      className={`composer${compact ? ' compact' : ''}${depth === 'deep' ? ' is-deep' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="q">
        Your question
      </label>
      <textarea
        id="q"
        ref={ref}
        rows={compact ? 1 : 2}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={compact ? 'Ask a follow-up' : 'Ask anything'}
        autoFocus
      />

      <div className="composer-row">
        <div className="seg" role="radiogroup" aria-label="Where to look">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className={mode === m.value ? 'on' : ''}
              title={m.hint}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode !== 'web' && (
          <select
            className="space-pick"
            value={spaceId ?? ''}
            onChange={(e) => onSpace(e.target.value || undefined)}
            aria-label="Space to search"
          >
            <option value="">{mode === 'docs' ? 'Choose a Space' : 'No Space'}</option>
            {spaces.map((s) => (
              <option key={s.spaceId} value={s.spaceId}>
                {s.name}
              </option>
            ))}
          </select>
        )}

        <span className="grow" />

        <button
          type="button"
          className={`deep-toggle${depth === 'deep' ? ' on' : ''}`}
          aria-pressed={depth === 'deep'}
          disabled={capped}
          onClick={() => setDepth((d) => (d === 'deep' ? 'quick' : 'deep'))}
          title={
            capped
              ? 'You have used today’s deep searches'
              : 'Plan sub-questions, research each one, then merge the sources. Slower and costs more.'
          }
        >
          <span className="deep-dot" aria-hidden />
          Deep
          {left !== undefined ? <span className="deep-left">{left} left</span> : null}
        </button>

        {busy ? (
          <button type="button" className="send stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="send" disabled={!query.trim() || docsWithoutSpace}>
            {depth === 'deep' ? 'Research' : 'Ask'}
          </button>
        )}
      </div>

      {depth === 'deep' ? (
        <p className="composer-hint">
          Deep search plans the question into parts, researches each part, and merges the sources. It
          takes up to a minute and costs several quick searches.
        </p>
      ) : docsWithoutSpace ? (
        <p className="composer-hint">Choose a Space to answer from your documents.</p>
      ) : null}
    </form>
  );
}
