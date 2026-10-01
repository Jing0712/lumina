# Gateway integration and Person 1 handoff

Checked on 2026-10-01 against main commit `204db70`.

Person 1's scope here is the gateway, service integration, and design handoff. The
agent, search, memory, document worker, and deep-search implementations already
existed in the team repository. This branch preserves those implementations and
the provided UI, contracts, benchmark, and grader.

## What this branch completes

- Authenticate API requests before parsing JSON, including malformed requests.
- Preserve request IDs, per-user limits, CORS, request logs, multipart bytes, and
  the contract's success and error statuses.
- Validate upstream JSON against the provided response schemas. Invalid JSON,
  unexpected success shapes/statuses, and upstream server failures become 502.
- Never replay a state-changing request after a connection reset. Only safe
  reads can retry once, preventing duplicate threads, uploads, or model spend.
- Require a real SSE response for an answer. Forward its bytes promptly, honor
  backpressure, recognize split terminal frames, and report interrupted or
  incomplete streams as visible error events.
- Apply a deadline to the entire answer, not just its headers, and cancel
  upstream requests when the client disconnects.
- Validate public health data and avoid exposing arbitrary upstream fields.
- Build the provided UI inside the gateway deployment image so its static
  `/` and `/evals` fallback can work without a separately prebuilt `web/dist`.
- Add a provider-free, real-HTTP regression suite using a local mock agent.

`src/app.ts` exports the Express application for testing. `src/index.ts` only
starts the server and configures its connection timeouts. The existing
`DESIGN.md` already answers all five required design questions and is unchanged.

## Run the checks

From the repository root, on Node 20.19 or newer:

```sh
npm ci
npm run test -w @lumina/gateway
npm run build
npm run typecheck
npm run lint
```

All 32 gateway tests, the workspace build, type checking, and lint passed locally.
The tests cover both quick and deep SSE *transport*. They do not establish that
the real agent's deep-search planning or synthesis satisfies the rubric.
Temporary UI/report fixtures are test data, not submission evidence.

## Configuration and operational limits

The gateway reads no provider keys. Configure the agent separately.

| Setting | Default | Purpose |
| --- | --- | --- |
| `AGENT_URL` | `http://localhost:8000` | Agent service address; private address in production |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated permitted UI origins |
| `RATE_LIMIT_PER_MINUTE` | `30` | Per-user answer limit |
| `RATE_LIMIT_OTHER_MULTIPLIER` | `10` | Separate allowance for other API requests |
| `UPSTREAM_TIMEOUT_MS` | `30000` | JSON request deadline |
| `UPSTREAM_ASK_TIMEOUT_MS` | `255000` | Whole answer deadline; deep cap plus 15 seconds |
| `WEB_DIST` | `../../web/dist` | Built UI directory, relative to the gateway working directory |
| `REPORT_PATH` | `../../reports/report.json` | Generated evaluation report, relative to that same directory |

Uploads have at least a 120-second transport deadline; the agent owns actual
file-size enforcement. The general gateway rate limiter is in memory and
per instance; it is not a distributed spend control. The deep daily spend cap
must remain in the agent's persistent store. `X-User-Id` is the assignment's
identity convention, not production login authentication.

## Team progress and remaining ownership

| Owner | Existing progress | Remaining verification/work |
| --- | --- | --- |
| Person 1: gateway/design/integration | Gateway hardened and 32 regressions passing; five-section design exists | Review/merge this branch, deploy, and repeat live checks; submission cannot be signed off yet |
| Person 2: quick search/cache/citations | Search, fetch, quick loop, and two-tier cache implemented | Fix the measured grounding failure; rerun the full cache workload |
| Person 3: threads/memory/state | Persistence and semantic memory implemented; live read endpoints matched the schemas | Verify follow-ups, explicit save, cross-thread recall, deletion, user isolation, and export real run logs |
| Person 4: documents/RAG/worker | All four corpus files indexed; all three sampled retrieval questions hit | Run the full 39-question set, Space isolation, interrupted-job recovery, and concurrent-ingestion latency checks |
| Person 5: deep search/evaluation | Deep planner, research fan-out, synthesis, and usage cap implemented | Verify plan ordering, tagged traces, source ratio, caps, and full evidence/report generation |

Deep-search code-review risk: `backend/agent/src/agent/deep.ts` currently runs
memory recall alongside planning and queues traces before sending/opening the
`plan` event. Check that the real deep stream emits `plan` first and performs no
retrieval before it, as required by the contract. This agent behavior was not
changed by the gateway branch.

## Deployed smoke evidence, not a full evaluation

Command run against the existing deployed gateway:

```sh
node benchmark/bench.mjs --smoke --target https://lumina-gateway-jc0930.fly.dev
```

The local result is `reports/bench.json`, timestamp
`2026-10-01T13:22:53.030Z`. It is ignored by Git, as required. It describes the
previous deployment, not the new local branch.

| Measurement | Observed | Required | Outcome |
| --- | --- | --- | --- |
| First-token p95 | 2,098 ms | <= 2,500 ms | Pass |
| Answer p95 | 4,129 ms | <= 12,000 ms | Pass |
| Quick mean cost | $0.00796 | <= $0.05 | Pass |
| Answer error rate | 0% | <= 1% | Pass |
| Citation grounding | 13/14 verifiable citations, 92.9% | >= 95% | **Fail** |
| Sampled document recall | 3/3 | Full benchmark required | Smoke only |
| Upload acceptance p95 | 214 ms | < 300 ms | Pass |

Two additional checked citations were unverifiable, and no citations lacked a
matching source. Sources preceded tokens in every answer. All four corpus
documents reached `indexed`. Deep, full-workload cache performance, and
concurrent-ingestion isolation were not measured by this smoke run.

The benchmark exited nonzero on grounding. Running `node quality/check.mjs .`
afterward also failed that threshold; it skipped trajectory checks because no
deployed run logs were available locally. It reported the existing warning
about ten rule precedents. Do not claim that the complete evaluation passed.

At the time of checking:

- Gateway health was healthy at `https://lumina-gateway-jc0930.fly.dev/health`.
- UI `/` and `/evals` returned HTML at `https://lumina-jc0930.vercel.app`.
- Gateway `/evals/report.json` returned 404: the final report is still missing.
- The older `https://lumina-psi-five-87.vercel.app` deployment returned 404.

After the owners fix and verify their outstanding items, run the full deployed
benchmark, export the actual deployed trajectories, run quality/evaluation, and
generate the report with the provided evaluation tooling. Keep a deliberately
failed trajectory in `runs/failing/`, read one successful and one failing run
end to end, and include the generated report in the deployment. Never replace
the missing report with smoke metrics or a hand-written report.

This branch has not been deployed and does not change the team's main branch.
