// Same as llm-probe, but sends LUMINA's exact quick-answer request shape (system prompt,
// QUICK_TOOLS, tool_choice auto, temperature 0.2) so we can see if the shape is what's slow.
//   npx tsx dev-tools/llm-shape.ts [concurrency=4] [shape|notools|plain|ours]
// 'ours' goes through backend/agent's own llm.stream(), i.e. our exact code path.
import { readFileSync } from 'node:fs';
for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
}
const N = Number(process.argv[2] ?? 4);
const mode = process.argv[3] ?? 'shape';
const { quickSystem, QUICK_TOOLS } = await import('../backend/agent/src/agent/prompts.js');
const model = process.env.LLM_MODEL ?? 'claude-haiku-4-5';
const filler = 'Retrieval systems combine lexical and dense signals. '.repeat(700);

async function one(i: number) {
  const t0 = Date.now();
  if (mode === 'ours') {
    const llm = await import('../backend/agent/src/providers/llm.js');
    let headers = 0; let first: number | null = null;
    await llm.stream(
      { model, system: quickSystem([], false), maxTokens: 1200, tools: QUICK_TOOLS(false), toolChoice: { type: 'auto' },
        messages: [{ role: 'user', content: `SOURCES:\n[1] ${filler}\n\nQUESTION: In 5 sentences, explain hybrid retrieval. (${i}-${Date.now()})` }] },
      { onHeaders: () => { headers = Date.now() - t0; }, onText: () => { if (first === null) first = Date.now() - t0; } }
    );
    return `#${i} headers ${headers}ms · first text ${first}ms · done ${Date.now() - t0}ms`;
  }
  const body: Record<string, unknown> = {
    model, max_tokens: 1200, stream: true,
    messages: [{ role: 'user', content: `SOURCES:\n[1] ${filler}\n\nQUESTION: In 5 sentences, explain hybrid retrieval. (${i}-${Date.now()})` }]
  };
  if (mode !== 'plain') { body.system = quickSystem([], false); body.temperature = 0.2; }
  if (mode === 'shape') { body.tools = QUICK_TOOLS(false); body.tool_choice = { type: 'auto' }; }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const headers = Date.now() - t0;
  if (!res.ok) return `#${i} HTTP ${res.status} ${await res.text()}`;
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let first: number | null = null; let buf = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value);
    if (first === null && buf.includes('text_delta')) first = Date.now() - t0; }
  return `#${i} headers ${headers}ms · first text ${first}ms · done ${Date.now() - t0}ms`;
}
console.log(`model ${model}, mode ${mode}, ${N} at once`);
for (const line of await Promise.all(Array.from({ length: N }, (_, i) => one(i)))) console.log(line);
