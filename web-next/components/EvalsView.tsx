'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { EvalsReport, type GateResult, type RubricRow, type SlaRow, type Trajectory } from '@lumina/contract';
import { api } from '@/lib/api';
import { Notice } from './Notice';

/**
 * /evals renders whatever GET /evals/report.json returns, validated against the contract's
 * EvalsReport schema, and nothing else. It cannot compute or edit a score: every number
 * on it was written by a run of the gates against the deployed app.
 */
export function EvalsView({ report: injected }: { report?: EvalsReport } = {}) {
  const [report, setReport] = useState<EvalsReport | null>(injected ?? null);
  const [raw, setRaw] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [schemaIssue, setSchemaIssue] = useState<string | null>(null);

  useEffect(() => {
    if (injected) return;
    api
      .evalsReport()
      .then((body) => {
        setRaw(body);
        const parsed = EvalsReport.safeParse(body);
        if (parsed.success) setReport(parsed.data);
        else setSchemaIssue(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      })
      .catch(setError);
  }, [injected]);

  if (error) {
    return (
      <Page>
        <Notice error={error} what="the evaluation report" />
        <p className="empty">
          The report is written by <code>/fde-lumina-eval --deploy-url https://&lt;your-gateway&gt;</code>, which
          runs the gates against the deployed app.
        </p>
      </Page>
    );
  }

  if (!report) {
    return (
      <Page>
        {schemaIssue ? (
          <div className="notice bad">
            <strong>The report doesn’t match the contract.</strong> {schemaIssue}. Re-run the eval rather than
            editing the file.
            <pre className="raw">{JSON.stringify(raw, null, 2).slice(0, 2000)}</pre>
          </div>
        ) : (
          <p className="empty">Loading the evaluation…</p>
        )}
      </Page>
    );
  }

  const { rubric, bench, quality, trajectories } = report;
  const pct = rubric.total ? Math.round((rubric.awarded / rubric.total) * 100) : 0;

  return (
    <Page>
      <header className="ev-head">
        <p className="ev-assign">{report.assignment}</p>
        <h1>{report.student}</h1>
        <p className="ev-meta">
          Deployed {new Date(report.deployedAt).toLocaleString()}
          {report.repo ? (
            <>
              {', '}
              <a href={report.repo}>source</a>
            </>
          ) : null}
        </p>
        {report.runNotes ? <p className="ev-notes">{report.runNotes}</p> : null}
      </header>

      <section className="ev-score" aria-label="Score">
        <div className="ev-ring" style={{ ['--p' as string]: pct }}>
          <span className="ev-big">{rubric.awarded}</span>
          <span className="ev-of">of {rubric.total}</span>
        </div>
        <ul className="ev-flags">
          <li className={bench.pass ? 'ok' : 'bad'}>Benchmark {bench.pass ? 'passed' : 'failed'}</li>
          <li className={quality.errors ? 'bad' : quality.warnings ? 'warn' : 'ok'}>
            Quality rules: {quality.errors} {quality.errors === 1 ? 'error' : 'errors'}, {quality.warnings}{' '}
            {quality.warnings === 1 ? 'warning' : 'warnings'}
          </li>
          {rubric.redLines.length ? (
            <li className={rubric.redLines.every((r) => r.ok) ? 'ok' : 'bad'}>
              Red lines: {rubric.redLines.filter((r) => r.ok).length} of {rubric.redLines.length} clear
            </li>
          ) : null}
        </ul>
      </section>

      {report.video ? (
        <Section title="Demo">
          <div className="video">
            <iframe src={embedUrl(report.video)} title="Demo video" allow="fullscreen; picture-in-picture" allowFullScreen />
          </div>
          <p className="ev-small">
            Player blocked?{' '}
            <a href={report.video} target="_blank" rel="noreferrer noopener">
              Open the video
            </a>
          </p>
        </Section>
      ) : null}

      {report.gates.length ? (
        <Section title="Gates">
          <Table head={['', 'Gate', 'Result', 'Detail']}>
            {report.gates.map((g: GateResult) => (
              <tr key={g.gate} className={g.status === 'fail' ? 'fail' : undefined}>
                <td className="num">{g.gate}</td>
                <td>{g.name}</td>
                <td>
                  <Mark s={g.status} />
                </td>
                <td>{g.detail ?? ''}</td>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}

      <Section title="Rubric">
        <RubricTable rows={rubric.automated} caption="Automated" />
        <RubricTable rows={rubric.manual} caption="Read by a person" />
        {rubric.redLines.length ? (
          <Table head={['Red line', 'Result']}>
            {rubric.redLines.map((r, i) => (
              <tr key={i} className={r.ok ? undefined : 'fail'}>
                <td>{r.check}</td>
                <td>{r.ok ? <span className="m-pass">Clear</span> : <span className="m-fail">Crossed {r.detail ?? ''}</span>}</td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Section>

      <Section title="Benchmark against the declared targets">
        <p className="ev-small">
          Against {bench.target}, run {new Date(bench.ranAt).toLocaleString()}
        </p>
        <Table head={['Metric', 'Target', 'Measured', 'Result']} numeric={[1, 2]}>
          {bench.sla.map((r: SlaRow) => (
            <tr key={r.metric} className={r.pass ? undefined : 'fail'}>
              <td>
                {r.metric}
                {r.note ? <small>{r.note}</small> : null}
              </td>
              <td className="num">
                {r.comparator === '<=' ? '≤' : '≥'} {r.target}
                {r.unit}
              </td>
              <td className="num">{r.actual === null ? '–' : `${round(r.actual)}${r.unit}`}</td>
              <td>{r.pass ? <span className="m-pass">Met</span> : <span className="m-fail">Missed</span>}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Quality rules">
        <Table head={['Rule', 'What it checks', 'Severity', 'Result']}>
          {quality.results.map((r) => (
            <tr key={r.id} className={r.status === 'fail' && r.severity === 'error' ? 'fail' : undefined}>
              <td>
                <code>{r.id}</code>
              </td>
              <td>{r.title}</td>
              <td>{r.severity}</td>
              <td>
                <Mark s={r.status} /> {r.detail ?? ''}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Design: the five questions">
        <dl className="design">
          {(
            [
              ['Components', report.design.components],
              ['Responsibilities', report.design.responsibilities],
              ['Communication', report.design.communication],
              ['State', report.design.state],
              ['Trade-offs', report.design.tradeoffs]
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Two runs, read end to end">
        <TrajectoryView label="A run that worked" t={trajectories.successful} />
        <TrajectoryView label="A run that failed" t={trajectories.failing} />
      </Section>

      <p className="ev-small ev-foot">
        Machine-readable: <a href="/evals/report.json">/evals/report.json</a>
      </p>
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="ev-page">
      <nav className="ev-nav">
        <a className="wordmark" href="/">
          Lumina
        </a>
        <a href="/">Ask a question</a>
      </nav>
      <main className="ev-main">{children}</main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ev-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, children, numeric = [] }: { head: string[]; children: ReactNode; numeric?: number[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={numeric.includes(i) ? 'num' : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function RubricTable({ rows, caption }: { rows: RubricRow[]; caption: string }) {
  if (!rows.length) return null;
  return (
    <Table head={[caption, 'Points', 'Awarded', 'Result', 'Evidence']} numeric={[1, 2]}>
      {rows.map((r) => (
        <tr key={r.id} className={r.status === 'fail' ? 'fail' : undefined}>
          <td>{r.label}</td>
          <td className="num">{r.points}</td>
          <td className="num">{r.awarded}</td>
          <td>
            <Mark s={r.status} />
          </td>
          <td>{r.evidence}</td>
        </tr>
      ))}
    </Table>
  );
}

function TrajectoryView({ label, t }: { label: string; t: Trajectory }) {
  return (
    <article className="traj">
      <h3>{label}</h3>
      <p className="ev-small">
        Request <code>{t.requestId}</code>
        {t.depth ? `, ${t.depth} search` : ''}
        {t.terminated ? `, ended ${t.terminated}` : ''}
      </p>
      {t.query ? <p className="traj-q">{t.query}</p> : null}
      <ol className="steps">
        {t.steps.map((s) => (
          <li key={s.step} className={`step${s.ok ? '' : ' failed'}`}>
            <span className="step-n">{s.step}</span>
            <div className="step-body">
              <div className="step-head">
                <code className="step-what">{s.tool}</code>
                {s.subQuestion ? <span className="subtag">part {s.subQuestion}</span> : null}
                {s.ms !== undefined ? <span className="step-ms">{Math.round(s.ms)} ms</span> : null}
              </div>
              {s.ok ? (s.reason ? <div className="step-why">{s.reason}</div> : null) : <div className="step-err">{s.error ?? 'Failed'}</div>}
            </div>
          </li>
        ))}
      </ol>
      <div className="traj-notes">
        <h4>What it taught me</h4>
        <p>{t.notes}</p>
      </div>
    </article>
  );
}

function Mark({ s }: { s: string }) {
  if (s === 'pass') return <span className="m-pass">Pass</span>;
  if (s === 'fail') return <span className="m-fail">Fail</span>;
  if (s === 'partial') return <span className="m-part">Partial</span>;
  return <span className="m-other">{s}</span>;
}

const round = (n: number) => (Number.isInteger(n) ? n : Number(n.toFixed(3)));

function embedUrl(url: string): string {
  const yt = /(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]{11})/.exec(url);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const loom = /loom\.com\/share\/([\w]+)/.exec(url);
  if (loom) return `https://www.loom.com/embed/${loom[1]}`;
  return url;
}
