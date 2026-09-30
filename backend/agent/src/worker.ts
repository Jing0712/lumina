/**
 * The jobs worker as its own process: `npm run worker`, with EMBEDDED_WORKER=false on the
 * agent service. By default the same loop runs inside the agent process (see index.ts);
 * split it out when large PDFs start to cost the answer stream latency.
 */
import { startWorker } from './jobs/worker.js';
import { log } from './log.js';

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection (worker)');
});

startWorker();
