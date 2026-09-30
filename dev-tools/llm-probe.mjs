#!/usr/bin/env node
// Is the provider slow under concurrency, or is our server? This bypasses LUMINA entirely:
// N streamed Anthropic calls at once with a ~4k-token prompt, timing headers and first text.
//   node dev-tools/llm-probe.mjs [concurrency=4] [model=claude-haiku-4-5]
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const N = Number(process.argv[2] ?? 4);
const model = process.argv[3] ?? env.LLM_MODEL ?? 'claude-haiku-4-5';
const filler = 'Retrieval systems combine lexical and dense signals. '.repeat(700); // ~4k tokens

async function one(i) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 300, stream: true, messages: [{ role: 'user', content: `${filler}\n\nIn 5 sentences, explain hybrid retrieval. (${i}-${Date.now()})` }] })
  });
  const headers = Date.now() - t0;
  if (!res.ok) return `#${i} HTTP ${res.status} ${await res.text()}`;
  const reader = res.body.getReader(); const dec = new TextDecoder(); let first = null; let buf = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value);
    if (first === null && buf.includes('text_delta')) first = Date.now() - t0; }
  return `#${i} headers ${headers}ms · first text ${first}ms · done ${Date.now() - t0}ms · rl-remaining ${res.headers.get('anthropic-ratelimit-input-tokens-remaining')}`;
}
console.log(`model ${model}, ${N} at once`);
for (const line of await Promise.all(Array.from({ length: N }, (_, i) => one(i)))) console.log(line);
