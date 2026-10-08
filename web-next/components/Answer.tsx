'use client';

import { useState } from 'react';
import type { Source } from '@lumina/contract';
import { Markdown } from '@/lib/markdown';
import { docLabel, hostOf, ms, usd, type UiMessage } from '@/lib/types';

/**
 * One question and its answer. The order on screen is the order of the stream: the plan
 * (deep only), the sources (they arrive before the first word), then the text.
 */
export function Turn({
  id,
  question,
  answer,
  selected,
  onSelect,
  onCite
}: {
  id: string;
  question: string;
  answer?: UiMessage;
  selected: boolean;
  onSelect: () => void;
  onCite: (n: number) => void;
}) {
  const [hover, setHover] = useState<number | undefined>();
  const deep = answer?.depth === 'deep' || answer?.done?.depth === 'deep';

  return (
    <article id={id} className={`turn${selected ? ' selected' : ''}`} onClick={onSelect}>
      <h2 className="question">{question}</h2>

      {answer ? (
        <>
          {deep ? <Plan answer={answer} /> : null}

          {answer.sources.length ? (
            <SourceStrip sources={answer.sources} hover={hover} onPick={onCite} onHover={setHover} />
          ) : answer.streaming ? (
            <Searching answer={answer} />
          ) : null}

          {answer.content ? (
            <div className="answer" aria-live={answer.streaming ? 'polite' : undefined}>
              <Markdown text={answer.content} sources={answer.sources} onCite={onCite} onHover={setHover} active={hover} />
              {answer.streaming ? <span className="caret" aria-hidden /> : null}
            </div>
          ) : null}

          {answer.failed ? <p className="answer-failed">{answer.failed}</p> : null}

          {answer.done && !answer.streaming ? <DoneLine answer={answer} /> : null}
        </>
      ) : null}
    </article>
  );
}

function Searching({ answer }: { answer: UiMessage }) {
  const last = answer.trace[answer.trace.length - 1];
  const what = last ? `${toolVerb(last.tool)}` : answer.depth === 'deep' ? 'Planning the research' : 'Searching';
  return (
    <p className="searching">
      <span className="pulse" aria-hidden />
      {what}
      {answer.trace.length ? <span className="muted"> · step {answer.trace.length}</span> : null}
    </p>
  );
}

export function toolVerb(tool: string): string {
  switch (tool) {
    case 'web_search':
      return 'Searching the web';
    case 'fetch_page':
      return 'Reading a page';
    case 'search_documents':
      return 'Searching your documents';
    case 'recall_memory':
      return 'Checking what you told it before';
    case 'save_memory':
      return 'Remembering a preference';
    case 'plan_research':
      return 'Planning the research';
    default:
      return tool;
  }
}

function Plan({ answer }: { answer: UiMessage }) {
  const plan = answer.plan;
  if (!plan) return null;
  // A sub-question is "done" once a source or step tagged with it has come back.
  const touched = new Set<number>();
  for (const t of answer.trace) if (t.subQuestion) touched.add(t.subQuestion);
  return (
    <section className="plan" aria-label="Research plan">
      <h3>Research plan</h3>
      {plan.reason ? <p className="plan-why">{plan.reason}</p> : null}
      <ol>
        {plan.subQuestions.map((sq) => (
          <li key={sq.i} className={touched.has(sq.i) ? 'touched' : ''}>
            <span className="sq-n">{sq.i}</span>
            <span>
              {sq.question}
              {sq.reason ? <small>{sq.reason}</small> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SourceStrip({
  sources,
  hover,
  onPick,
  onHover
}: {
  sources: Source[];
  hover?: number;
  onPick: (n: number) => void;
  onHover: (n: number | undefined) => void;
}) {
  const [all, setAll] = useState(false);
  const LIMIT = 4;
  const shown = all ? sources : sources.slice(0, LIMIT);
  return (
    <div className="strip" aria-label={`${sources.length} sources`}>
      {shown.map((s) => (
        <button
          key={s.n}
          type="button"
          className={`chip-card${hover === s.n ? ' lit' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onPick(s.n);
          }}
          onMouseEnter={() => onHover(s.n)}
          onMouseLeave={() => onHover(undefined)}
        >
          <span className="chip-n">{s.n}</span>
          <span className="chip-body">
            <span className="chip-title">{s.title}</span>
            <span className="chip-where">
              {s.kind === 'web' ? hostOf(s.url) : `Your document, ${docLabel(s)}`}
            </span>
          </span>
        </button>
      ))}
      {sources.length > LIMIT ? (
        <button
          type="button"
          className="chip-more"
          onClick={(e) => {
            e.stopPropagation();
            setAll((v) => !v);
          }}
        >
          {all ? 'Show fewer' : `${sources.length - LIMIT} more`}
        </button>
      ) : null}
    </div>
  );
}

function DoneLine({ answer }: { answer: UiMessage }) {
  const d = answer.done!;
  const stopped =
    d.terminated === 'cap'
      ? 'Stopped at the step limit. This answer is partial.'
      : d.terminated === 'error'
        ? 'A provider failed partway. This answer is incomplete.'
        : null;
  return (
    <footer className="done">
      {stopped ? <p className={`stopped ${d.terminated}`}>{stopped}</p> : null}
      <dl>
        {d.ttftMs !== undefined ? (
          <div>
            <dt>First word</dt>
            <dd>{ms(d.ttftMs)}</dd>
          </div>
        ) : null}
        {d.latencyMs !== undefined ? (
          <div>
            <dt>Total</dt>
            <dd>{ms(d.latencyMs)}</dd>
          </div>
        ) : null}
        {d.costUsd !== undefined ? (
          <div>
            <dt>Cost</dt>
            <dd>{usd(d.costUsd)}</dd>
          </div>
        ) : null}
        {d.tokens ? (
          <div>
            <dt>Tokens</dt>
            <dd>
              {d.tokens.in.toLocaleString()} in, {d.tokens.out.toLocaleString()} out
            </dd>
          </div>
        ) : null}
        {(d as { answerCached?: boolean }).answerCached ? (
          <div className="from-cache">
            <dt>Answer</dt>
            <dd>reused from a similar question</dd>
          </div>
        ) : d.searchCached !== undefined ? (
          <div>
            <dt>Search cache</dt>
            <dd>{d.searchCached ? 'hit' : 'miss'}</dd>
          </div>
        ) : null}
        {d.subQuestions ? (
          <div>
            <dt>Sub-questions</dt>
            <dd>{d.subQuestions}</dd>
          </div>
        ) : null}
        {d.model ? (
          <div>
            <dt>Model</dt>
            <dd>{d.model}</dd>
          </div>
        ) : null}
      </dl>
    </footer>
  );
}
