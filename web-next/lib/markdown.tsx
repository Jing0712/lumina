import { Fragment, type ReactNode } from 'react';
import type { Source } from '@lumina/contract';

/**
 * A small markdown renderer for answers. It covers what the model actually writes
 * (headings, lists, bold, italic, code, links, tables are left as text) and, the reason it
 * exists, turns every `[n]` into a citation mark tied to its source. A mark whose number
 * resolves to nothing retrieved in this request is drawn as broken, so an ungrounded
 * citation is visible in the product and not only in a grader's report.
 *
 * Streaming-safe: half a `**bold` just renders as text until the closing marker lands.
 */

export interface CiteProps {
  sources: Source[];
  onCite?: (n: number) => void;
  onHover?: (n: number | undefined) => void;
  active?: number;
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      out.push({ kind: 'code', text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*[-*+]\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*[-*+]\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        items.push(item);
      }
      out.push({ kind: 'ul', items });
      continue;
    }
    const ol = /^\s*(\d+)[.)]\s+/.exec(line);
    if (ol) {
      const items: string[] = [];
      const start = Number(ol[1]);
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*\d+[.)]\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*\d+[.)]\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        items.push(item);
      }
      out.push({ kind: 'ol', items, start });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push({ kind: 'quote', text: buf.join(' ') });
      continue;
    }
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4}\s|```|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)
    ) {
      buf.push(lines[i++]!);
    }
    out.push({ kind: 'p', text: buf.join('\n') });
  }
  return out;
}

const INLINE =
  /(\[\d{1,3}\](?:\[\d{1,3}\])*)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;

function inline(text: string, c: CiteProps, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(withBreaks(text.slice(last, at), `${keyBase}-t${k++}`));
    const key = `${keyBase}-m${k++}`;
    if (m[1]) {
      const nums = [...m[1].matchAll(/\[(\d{1,3})\]/g)].map((x) => Number(x[1]));
      out.push(
        <span key={key} className="cites">
          {nums.map((n, j) => (
            <Cite key={j} n={n} {...c} />
          ))}
        </span>
      );
    } else if (m[2]) out.push(<code key={key}>{m[2].slice(1, -1)}</code>);
    else if (m[3]) out.push(<strong key={key}>{inline(m[3].slice(2, -2), c, key)}</strong>);
    else if (m[4]) out.push(<em key={key}>{inline(m[4].slice(1, -1), c, key)}</em>);
    else if (m[5]) {
      const label = m[5].slice(1, m[5].indexOf(']('));
      out.push(
        <a key={key} href={m[6]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(withBreaks(text.slice(last), `${keyBase}-t${k}`));
  return out;
}

function withBreaks(text: string, key: string): ReactNode {
  const parts = text.split('\n');
  return (
    <Fragment key={key}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          {p}
        </Fragment>
      ))}
    </Fragment>
  );
}

function Cite({ n, sources, onCite, onHover, active }: CiteProps & { n: number }) {
  const src = sources.find((s) => s.n === n);
  if (!src) {
    return (
      <span className="cite broken" title={`[${n}] points to nothing retrieved for this answer`}>
        {n}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`cite${active === n ? ' on' : ''}`}
      title={src.title}
      aria-label={`Source ${n}: ${src.title}`}
      onClick={() => onCite?.(n)}
      onMouseEnter={() => onHover?.(n)}
      onMouseLeave={() => onHover?.(undefined)}
      onFocus={() => onHover?.(n)}
      onBlur={() => onHover?.(undefined)}
    >
      {n}
    </button>
  );
}

export function Markdown({ text, ...c }: CiteProps & { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case 'h': {
            const Tag = (b.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4';
            return <Tag key={k}>{inline(b.text, c, k)}</Tag>;
          }
          case 'p':
            return <p key={k}>{inline(b.text, c, k)}</p>;
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, c, `${k}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, c, `${k}-${j}`)}</li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <pre key={k}>
                <code>{b.text}</code>
              </pre>
            );
          case 'quote':
            return <blockquote key={k}>{inline(b.text, c, k)}</blockquote>;
          case 'hr':
            return <hr key={k} />;
        }
      })}
    </div>
  );
}
