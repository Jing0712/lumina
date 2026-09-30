/**
 * fetch_page: GET the page and read it (a DOM-free extractor, below). The raw HTML is kept, as
 * the grader will see it, so a citation's snippet can be checked against it before it is sent.
 *
 * A publisher that 403s or times out is a failed TOOL call (ok:false with the reason), not a
 * provider outage: the loop carries on with the pages it could read.
 */
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
const MAX_HTML = 1_500_000;

/**
 * `readText: false` skips text extraction: the caller already has the page's text (the search
 * provider extracted it) and only needs the raw page to verify a snippet against.
 */
export async function fetchPage(url: string, signal?: AbortSignal, opts: { readText?: boolean } = {}): Promise<FetchedPage> {
  const readText = opts.readText ?? true;
  const cacheKey = readText ? url : `raw:${url}`;
  const cached = cache.get(cacheKey) ?? (readText ? undefined : cache.get(url));
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
  const rawNormalized = normalize(stripHtml(raw));
  if (!readText) {
    // Verification-only fetch: the raw page is what matters; "ok" means we got a real page.
    const page: FetchedPage = {
      ok: rawNormalized.length >= 200,
      url,
      title: null,
      text: '',
      rawNormalized,
      ms: Date.now() - t0,
      ...(rawNormalized.length >= 200 ? {} : { error: 'page had no readable text (JS-rendered or empty)' })
    };
    cache.set(cacheKey, page);
    return page;
  }
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
    rawNormalized,
    ms: Date.now() - t0,
    ...(text.length >= 200 ? {} : { error: 'page had no readable text (JS-rendered or empty)' })
  };
  cache.set(cacheKey, page);
  return page;
}

/**
 * Readable text without a DOM. jsdom + Readability cost seconds of CPU per large page on the
 * event loop, which stalled every concurrent answer stream (TTFT p95 went from ~2.5s to ~12s
 * at concurrency 4). This drops script/style blocks, prefers <article>/<main> when present,
 * strips tags the same way the grader does, and decodes the common entities: O(n) regex work.
 */
function readable(html: string, _url: string): { text: string; title: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  let body = html
    .replace(/<(script|style|noscript|svg|template|iframe)(?=[\s>])[\s\S]*?<\/\1>/gi, ' ');
  const main = /<article\b[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (main && main.length > 2000) body = main;
  const text = body
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/(\.\s*){2,}/g, '. ');
  return { text: collapse(text), title: title ? decodeTitle(title) : null };
}

function decodeTitle(t: string): string {
  return t.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
