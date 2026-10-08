import type { Depth, DoneEvent, PlanEvent, Source, TraceEvent } from '@lumina/contract';

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  trace: TraceEvent[];
  plan?: PlanEvent;
  depth?: Depth;
  answerId?: string;
  done?: Partial<DoneEvent>;
  streaming?: boolean;
  /** Set when the stream ended in an `error` event or the request failed. */
  failed?: string;
};

export type Space = { spaceId: string; name: string };
export type ThreadRow = { threadId: string; title: string; createdAt?: string };

let seq = 0;
export const localId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function docLabel(s: Source): string {
  const l = s.locator;
  if (l?.page) return `p. ${l.page}`;
  if (l?.heading) return l.heading;
  if (l?.line) return `line ${l.line}`;
  return 'document';
}

export const ms = (n?: number) =>
  n === undefined ? '–' : n >= 10_000 ? `${Math.round(n / 1000)} s` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;

export const usd = (n?: number) => (n === undefined ? '–' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
