/**
 * Parse and chunk an uploaded file. Every chunk carries a locator: {page} for PDF,
 * {heading, line} for Markdown, {line} for plain text. Chunks never cross a PDF page, so a
 * citation's page number is exact.
 */
import type { Locator } from '@lumina/contract';
import { env } from '../env.js';
import { collapse } from '../util/text.js';

export interface ParsedChunk {
  text: string;
  locator: Locator;
}

export interface Parsed {
  pages?: number;
  chunks: ParsedChunk[];
}

export async function parseDocument(buf: Buffer, mimeType: string): Promise<Parsed> {
  if (mimeType === 'application/pdf') return parsePdf(buf);
  const text = buf.toString('utf8');
  if (mimeType === 'text/markdown') return { chunks: chunkMarkdown(text) };
  return { chunks: chunkPlain(text) };
}

// ---------------------------------------------------------------- pdf

async function parsePdf(buf: Buffer): Promise<Parsed> {
  // A variable specifier keeps TypeScript from resolving pdfjs's own typings (which differ
  // between builds); the legacy build is the one that runs on Node without a DOM.
  const spec = 'pdfjs-dist/legacy/build/pdf.mjs';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import(spec);
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await task.promise;
  const chunks: ParsedChunk[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      page.cleanup();
      for (const piece of chunkText(collapse(text), env.chunkChars, env.chunkOverlap)) {
        chunks.push({ text: piece, locator: { page: p } });
      }
      // Yield between pages so a long PDF never starves a streaming answer on this process.
      await new Promise((r) => setImmediate(r));
    }
    return { pages: doc.numPages, chunks };
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------- markdown & text

function chunkMarkdown(md: string): ParsedChunk[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: { heading: string; line: number; body: string[] }[] = [];
  let current = { heading: '', line: 1, body: [] as string[] };
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    const h = !inFence ? /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw) : null;
    if (h) {
      if (current.body.join('').trim()) sections.push(current);
      current = { heading: (h[2] ?? '').trim(), line: i + 1, body: [raw] };
    } else {
      current.body.push(raw);
    }
  });
  if (current.body.join('').trim()) sections.push(current);

  const out: ParsedChunk[] = [];
  for (const s of sections) {
    const text = collapse(s.body.join('\n').replace(/[*_`>]/g, ' '));
    for (const piece of chunkText(text, env.chunkChars, env.chunkOverlap)) {
      out.push({ text: piece, locator: { ...(s.heading ? { heading: s.heading } : {}), line: s.line } });
    }
  }
  return out;
}

function chunkPlain(txt: string): ParsedChunk[] {
  const lines = txt.replace(/\r\n/g, '\n').split('\n');
  const out: ParsedChunk[] = [];
  let buf: string[] = [];
  let start = 1;
  const flush = () => {
    const text = collapse(buf.join('\n'));
    if (text) for (const piece of chunkText(text, env.chunkChars, env.chunkOverlap)) out.push({ text: piece, locator: { line: start } });
    buf = [];
  };
  lines.forEach((l, i) => {
    if (!buf.length) start = i + 1;
    buf.push(l);
    if (buf.join('\n').length >= env.chunkChars) flush();
  });
  flush();
  return out;
}

/** Split on sentence boundaries into ~size-char pieces with ~overlap chars carried over. */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= size) return [t];
  const sents = t.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sents) {
    if (s.length > size) {
      // A giant "sentence" (a table, a list with no periods): hard-wrap it.
      if (cur) out.push(cur);
      cur = '';
      for (let i = 0; i < s.length; i += size - overlap) out.push(s.slice(i, i + size));
      continue;
    }
    if (cur && cur.length + 1 + s.length > size) {
      out.push(cur);
      const tail = cur.slice(Math.max(0, cur.length - overlap));
      const cut = tail.indexOf(' ');
      cur = cut > -1 ? tail.slice(cut + 1) : '';
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
