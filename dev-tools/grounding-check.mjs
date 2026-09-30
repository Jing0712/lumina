#!/usr/bin/env node
// Re-run the bench's web grounding check (same fetch, same stripHtml, same snippetIsGrounded)
// over recent stored answers, and print every citation that fails, with its snippet. The bench
// only reports a ratio; this says WHICH citation failed and why.
//   node dev-tools/grounding-check.mjs --since 2026-09-30T20:00:00Z  > runs/grounding-check.txt
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';
import { citationNumbers, snippetIsGrounded, normalize } from '../benchmark/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(ROOT, '.env') });
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const since = new Date(arg('since', new Date(Date.now() - 3600e3).toISOString()));

const stripHtml = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
const cache = new Map();
async function page(url) {
  if (cache.has(url)) return cache.get(url);
  let t = null;
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'lumina-bench/0.1 (+course benchmark)' }, signal: AbortSignal.timeout(12000) });
    if (r.ok) t = stripHtml(await r.text());
  } catch { t = null; }
  cache.set(url, t);
  return t;
}

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
let ok = 0, bad = 0, unv = 0;
try {
  await client.connect();
  const msgs = await client.db(process.env.MONGODB_DB ?? 'lumina').collection('messages')
    .find({ role: 'assistant', createdAt: { $gte: since } }, { sort: { createdAt: 1 } }).toArray();
  console.log(`${msgs.length} answer(s) since ${since.toISOString()}`);
  for (const m of msgs) {
    const by = new Map((m.sources ?? []).map((s) => [s.n, s]));
    for (const n of citationNumbers(m.content ?? '')) {
      const s = by.get(n);
      if (!s || s.kind !== 'web') continue;
      const hay = await page(s.url);
      if (!hay) { unv++; continue; }
      if (snippetIsGrounded(s.snippet, hay)) { ok++; continue; }
      bad++;
      console.log('\n✗ UNGROUNDED', m.answerId, `[${n}]`, s.url);
      console.log('  snippet:', JSON.stringify(s.snippet));
      console.log('  snippet tokens:', normalize(s.snippet).split(' ').length, '· page chars:', hay.length);
      const first = normalize(s.snippet).split(' ').slice(0, 6).join(' ');
      const at = normalize(hay).indexOf(first);
      console.log('  first 6 tokens in page?', at > -1, at > -1 ? JSON.stringify(normalize(hay).slice(at, at + 300)) : '');
      console.log('  source fields:', Object.keys(s).join(','), s.verified !== undefined ? `verified=${s.verified}` : '');
    }
  }
  console.log(`\ngrounded ${ok} · ungrounded ${bad} · unverifiable ${unv}`);
} finally { await client.close(); }
