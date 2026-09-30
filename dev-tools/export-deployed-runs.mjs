#!/usr/bin/env node
// Like scripts/export-runs.mjs (same RunLog shape, same fields), but only runs created at or
// after --since. The `runs` collection is shared by local dev and the deployed agent, so the
// plain export mixes pre-deploy local runs into a deployed eval.
//   node dev-tools/export-deployed-runs.mjs --since 2026-09-30T10:20:00Z
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { MongoClient } from 'mongodb';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: join(ROOT, '.env') });
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const since = new Date(arg('since', ''));
if (Number.isNaN(since.getTime())) { console.error('usage: --since <ISO time>'); process.exit(2); }
const outDir = resolve(ROOT, arg('out', 'runs'));
mkdirSync(outDir, { recursive: true });

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  const runs = await client.db(process.env.MONGODB_DB ?? 'lumina').collection('runs')
    .find({ createdAt: { $gte: since } }, { sort: { createdAt: -1 } }).toArray();
  for (const run of runs) {
    const id = run.requestId ?? String(run._id);
    const { tokens, wallClockSec, costUsd, terminated, toolCalls } = run;
    writeFileSync(join(outDir, `${id}.json`), JSON.stringify({ tokens, wallClockSec, costUsd, terminated, toolCalls }, null, 2));
  }
  console.log(`wrote ${runs.length} run log(s) created since ${since.toISOString()} to ${outDir}`);
} finally {
  await client.close();
}
