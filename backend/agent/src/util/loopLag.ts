/**
 * Event-loop lag sampler (diagnostics). A 50 ms interval that measures how late it fires; a
 * large lateness means something synchronous held the loop — and every open stream with it.
 */
const samples: { at: number; lag: number }[] = [];
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = Math.max(0, now - last - 50);
  last = now;
  if (lag > 5) {
    samples.push({ at: now, lag });
    if (samples.length > 5000) samples.splice(0, samples.length - 5000);
  }
}, 50).unref();

/** The worst loop stall (ms) observed since `since` (epoch ms). */
export function maxLoopLagSince(since: number): number {
  let max = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i] as { at: number; lag: number };
    if (s.at < since) break;
    if (s.lag > max) max = s.lag;
  }
  return max;
}
