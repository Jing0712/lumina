/**
 * fetch_page: GET the page and read it (Readability over jsdom). The raw HTML is kept, as
 * the grader will see it, so a citation's snippet can be checked against it before it is sent.
 *
 * A publisher that 403s or times out is a failed TOOL call (ok:false with the reason), not a
 * provider outage: the loop carries on with the pages it could read.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { env } from '../env.js';
import { Lru } from '../util/lru.js';
import { collapse, normalize, stripHtml } from '../util/text.js';

export interface FetchedPage {
  ok: boolean;
  url: string;
  title: string | null;
  /** Readable text, or '' when the fetch failed. */
  text: string;
  /** normalize(stripHtml(rawHtml)): exactly the haystack the grounding check searches. */
  rawNormalized: string | null;
  error?: string;
  ms: number;
}

const cache = new Lru<FetchedPage>(300, 60 * 60 * 1000);
const MAX_HTML = 3_000_000;

export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  const cached = cache.get(url);
  if (cached) return { ...cached, ms: 0 };

  const t0 = Date.now();
  const timeout = AbortSignal.timeout(env.fetchTimeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; lumina/0.1; +course project)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const e = err as Error;
    const msg = e.name === 'TimeoutError' || timeout.aborted ? `timed out after ${env.fetchTimeoutMs}ms` : e.message;
    return { ok: false, url, title: null, text: '', rawNormalized: null, error: msg || 'fetch failed', ms: Date.now() - t0 };
  }

  if (!res.ok) {
    return { ok: false, url, title: null, text: '', rawNormalized: null, error: `${res.status} from publisher`, ms: Date.now() - t0 };
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/html|text\/plain|xml/.test(type)) {
    void res.body?.cancel();
    return { ok: false, url, title: null, text: '', rawNormalized: null, error: `unsupported content-type ${type || 'unknown'}`, ms: Date.now() - t0 };
  }

  let raw: string;
  try {
    raw = (await res.text()).slice(0, MAX_HTML);
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ok: false, url, title: null, text: '', rawNormalized: null, error: `body read failed: ${(err as Error).message}`, ms: Date.now() - t0 };
  }

  let text = '';
  let title: string | null = null;
  if (/text\/plain/.test(type)) {
    text = collapse(raw);
  } else {
    const read = readable(raw, url);
    text = read.text;
    title = read.title;
  }

  const page: FetchedPage = {
    ok: text.length >= 200,
    url,
    title,
    text,
    rawNormalized: normalize(stripHtml(raw)),
    ms: Date.now() - t0,
    ...(text.length >= 200 ? {} : { error: 'page had no readable text (JS-rendered or empty)' })
  };
  cache.set(url, page);
  return page;
}

function readable(html: string, url: string): { text: string; title: string | null } {
  const virtualConsole = new VirtualConsole(); // swallow jsdom's CSS parse noise
  const dom = new JSDOM(html, { url, virtualConsole });
  try {
    const article = new Readability(dom.window.document).parse();
    const text = collapse(article?.textContent ?? dom.window.document.body?.textContent ?? '');
    return { text, title: article?.title ?? dom.window.document.title ?? null };
  } finally {
    dom.window.close();
  }
}
