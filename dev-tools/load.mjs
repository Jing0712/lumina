#!/usr/bin/env node
// Quick concurrency probe (not part of the graded bench): N fresh quick questions at
// concurrency C through the gateway, printing TTFT and total per answer.
//   node dev-tools/load.mjs [concurrency=4]
import { ask, makeClient, pool, percentile } from '../benchmark/lib.mjs';

const C = Number(process.argv[2] ?? 4);
const stamp = new Date().toISOString().slice(11, 19);
const questions = [
  'What is the Raft consensus algorithm?',
  'How does HTTP/3 differ from HTTP/2?',
  'What is a bloom filter used for?',
  'What does the CAP theorem state?',
  'How does a B-tree index work in databases?',
  'What is vector quantization in embeddings?',
  'What is the difference between OLTP and OLAP?',
  'How does TLS 1.3 reduce handshake latency?'
].map((q) => `${q} (${stamp})`);

const client = makeClient({ target: process.env.TARGET ?? 'http://localhost:8787', userId: 'loadtest' });
const { threadId } = await client.post('/threads', {});
const t0 = Date.now();
const results = await pool(
  questions.map((query) => async () => ask(client, threadId, { query, mode: 'web', userId: 'loadtest' })),
  C
);
for (const r of results) {
  if (!r.ok) { console.log('ERR', r.error.message); continue; }
  const a = r.value;
  console.log(`ttft ${String(a.ttftMs).padStart(6)}ms  total ${String(a.latencyMs).padStart(6)}ms  ${a.requestId}  ${a.error ? 'ERROR ' + a.error.error : ''}`);
}
const ok = results.filter((r) => r.ok).map((r) => r.value);
console.log(`\nconcurrency ${C}: ttft p50 ${percentile(ok.map((a) => a.ttftMs), 50)}ms  p95 ${percentile(ok.map((a) => a.ttftMs), 95)}ms  · wall ${Date.now() - t0}ms`);
