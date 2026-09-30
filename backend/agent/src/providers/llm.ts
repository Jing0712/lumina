/**
 * Anthropic Messages API over plain fetch: no SDK, so nothing between us and the wire.
 *
 * Fail loud: every non-2xx, every `error` stream event and every network failure throws a
 * ProviderError. Nothing in here catches and returns something plausible.
 */
import { env, secrets } from '../env.js';
import { nodeFetch } from '../util/httpFetch.js';

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number
  ) {
    super(`${provider}: ${message}`);
  }
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  tools?: ToolDef[];
  toolChoice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmTurn {
  content: ContentBlock[];
  stopReason: string | null;
  tokensIn: number;
  tokensOut: number;
}

function headers(): Record<string, string> {
  if (!secrets.anthropic) throw new ProviderError('anthropic', 'ANTHROPIC_API_KEY is not set');
  return {
    'content-type': 'application/json',
    'x-api-key': secrets.anthropic,
    'anthropic-version': '2023-06-01'
  };
}

function body(req: LlmRequest, stream: boolean): string {
  return JSON.stringify({
    model: req.model,
    system: req.system,
    messages: req.messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature ?? 0.2,
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...(req.tools?.length && req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    stream
  });
}

/**
 * LLM_TIMEOUT_MS bounds how long the provider may take to START answering. Once a stream is
 * flowing, a long answer is not a failure: the run's own wall-clock cap (per gear) bounds it.
 * (A whole-stream timeout here turned every long deep synthesis into a 502.)
 */
async function postOnce(req: LlmRequest, stream: boolean): Promise<Response> {
  const startGuard = new AbortController();
  const timer = setTimeout(() => startGuard.abort(new Error(`no response within ${env.llmTimeoutMs}ms`)), env.llmTimeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, startGuard.signal]) : startGuard.signal;
  let res: Response;
  try {
    res = await nodeFetch(`${env.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: headers(),
      body: body(req, stream),
      signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (req.signal?.aborted) throw err;
    throw new ProviderError('anthropic', `request failed: ${(err as Error).message}`);
  }
  // Streaming: headers arrived, so the provider has started; stop the start guard. A
  // non-streamed call keeps it until the body is read.
  if (stream) clearTimeout(timer);
  else void res.clone().arrayBuffer().finally(() => clearTimeout(timer)).catch(() => undefined);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      // not JSON; keep the raw text
    }
    throw new ProviderError('anthropic', `${res.status} ${msg}`, res.status);
  }
  return res;
}

/**
 * A hedged streamed call. Provider time-to-headers has a long tail (usually ~0.6 s, now and
 * then 2 s+ for the same request), and a quick answer's TTFT is mostly that number. If the
 * first request has not answered after LLM_HEDGE_MS, send one duplicate and keep whichever
 * answers first; the loser is aborted before it generates anything. A failure of the first
 * request before the hedge fires is thrown as-is: hedging is for slowness, not for errors.
 */
async function post(req: LlmRequest, stream: boolean, onHedge?: () => void): Promise<Response> {
  if (!stream || env.llmHedgeMs <= 0) return postOnce(req, stream);
  return new Promise<Response>((resolve, reject) => {
    const ctrls: AbortController[] = [];
    let settled = false;
    let pending = 0;
    let hedged = false;
    let lastErr: unknown;
    const launch = () => {
      const c = new AbortController();
      ctrls.push(c);
      pending++;
      const signal = req.signal ? AbortSignal.any([req.signal, c.signal]) : c.signal;
      postOnce({ ...req, signal }, true).then(
        (res) => {
          pending--;
          if (settled) {
            void res.body?.cancel().catch(() => undefined);
            return;
          }
          settled = true;
          clearTimeout(timer);
          for (const o of ctrls) if (o !== c) o.abort(new Error('hedge lost'));
          resolve(res);
        },
        (err: unknown) => {
          pending--;
          lastErr = err;
          if (settled) return;
          // Wait for the other request if one is still in flight; otherwise this is the answer.
          if (pending > 0) return;
          if (!hedged) clearTimeout(timer);
          settled = true;
          reject(lastErr);
        }
      );
    };
    const timer = setTimeout(() => {
      if (settled || req.signal?.aborted) return;
      hedged = true;
      onHedge?.();
      launch();
    }, env.llmHedgeMs);
    launch();
  });
}

/** One non-streamed turn. Used by the planner, where structure matters more than first paint. */
export async function complete(req: LlmRequest): Promise<LlmTurn> {
  const res = await post(req, false);
  const json = (await res.json()) as {
    content: ContentBlock[];
    stop_reason: string | null;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  return {
    content: json.content ?? [],
    stopReason: json.stop_reason ?? null,
    tokensIn:
      (json.usage?.input_tokens ?? 0) +
      (json.usage?.cache_read_input_tokens ?? 0) +
      (json.usage?.cache_creation_input_tokens ?? 0),
    tokensOut: json.usage?.output_tokens ?? 0
  };
}

export interface StreamHandlers {
  /** A piece of assistant text. Called in order, as it arrives. */
  onText?: (delta: string) => void;
  /** A tool_use block started: the turn is going to call a tool. */
  onToolStart?: (name: string) => void;
  /** Response headers arrived: the provider has started answering. */
  onHeaders?: () => void;
  /** The first request was slow, so a duplicate was sent (see post()). */
  onHedge?: () => void;
}

/**
 * One streamed turn. Text deltas are handed to `onText` the moment they arrive, which is
 * what makes TTFT a property of the model rather than of this code.
 */
export async function stream(req: LlmRequest, h: StreamHandlers = {}): Promise<LlmTurn> {
  const res = await post(req, true, h.onHedge);
  h.onHeaders?.();
  if (!res.body) throw new ProviderError('anthropic', 'empty stream body');

  const blocks: (ContentBlock & { _json?: string })[] = [];
  let stopReason: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;

  const handle = (event: string, data: string): void => {
    if (!data) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = (ev.type as string) ?? event;
    if (type === 'message_start') {
      const u = (ev.message as { usage?: Record<string, number> })?.usage ?? {};
      tokensIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      tokensOut = u.output_tokens ?? 0;
    } else if (type === 'content_block_start') {
      const idx = ev.index as number;
      const cb = ev.content_block as ContentBlock;
      if (cb.type === 'tool_use') {
        blocks[idx] = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' };
        h.onToolStart?.(cb.name);
      } else if (cb.type === 'text') {
        blocks[idx] = { type: 'text', text: '' };
      }
    } else if (type === 'content_block_delta') {
      const idx = ev.index as number;
      const delta = ev.delta as { type: string; text?: string; partial_json?: string };
      const block = blocks[idx];
      if (delta.type === 'text_delta' && delta.text) {
        if (block && block.type === 'text') block.text += delta.text;
        h.onText?.(delta.text);
      } else if (delta.type === 'input_json_delta' && block && block.type === 'tool_use') {
        block._json = (block._json ?? '') + (delta.partial_json ?? '');
      }
    } else if (type === 'content_block_stop') {
      const block = blocks[ev.index as number];
      if (block && block.type === 'tool_use') {
        try {
          block.input = block._json ? (JSON.parse(block._json) as Record<string, unknown>) : {};
        } catch {
          block.input = {};
        }
        delete block._json;
      }
    } else if (type === 'message_delta') {
      stopReason = ((ev.delta as { stop_reason?: string })?.stop_reason ?? stopReason) as string | null;
      const u = (ev.usage as { output_tokens?: number }) ?? {};
      if (typeof u.output_tokens === 'number') tokensOut = u.output_tokens;
    } else if (type === 'error') {
      const e = ev.error as { type?: string; message?: string } | undefined;
      throw new ProviderError('anthropic', `stream error: ${e?.type ?? ''} ${e?.message ?? ''}`.trim());
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        let event = '';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        handle(event, data.join('\n'));
      }
    }
  } catch (err) {
    if (err instanceof ProviderError || req.signal?.aborted) throw err;
    throw new ProviderError('anthropic', `stream failed: ${(err as Error).message}`);
  }

  if (stopReason === null) throw new ProviderError('anthropic', 'stream ended without a stop reason');
  return {
    content: blocks.filter(Boolean).map((b): ContentBlock =>
      b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b.type === 'text' ? { type: 'text', text: b.text } : b
    ),
    stopReason,
    tokensIn,
    tokensOut
  };
}
