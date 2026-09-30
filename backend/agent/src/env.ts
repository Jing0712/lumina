import { config } from 'dotenv';
import { resolve } from 'node:path';

// The single .env at the assignment root. Provider keys are read HERE and nowhere else.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);

const llmModel = process.env.LLM_MODEL ?? 'claude-haiku-4-5';

export const env = {
  port: num(process.env.PORT_AGENT ?? process.env.PORT, 8000),
  mongoUri: process.env.MONGODB_URI ?? '',
  mongoDb: process.env.MONGODB_DB ?? 'lumina',
  vectorBackend: (process.env.VECTOR_BACKEND ?? 'atlas-vector-search') as
    | 'atlas-vector-search'
    | 'mongo-cosine-scan',

  llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
  /** The quick gear's model: it is on the TTFT path, so it should be a fast one. */
  llmModel,
  /** The planner runs before deep's first paint (deep_plan_p95_ms), so it is fast too. */
  llmModelPlanner: process.env.LLM_MODEL_PLANNER ?? llmModel,
  /** Deep synthesis: the one place a stronger (slower, pricier) model earns its cost. */
  llmModelDeep: process.env.LLM_MODEL_DEEP ?? 'claude-sonnet-4-5',
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 60000),
  /** Streamed LLM calls: if no response headers after this many ms, send one duplicate request
   *  and keep whichever answers first (0 disables). Cuts the provider's tail latency. */
  llmHedgeMs: num(process.env.LLM_HEDGE_MS, 1200),
  maxAnswerTokens: num(process.env.MAX_ANSWER_TOKENS, 900),
  maxDeepAnswerTokens: num(process.env.MAX_DEEP_ANSWER_TOKENS, 2200),

  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily') as 'tavily' | 'serpapi',
  searchCacheTtlSeconds: num(process.env.SEARCH_CACHE_TTL_SECONDS, 21600),
  searchResults: num(process.env.SEARCH_RESULTS, 4),
  /** Tavily search_depth: 'fast' trades a little ranking for latency (web_search sits on the
   *  critical path of every uncached quick answer). 'basic' | 'fast' | 'ultra-fast' | 'advanced'. */
  searchDepth: process.env.SEARCH_DEPTH ?? 'fast',
  searchTimeoutMs: num(process.env.SEARCH_TIMEOUT_MS, 12000),

  /** Pages read per search: quick reads a few, deep reads a few per sub-question. */
  quickPagesPerSearch: num(process.env.QUICK_PAGES_PER_SEARCH, 3),
  deepPagesPerSubQuestion: num(process.env.DEEP_PAGES_PER_SUB_QUESTION, 4),
  fetchTimeoutMs: num(process.env.FETCH_TIMEOUT_MS, 2500),
  /** How long the first token may wait for snippet verification before sources go out anyway. */
  verifyWaitMs: num(process.env.VERIFY_WAIT_MS, 600),
  pageCharsQuick: num(process.env.PAGE_CHARS_QUICK, 3000),
  pageCharsDeep: num(process.env.PAGE_CHARS_DEEP, 3500),

  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',

  // RAG. Declared in config, not hard-coded (SPEC 5.4).
  ragTopK: num(process.env.RAG_TOP_K, 6),
  ragCandidates: num(process.env.RAG_CANDIDATES, 20),
  ragNumCandidates: num(process.env.RAG_NUM_CANDIDATES, 200),
  ragRrfK: num(process.env.RAG_RRF_K, 60),
  /** mode=auto: a best cosine similarity below this also searches the web (blend). */
  autoDocMinScore: num(process.env.AUTO_DOC_MIN_SCORE, 0.35),
  chunkChars: num(process.env.CHUNK_CHARS, 1000),
  chunkOverlap: num(process.env.CHUNK_OVERLAP, 150),

  memoryTopK: num(process.env.MEMORY_TOP_K, 8),
  /**
   * Cosine floor for recall. Off (-1) by default: a stated preference ("answer in British
   * English") is relevant to every question yet semantically close to none, so recall returns
   * the top-K nearest memories and the prompt caps how much of them is injected.
   */
  memoryMinScore: num(process.env.MEMORY_MIN_SCORE, -1),

  // Deep search is the expensive gear, so its limits are configuration, not code.
  deepSubQuestionsMin: num(process.env.DEEP_SUB_QUESTIONS_MIN, 3),
  deepSubQuestionsMax: num(process.env.DEEP_SUB_QUESTIONS_MAX, 6),
  /** How many the planner is asked for. Fewer, sharper sub-questions plan faster (deep_plan_p95_ms). */
  deepSubQuestionsTarget: num(process.env.DEEP_SUB_QUESTIONS_TARGET, 4),
  deepDailyCap: num(process.env.DEEP_DAILY_CAP, 5),
  deepConcurrency: num(process.env.DEEP_CONCURRENCY, 4),

  // The hard caps from AGENTS.md. Raising these to make a gate pass is the failure mode
  // the caps exist to catch. Two gears, two envelopes.
  maxToolCalls: num(process.env.MAX_TOOL_CALLS, 8),
  maxWallClockSec: num(process.env.MAX_WALL_CLOCK_SEC, 90),
  maxToolCallsDeep: num(process.env.MAX_TOOL_CALLS_DEEP, 24),
  maxWallClockSecDeep: num(process.env.MAX_WALL_CLOCK_SEC_DEEP, 240),

  // Prices (USD). Defaults are the published list prices at the time of writing; override
  // them in .env if your provider's rates differ. They only feed costUsd, never a decision.
  priceSearchPerCall: num(process.env.PRICE_SEARCH_PER_CALL, 0.008),
  priceEmbeddingPerMTok: num(process.env.PRICE_EMBEDDING_PER_MTOK, 0.02),

  /** Run the jobs worker inside this process. Set false and `npm run worker` to split it out. */
  embeddedWorker: bool(process.env.EMBEDDED_WORKER, true),
  workerPollMs: num(process.env.WORKER_POLL_MS, 1000),
  jobStaleSec: num(process.env.JOB_STALE_SEC, 300),
  jobMaxAttempts: num(process.env.JOB_MAX_ATTEMPTS, 3),
  probeTimeoutMs: num(process.env.PROBE_TIMEOUT_MS, 120000),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Where the per-answer run logs land. quality/check.mjs reads this folder. */
  runsDir: process.env.RUNS_DIR ?? resolve(process.cwd(), '../../runs')
} as const;

/** Never log or return these. /health names the model; it never echoes a key. */
export const secrets = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  openai: process.env.OPENAI_API_KEY ?? '',
  tavily: process.env.TAVILY_API_KEY ?? '',
  serpapi: process.env.SERPAPI_API_KEY ?? ''
} as const;

/** USD per million tokens, by model family. LLM_PRICE_IN / LLM_PRICE_OUT override all of them. */
export function llmPrice(model: string): { in: number; out: number } {
  const overrideIn = process.env.LLM_PRICE_IN;
  const overrideOut = process.env.LLM_PRICE_OUT;
  let p = { in: 3, out: 15 };
  if (/haiku-4/.test(model)) p = { in: 1, out: 5 };
  else if (/haiku/.test(model)) p = { in: 0.8, out: 4 };
  else if (/opus-4-[5-9]|opus-[5-9]/.test(model)) p = { in: 5, out: 25 };
  else if (/opus/.test(model)) p = { in: 15, out: 75 };
  return { in: num(overrideIn, p.in), out: num(overrideOut, p.out) };
}
