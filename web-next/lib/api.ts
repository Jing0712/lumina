import {
  REQUEST_HEADER,
  USER_HEADER,
  type AskBody,
  type DocumentRow,
  type DoneEvent,
  type HealthResponse,
  type ListMemoryResponse,
  type ListSpacesResponse,
  type ListThreadsResponse,
  type PlanEvent,
  type Source,
  type StatsResponse,
  type StreamErrorEvent,
  type ThreadMessage,
  type TraceEvent
} from '@lumina/contract';

/**
 * The gateway, and nothing else. The browser never reaches the agent service and never
 * holds a key: NEXT_PUBLIC_API_URL is a public URL, not a secret.
 */
export const API = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

const USER_KEY = 'lumina.userId';

/** X-User-Id is the whole auth story for this assignment. Same storage key as web/, so a user keeps their id. */
export function userId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id: string | null = null;
  try {
    id = localStorage.getItem(USER_KEY);
  } catch {
    /* storage blocked: fall through to a session id */
  }
  if (!id) {
    id = `u_${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(USER_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

export function setUserId(id: string): void {
  try {
    localStorage.setItem(USER_KEY, id.trim() || 'dev');
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
    readonly resetsAt?: string
  ) {
    super(message);
  }
  get notImplemented(): boolean {
    return this.status === 501;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        [USER_HEADER]: userId(),
        ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    });
  } catch (e) {
    throw new ApiError(0, `Could not reach the gateway${API ? ` at ${API}` : ''}: ${(e as Error).message}`);
  }

  const requestId = res.headers.get(REQUEST_HEADER) ?? undefined;
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) throw toError(body, res, requestId);
  return body as T;
}

function toError(body: unknown, res: Response, requestId?: string): ApiError {
  let message = `${res.status} ${res.statusText}`;
  let resetsAt: string | undefined;
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; resetsAt?: unknown; requestId?: unknown };
    if (typeof b.error === 'string' && b.error.trim()) message = b.error;
    if (typeof b.resetsAt === 'string') resetsAt = b.resetsAt;
    if (!requestId && typeof b.requestId === 'string') requestId = b.requestId;
  }
  return new ApiError(res.status, message, requestId, resetsAt);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 400) };
  }
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  stats: () => request<StatsResponse>('/stats'),

  listThreads: () => request<ListThreadsResponse>('/threads'),
  createThread: (title?: string) =>
    request<{ threadId: string }>('/threads', { method: 'POST', body: JSON.stringify(title ? { title } : {}) }),
  getThread: (id: string) => request<{ title?: string; messages: ThreadMessage[] }>(`/threads/${id}`),

  listMemory: () => request<ListMemoryResponse>('/memory'),
  deleteMemory: (id: string) => request<void>(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listSpaces: () => request<ListSpacesResponse>('/spaces'),
  createSpace: (name: string) =>
    request<{ spaceId: string; name: string }>('/spaces', { method: 'POST', body: JSON.stringify({ name }) }),
  listDocuments: (spaceId: string) => request<{ documents: DocumentRow[] }>(`/spaces/${spaceId}/documents`),
  uploadDocument: (spaceId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ docId: string; status: string }>(`/spaces/${spaceId}/documents`, { method: 'POST', body: form });
  },

  evalsReport: () => request<unknown>('/evals/report.json')
};

// ---------------------------------------------------------------- the ask stream

export interface AskHandlers {
  onPlan?: (p: PlanEvent) => void;
  onTrace?: (t: TraceEvent) => void;
  onSources?: (s: Source[]) => void;
  onToken?: (text: string) => void;
  onDone?: (d: DoneEvent) => void;
  onError?: (e: StreamErrorEvent) => void;
}

/**
 * POST the question and read the SSE stream by hand (EventSource cannot POST). Frames are
 * separated by a blank line; `:` comment lines are keep-alives and are ignored.
 */
export async function askStream(
  threadId: string,
  body: AskBody,
  handlers: AskHandlers,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API}/threads/${threadId}/ask`, {
      method: 'POST',
      headers: { [USER_HEADER]: userId(), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    throw new ApiError(0, `Could not reach the gateway: ${(e as Error).message}`);
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw toError(text ? safeJson(text) : null, res, res.headers.get(REQUEST_HEADER) ?? undefined);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        dispatch(frame, handlers);
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    throw e;
  }
  if (buffer.trim()) dispatch(buffer, handlers);
}

function dispatch(frame: string, h: AskHandlers): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  switch (event) {
    case 'plan':
      h.onPlan?.(data as PlanEvent);
      break;
    case 'trace':
      h.onTrace?.(data as TraceEvent);
      break;
    case 'sources':
      h.onSources?.(data as Source[]);
      break;
    case 'token':
      h.onToken?.((data as { text?: string }).text ?? '');
      break;
    case 'done':
      h.onDone?.(data as DoneEvent);
      break;
    case 'error':
      h.onError?.(data as StreamErrorEvent);
      break;
  }
}
