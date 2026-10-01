import type { Response } from 'express';
import { DoneEvent, StreamErrorEvent } from '@lumina/contract';

/** Observe completion without buffering or rewriting the bytes sent to the browser. */
export class SseCompletion {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  terminal = false;

  get partialFrame(): boolean {
    return Boolean(this.buffer.trim());
  }

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    for (;;) {
      const split = /\r?\n\r?\n/.exec(this.buffer);
      if (!split) break;
      const frame = this.buffer.slice(0, split.index);
      this.buffer = this.buffer.slice(split.index + split[0].length);
      const lines = frame.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      if (event !== 'done' && event !== 'error') continue;
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      (event === 'done' ? DoneEvent : StreamErrorEvent).parse(JSON.parse(data));
      this.terminal = true;
    }
    if (this.buffer.length > 1024 * 1024) throw new Error('agent SSE frame exceeds 1 MiB');
  }
}

/**
 * Express buffers Server-Sent Events by default, and so do most proxies. Get these four
 * headers and the flush right or your tokens all arrive at once at the end, which reads
 * as "the model is slow" and fails the TTFT SLA for a reason no profiler will show you.
 *
 * Also: do NOT put `compression()` in front of the ask route.
 */
export function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx / Fly's proxy will otherwise hold the stream until it has a bufferful.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** Write one SSE frame and flush it. The blank line terminates the frame; without it the client waits. */
export function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // @ts-expect-error `flush` exists when a compression middleware is present; harmless otherwise.
  if (typeof res.flush === 'function') res.flush();
}
