# web-next — Lumina's own UI (Next.js)

A replacement for the provided `web/` (stretch goal: "your own UI, Next.js on Vercel, still
passing the contract"). `web/` is left untouched, as the red lines require; this app lives
beside it and compiles against the same `@lumina/contract` types.

## What it does

Everything the provided UI does, against the same routes:

- `/` asks a question and streams the answer. Sources arrive before the first word and show
  as a strip above the answer; every `[n]` becomes a citation mark, and a number with no
  matching source is drawn as broken.
- Quick or deep search, with today's deep allowance from `/stats`. A deep search shows its
  research plan first, and the Steps tab draws the run as a tree, one branch per
  sub-question, with the time each branch took.
- An answer reused by the semantic answer cache is labelled as such (`answerCached`).
- Threads, Spaces (create, upload with drag and drop, status polling until indexed), and
  memory (list and delete).
- `/evals` renders `GET /evals/report.json`, validated against `EvalsReport`, with every
  section of the original page. `/evals/report.json` on this origin is rewritten to the
  gateway's, so the machine-readable link works from the submitted URL.

The browser talks only to the gateway (`NEXT_PUBLIC_API_URL`), directly, so the answer
stream is never buffered by a second proxy. No key is read anywhere in this app.

## Run it locally

```bash
npm install                      # from the repo root
npm run build -w @lumina/contract
NEXT_PUBLIC_API_URL=http://localhost:8787 npm run dev -w @lumina/web-next   # http://localhost:5174
```

Add `http://localhost:5174` to the gateway's `CORS_ORIGINS` (comma-separated) while you do.

## Deploy to Vercel

1. New Vercel project from this repo. **Root Directory: `web-next`** (keep "Include files
   outside the root directory" on; `vercel.json` here installs and builds from the repo root).
2. Environment variable: `NEXT_PUBLIC_API_URL=https://<your-gateway>.fly.dev`.
3. Deploy, then add the new Vercel URL to the gateway's `CORS_ORIGINS` and redeploy the
   gateway. Without this step every request from the new UI is blocked by the browser.
4. Open `/` and `/evals` on the new URL. That URL is what you submit.
