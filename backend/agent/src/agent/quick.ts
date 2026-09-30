/**
 * The quick gear: the default, and the one that keeps the product economic.
 *
 * The loop is plan → act → observe → repeat → answer, but the FIRST action is decided by the
 * harness rather than the model, because it is always the same (look up the question) and a
 * model round-trip to decide it would cost a second of TTFT on every answer. From there the
 * model is in charge: it sees the sources and either answers or calls another tool
 * (another search, a specific page, save_memory), inside the quick budget.
 *
 * `plan_research` is not in the quick toolbelt at all. A prompt asking the model not to call
 * it would be a suggestion; leaving it out of the list is the gate.
 */
import { env } from '../env.js';
import * as llm from '../providers/llm.js';
import { AnswerWriter, formatSources } from './answer.js';
import { CapReached, type RunCtx, type Src } from './context.js';
import { QUICK_TOOLS, quickSystem } from './prompts.js';
import { fetchOne, recallMemory, researchDocs, researchWeb, saveMemory, type WebResearch } from './tools.js';

const MAX_TURNS = 5;

export async function runQuick(ctx: RunCtx, history: llm.LlmMessage[]): Promise<AnswerWriter> {
  const { query, mode, spaceId } = ctx.init;

  // ---- first action, in parallel: memory + retrieval, routed by mode
  const memP = recallMemory(ctx, 1);
  const retrieval = (async (): Promise<{ docs: Src[]; web: WebResearch | null }> => {
    if (mode === 'docs') {
      if (!spaceId) return { docs: [], web: null };
      const d = await researchDocs(ctx, query, { reason: 'mode=docs: searching the Space', order: 2000 });
      return { docs: d.sources, web: null };
    }
    if (mode === 'auto' && spaceId) {
      const d = await researchDocs(ctx, query, {
        reason: 'mode=auto: a Space is attached, checking its documents first',
        order: 2000,
        decide: (best) =>
          best >= env.autoDocMinScore
            ? `documents look relevant (best ${best.toFixed(2)} ≥ ${env.autoDocMinScore}): answering from the Space`
            : `documents look weak (best ${best.toFixed(2)} < ${env.autoDocMinScore}): also searching the web`
      });
      if (d.sources.length && d.bestScore >= env.autoDocMinScore) return { docs: d.sources, web: null };
      const w = await researchWeb(ctx, query, {
        pages: env.quickPagesPerSearch,
        reason: 'mode=auto: blending the web in because the Space did not clearly answer',
        pipeline: true,
        order: 3000
      });
      return { docs: d.sources, web: w };
    }
    const w = await researchWeb(ctx, query, {
      pages: env.quickPagesPerSearch,
      reason: mode === 'web' ? 'mode=web: searching for the question as asked' : 'mode=auto: no Space attached, searching the web',
      pipeline: true,
      order: 2000
    });
    return { docs: [], web: w };
  })();

  const [memories, found] = await Promise.all([memP, retrieval]);
  ctx.mark('retrievalDone');
  ctx.addSources(found.docs);
  if (found.web) ctx.addSources(found.web.sources);

  // ---- the model's turn(s)
  const verifyDeadline = new Promise<void>((r) => setTimeout(r, env.verifyWaitMs));
  const writer = new AnswerWriter(ctx, async () => {
    // Sources go out before the first token. Give the page fetches a short window to verify
    // snippets first; a slow publisher does not get to hold the whole answer hostage.
    if (found.web) await Promise.race([found.web.settled, verifyDeadline]);
  });

  const system = quickSystem(memories, Boolean(spaceId));
  const messages: llm.LlmMessage[] = [
    ...history,
    { role: 'user', content: `${formatSources(ctx.sources, env.pageCharsQuick)}\n\nQUESTION: ${query}` }
  ];
  const tools = QUICK_TOOLS(Boolean(spaceId));

  ctx.mark('llmStart');
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const lastTurn = turn === MAX_TURNS - 1;
    const turnResult = await llm.stream(
      {
        model: env.llmModel,
        system,
        messages,
        maxTokens: env.maxAnswerTokens,
        tools,
        toolChoice: ctx.capHit || lastTurn || ctx.remainingToolCalls() === 0 ? { type: 'none' } : { type: 'auto' },
        signal: ctx.signal
      },
      { onHedge: () => ctx.mark('llmHedged'), onHeaders: () => ctx.mark('llmHeaders'), onText: (d) => { ctx.mark('llmFirstText'); writer.onText(d); } }
    );
    ctx.addLlmUsage(env.llmModel, turnResult.tokensIn, turnResult.tokensOut);
    const uses = turnResult.content.filter((b): b is Extract<llm.ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    await writer.endTurn(uses.length > 0);
    if (!uses.length) break;

    messages.push({ role: 'assistant', content: turnResult.content });
    const results: llm.ContentBlock[] = [];
    for (const u of uses) {
      const content = await executeTool(ctx, u.name, u.input);
      results.push({ type: 'tool_result', tool_use_id: u.id, content });
    }
    messages.push({ role: 'user', content: results });
  }

  await writer.finish();
  return writer;
}

async function executeTool(ctx: RunCtx, name: string, input: Record<string, unknown>): Promise<string> {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const frozen = 'The answer has already started, so the source list is fixed. Finish the answer from the sources you have.';
  const capped = 'Tool-call cap reached. Answer now from the sources you have, and say if they are not enough.';

  switch (name) {
    case 'save_memory': {
      const r = await saveMemory(ctx, str(input.text));
      return r.ok ? `Saved to long-term memory (${r.message}). Now answer the user.` : `Not saved: ${r.message}.`;
    }
    case 'web_search': {
      if (ctx.sourcesFrozen) return frozen;
      if (ctx.remainingToolCalls() < 2) {
        ctx.capHit ??= new CapReached('tool-calls');
        return capped;
      }
      const q = str(input.query) || ctx.init.query;
      const w = await researchWeb(ctx, q, {
        pages: Math.min(2, ctx.remainingToolCalls() - 1),
        reason: 'the model asked for another search',
        pipeline: false
      });
      const added = ctx.addSources(w.sources);
      return added.length ? formatSources(added, env.pageCharsQuick) : 'No new readable pages for that query.';
    }
    case 'fetch_page': {
      if (ctx.sourcesFrozen) return frozen;
      const src = await fetchOne(ctx, str(input.url), ctx.init.query);
      if (ctx.capHit) return capped;
      if (!src) return 'Could not read that page.';
      const added = ctx.addSources([src]);
      return added.length ? formatSources(added, env.pageCharsQuick) : 'That page is already in the sources.';
    }
    case 'search_documents': {
      if (ctx.sourcesFrozen) return frozen;
      const d = await researchDocs(ctx, str(input.query) || ctx.init.query, { reason: 'the model asked to search the Space' });
      if (ctx.capHit) return capped;
      const added = ctx.addSources(d.sources);
      return added.length ? formatSources(added, env.pageCharsQuick) : 'No new passages in the Space for that query.';
    }
    default:
      // Includes plan_research: it is not offered on a quick run, and is refused if asked for.
      return `The tool "${name}" is not available here.`;
  }
}
