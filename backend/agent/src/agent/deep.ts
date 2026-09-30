/**
 * The deep gear: Perplexity's Pro Search.
 *
 *   plan_research → `plan` event (before ANY retrieval) → research each sub-question in
 *   parallel, every step tagged with its sub-question → merge into one numbering → one
 *   structured, cited synthesis.
 *
 * The tool budget is allocated up front from the plan (so the fan-out fits inside the deep
 * cap by construction), and pages another sub-question already claimed are skipped, so deep
 * reads wider rather than re-reading the same two pages.
 */
import type { SubQuestion } from '@lumina/contract';
import { env } from '../env.js';
import * as llm from '../providers/llm.js';
import { normalize } from '../util/text.js';
import { AnswerWriter, formatSources } from './answer.js';
import type { RunCtx, Src } from './context.js';
import { PLAN_TOOL, deepSynthesisSystem, plannerSystem } from './prompts.js';
import { recallMemory, researchDocs, researchWeb } from './tools.js';

export interface Plan {
  subQuestions: SubQuestion[];
  reason?: string;
}

export async function runDeep(ctx: RunCtx, history: llm.LlmMessage[]): Promise<{ writer: AnswerWriter; plan: Plan }> {
  const { query, mode, spaceId } = ctx.init;

  // ---- plan first; memory recall runs alongside (it is not retrieval)
  const [plan, memories] = await Promise.all([planResearch(ctx, history), recallMemory(ctx, 1)]);
  ctx.init.stream.send('plan', plan);
  ctx.init.stream.open(); // the plan is deep search's first paint

  // ---- allocate the budget from the plan
  const n = plan.subQuestions.length;
  const searchesPer = mode === 'auto' && spaceId ? 2 : 1;
  const pages =
    mode === 'docs'
      ? 0
      : Math.max(1, Math.min(env.deepPagesPerSubQuestion, Math.floor((ctx.remainingToolCalls() - n * searchesPer) / n)));

  // ---- fan out, bounded concurrency
  const claimed = new Set<string>();
  const perSub: Src[][] = new Array(n).fill(null).map(() => []);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= n) return;
      const sq = plan.subQuestions[idx] as SubQuestion;
      perSub[idx] = await researchSub(ctx, sq, pages, claimed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(env.deepConcurrency, n) }, worker));

  // ---- merge: one numbering, deduped, in plan order
  for (const list of perSub) ctx.addSources(list);

  const writer = new AnswerWriter(ctx);
  await writer.commit(); // sources go out as soon as the research is merged

  const planText = plan.subQuestions.map((s) => `${s.i}. ${s.question}${s.reason ? ` — ${s.reason}` : ''}`).join('\n');
  const messages: llm.LlmMessage[] = [
    ...history,
    {
      role: 'user',
      content: `QUESTION: ${query}\n\nRESEARCH PLAN:\n${planText}\n\n${formatSources(ctx.sources, env.pageCharsDeep, true)}\n\nWrite the structured answer now.`
    }
  ];
  const turn = await llm.stream(
    {
      model: env.llmModelDeep,
      system: deepSynthesisSystem(memories),
      messages,
      maxTokens: env.maxDeepAnswerTokens,
      signal: ctx.signal
    },
    { onText: writer.onText }
  );
  ctx.addLlmUsage(env.llmModelDeep, turn.tokensIn, turn.tokensOut);
  await writer.finish();
  return { writer, plan };
}

async function researchSub(ctx: RunCtx, sq: SubQuestion, pages: number, claimed: Set<string>): Promise<Src[]> {
  const { mode, spaceId } = ctx.init;
  const order = sq.i * 100_000;
  const label = `sub-question ${sq.i}`;

  if (mode === 'docs') {
    if (!spaceId) return [];
    const d = await researchDocs(ctx, sq.question, { subQuestion: sq.i, reason: `${label}: searching the Space`, limit: 4, order });
    return d.sources;
  }
  if (mode === 'auto' && spaceId) {
    const d = await researchDocs(ctx, sq.question, {
      subQuestion: sq.i,
      reason: `${label}: checking the Space first`,
      limit: 4,
      order,
      decide: (best) => (best >= env.autoDocMinScore ? 'documents answer it' : 'documents weak, also searching the web')
    });
    if (d.sources.length && d.bestScore >= env.autoDocMinScore) return d.sources;
    const w = await researchWeb(ctx, sq.question, { pages, subQuestion: sq.i, reason: `${label}: web`, claimed, order: order + 50_000 });
    return [...d.sources, ...w.sources];
  }
  const w = await researchWeb(ctx, sq.question, { pages, subQuestion: sq.i, reason: `${label}: searching the web`, claimed, order });
  return w.sources;
}

/** plan_research: decompose the question. Deep only — it is never offered to a quick run. */
async function planResearch(ctx: RunCtx, history: llm.LlmMessage[]): Promise<Plan> {
  const min = env.deepSubQuestionsMin;
  const max = env.deepSubQuestionsMax;
  if (!ctx.reserve()) throw new Error('no tool budget left to plan');
  const t0 = Date.now();

  const ask = async (extra?: string) => {
    const r = await llm.complete({
      model: env.llmModelPlanner,
      system: plannerSystem(min, max),
      messages: [...history.slice(-2), { role: 'user', content: extra ? `${ctx.init.query}\n\n${extra}` : ctx.init.query }],
      tools: [PLAN_TOOL(min, max)],
      toolChoice: { type: 'tool', name: 'plan_research' },
      maxTokens: 900,
      temperature: 0.3,
      signal: ctx.signal
    });
    ctx.addLlmUsage(env.llmModelPlanner, r.tokensIn, r.tokensOut);
    const use = r.content.find((b) => b.type === 'tool_use');
    const input = (use && use.type === 'tool_use' ? use.input : {}) as {
      reason?: unknown;
      subQuestions?: { question?: unknown; reason?: unknown }[];
    };
    const seen = new Set<string>();
    const subs = (Array.isArray(input.subQuestions) ? input.subQuestions : [])
      .map((s) => ({ question: String(s?.question ?? '').trim(), reason: String(s?.reason ?? '').trim() }))
      .filter((s) => {
        const k = normalize(s.question);
        if (!k || seen.has(k) || k === normalize(ctx.init.query)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, max);
    return { subs, reason: typeof input.reason === 'string' ? input.reason : undefined };
  };

  let out;
  try {
    out = await ask();
    if (out.subs.length < min) {
      out = await ask(`Your previous plan had ${out.subs.length} usable sub-question(s). Give at least ${min}, each a distinct facet.`);
    }
  } catch (err) {
    ctx.trace('plan_research', { query: ctx.init.query }, { ok: false, ms: Date.now() - t0, error: (err as Error).message, order: 0 });
    throw err;
  }
  if (out.subs.length < 2) {
    const msg = `planner returned ${out.subs.length} sub-question(s)`;
    ctx.trace('plan_research', { query: ctx.init.query }, { ok: false, ms: Date.now() - t0, error: msg, order: 0 });
    throw new llm.ProviderError('anthropic', msg);
  }

  const subQuestions: SubQuestion[] = out.subs.map((s, i) => ({ i: i + 1, question: s.question, ...(s.reason ? { reason: s.reason } : {}) }));
  ctx.trace(
    'plan_research',
    { query: ctx.init.query },
    { ok: true, ms: Date.now() - t0, order: 0, reason: `${subQuestions.length} sub-questions${out.reason ? `: ${out.reason}` : ''}` }
  );
  return { subQuestions, ...(out.reason ? { reason: out.reason } : {}) };
}
