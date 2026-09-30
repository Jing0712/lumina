import { config } from 'dotenv';
import { resolve } from 'node:path';

// Both services read the single .env at the assignment root. No provider key is read here.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: num(process.env.PORT_GATEWAY ?? process.env.PORT, 8787),
  agentUrl: (process.env.AGENT_URL ?? 'http://localhost:8000').replace(/\/$/, ''),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Asks per user per minute. The bench runs ~40 asks at concurrency 4: size this for it. */
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
  /** Every other route (listing, polling upload status) gets this multiple of the ask limit. */
  rateLimitOtherMultiplier: num(process.env.RATE_LIMIT_OTHER_MULTIPLIER, 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Serve the built UI from the gateway in production so one host serves / and /evals. */
  webDist: resolve(process.cwd(), process.env.WEB_DIST ?? '../../web/dist'),
  /** The eval skill's output, served at GET /evals/report.json. */
  reportPath: resolve(process.cwd(), process.env.REPORT_PATH ?? '../../reports/report.json'),
  upstreamTimeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 30000)
} as const;
