import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskStreamEvent, ErrorBody, HealthResponse, MAX_UPLOAD_BYTES, ROUTES } from '@lumina/contract';

let upstream;
let gateway;
let origin;
let fixtures;
let handler;
let calls;
let log;
let info;
const requestLogs = [];
const health = { status: 'ok', model: 'test-model', searchProvider: 'tavily', vectorStore: 'atlas-vector-search', db: 'ok' };
const done = { answerId: 'ans_test', latencyMs: 10, ttftMs: 1, model: 'test-model', tokens: { in: 1, out: 1 }, costUsd: 0, searchCached: false, terminated: 'done', depth: 'quick', subQuestions: 0 };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sources = [{ n: 1, kind: 'web', title: 'Test source', url: 'https://example.com', snippet: 'A retrieved passage.' }];
const answer = frame('sources', sources) + frame('token', { text: 'Answer [1].' }) + frame('done', done);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function request(path, init = {}) {
  return fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(3000),
    ...init,
    headers: { 'x-user-id': 'tester', ...init.headers }
  });
}

function ask(query, init = {}) {
  return request('/threads/thr_test/ask', {
    method: 'POST', body: JSON.stringify({ query }), ...init,
    headers: { 'content-type': 'application/json', ...init.headers }
  });
}

function parseEvents(text) {
  return text.replace(/\r\n/g, '\n').split('\n\n').filter((s) => s.includes('data:')).map((s) => {
    const lines = s.split('\n');
    return AskStreamEvent.parse({
      event: lines.find((l) => l.startsWith('event:')).slice(6).trim(),
      data: JSON.parse(lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    });
  });
}

before(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'lumina-gateway-test-'));
  await writeFile(join(fixtures, 'index.html'), '<html><body>Gateway UI fixture</body></html>');
  await writeFile(join(fixtures, 'report.json'), '{"testFixture":true}\n');
  upstream = http.createServer(async (req, res) => {
    const call = { method: req.method, url: req.url, headers: req.headers };
    calls.push(call);
    try {
      await handler(req, res, call);
    } catch (err) {
      res.destroy(err);
    }
  });
  const agentUrl = await listen(upstream);
  Object.assign(process.env, {
    AGENT_URL: agentUrl, LOG_LEVEL: 'silent', WEB_DIST: fixtures,
    REPORT_PATH: join(fixtures, 'report.json'), CORS_ORIGINS: 'https://allowed.example',
    RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_OTHER_MULTIPLIER: '100',
    UPSTREAM_TIMEOUT_MS: '500', UPSTREAM_ASK_TIMEOUT_MS: '600'
  });
  const { app } = await import('../dist/app.js');
  ({ log } = await import('../dist/log.js'));
  info = log.info;
  log.info = (fields, message) => requestLogs.push({ ...fields, message });
  gateway = http.createServer(app);
  origin = await listen(gateway);
});

beforeEach(() => {
  calls = [];
  handler = (req, res) => json(res, 200, req.url === '/health' ? health : { threads: [] });
});

after(async () => {
  if (log) log.info = info;
  for (const server of [gateway, upstream]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
});

test('every authenticated contract route rejects a missing user before reaching the agent', async () => {
  for (const route of ROUTES.filter((r) => r.auth)) {
    const url = route.path.replace(':threadId', 'thr_test').replace(':spaceId', 'spc_test').replace(':memoryId', 'mem_test');
    const res = await fetch(`${origin}${url}`, { method: route.method });
    assert.equal(res.status, 401, `${route.method} ${url}`);
    assert.ok(res.headers.get('x-request-id'));
    ErrorBody.parse(await res.json());
  }
  assert.equal(calls.length, 0);
});

test('authentication precedes JSON parsing', async () => {
  const res = await fetch(`${origin}/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('public health propagates the request ID and validates the agent response', async () => {
  const res = await fetch(`${origin}/health`, { headers: { 'x-request-id': 'req_health' } });
  assert.equal(res.status, 200);
  const body = HealthResponse.parse(await res.json());
  assert.equal(body.db, 'ok');
  assert.equal(body.ai.status, 'ok');
  assert.equal(calls[0].headers['x-request-id'], 'req_health');
});

test('invalid or degraded agent health produces a degraded gateway', async () => {
  for (const body of [{ unexpected: true }, { ...health, status: 'degraded', db: 'down' }]) {
    handler = (_req, res) => json(res, 200, body);
    const res = await fetch(`${origin}/health`);
    assert.equal(res.status, 503);
    assert.equal(HealthResponse.parse(await res.json()).status, 'degraded');
  }
});

test('health does not expose unexpected agent fields', async () => {
  handler = (_req, res) => json(res, 200, { ...health, providerKey: 'fixture-secret-do-not-expose' });
  const res = await fetch(`${origin}/health`);
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes('fixture-secret-do-not-expose'));
});

test('CORS preflight permits the configured UI and exposes request IDs', async () => {
  const res = await fetch(`${origin}/threads`, { method: 'OPTIONS', headers: { origin: 'https://allowed.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-user-id,content-type' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  assert.match(res.headers.get('access-control-expose-headers'), /x-request-id/);
  assert.equal(calls.length, 0);
});

test('invalid contract bodies and malformed JSON return 400 without an upstream call', async () => {
  for (const [url, body] of [['/threads', '{'], ['/threads', '{"title":""}'], ['/spaces', '{}'], ['/threads/thr_test/ask', '{}'], ['/threads/thr_test/ask', '{"query":"x","depth":"invalid"}']]) {
    const res = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 400);
    ErrorBody.parse(await res.json());
  }
  assert.equal(calls.length, 0);
});

test('oversized JSON returns 413', async () => {
  const res = await request('/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(1024 * 1024) }) });
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test('normal routes preserve methods, query strings, bodies, request IDs and statuses', async () => {
  handler = async (req, res, call) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    call.body = Buffer.concat(chunks).toString();
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); }
    else json(res, req.method === 'POST' ? 201 : 200, req.method === 'POST' ? { threadId: 'thr_test' } : { threads: [] });
  };
  const created = await request('/threads', { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'req_create' }, body: '{"title":"Team"}' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('x-request-id'), 'req_create');
  assert.deepEqual(JSON.parse(calls[0].body), { title: 'Team' });
  assert.equal(calls[0].headers['x-request-id'], 'req_create');
  assert.equal(calls[0].headers['x-user-id'], 'tester');
  const list = await request('/threads?limit=5');
  assert.equal(list.status, 200);
  assert.equal(calls[1].url, '/threads?limit=5');
  const removed = await request('/memory/mem_test', { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
});

test('upstream contract errors preserve their status, reset time, and retry header', async () => {
  for (const status of [400, 404, 413, 429, 501, 502]) {
    const body = { error: 'fixture error', status, ...(status === 429 ? { resetsAt: '2026-10-02T00:00:00Z' } : {}) };
    handler = (_req, res) => { res.setHeader('retry-after', '60'); json(res, status, body); };
    const res = await request('/threads');
    assert.equal(res.status, status);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.deepEqual(await res.json(), body);
  }
});

test('every normal API route accepts its declared success status and shape', async () => {
  const cases = [
    ['GET', '/stats', 200, { requests: 0, answers: 0, searchCacheHitRatePct: 0, ttftP95Ms: 0, costUsdToday: 0, deepToday: 0, deepDailyCap: 5 }],
    ['POST', '/threads', 201, { threadId: 'thr_test' }, {}],
    ['GET', '/threads', 200, { threads: [] }],
    ['GET', '/threads/thr_test', 200, { messages: [] }],
    ['GET', '/memory', 200, { memories: [] }],
    ['DELETE', '/memory/mem_test', 204],
    ['POST', '/spaces', 201, { spaceId: 'spc_test', name: 'Team' }, { name: 'Team' }],
    ['GET', '/spaces', 200, { spaces: [] }],
    ['POST', '/spaces/spc_test/documents', 202, { docId: 'doc_test', status: 'pending' }],
    ['GET', '/spaces/spc_test/documents', 200, { documents: [] }]
  ];
  for (const [method, path, status, body, input] of cases) {
    handler = (_req, res) => { if (status === 204) { res.writeHead(204); res.end(); } else json(res, status, body); };
    const res = await request(path, { method, ...(input ? { body: JSON.stringify(input), headers: { 'content-type': 'application/json' } } : {}) });
    assert.equal(res.status, status, `${method} ${path}`);
    if (body) assert.deepEqual(await res.json(), body);
  }
});

test('invalid upstream JSON, success shapes, success statuses and error shapes become 502', async () => {
  for (const [status, body] of [[200, '{'], [200, '{"threads":"bad"}'], [201, '{"threads":[]}'], [404, '{"unexpected":"bad"}']]) {
    handler = (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
    const res = await request('/threads');
    assert.equal(res.status, 502);
    ErrorBody.parse(await res.json());
  }
});

test('unexpected upstream server failures become HTTP 502', async () => {
  for (const status of [500, 503]) {
    handler = (_req, res) => json(res, status, { error: 'provider down' });
    const res = await request('/threads');
    assert.equal(res.status, 502);
    ErrorBody.parse(await res.json());
  }
});

test('per-user ask rate limits return 429 without limiting another user', async () => {
  handler = (_req, res) => json(res, 404, { error: 'no thread', status: 404 });
  for (let i = 0; i < 2; i++) assert.equal((await ask('rate', { headers: { 'x-user-id': 'limited' } })).status, 404);
  const blocked = await ask('rate', { headers: { 'x-user-id': 'limited' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await ask('rate', { headers: { 'x-user-id': 'other-user' } })).status, 404);
  assert.equal(calls.length, 3);
});

test('ask defaults remain quick and SSE bytes arrive before the agent finishes', async () => {
  let finished = false;
  handler = async (req, res, call) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    call.body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame('sources', sources));
    const timer = setTimeout(() => { finished = true; res.end(frame('token', { text: 'Answer [1].' }) + frame('done', done)); }, 250);
    res.on('close', () => clearTimeout(timer));
  };
  const res = await ask('quick', { headers: { 'x-user-id': 'stream-quick' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-transform/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(finished, false);
  assert.match(Buffer.from(first.value).toString(), /event: sources/);
  let text = Buffer.from(first.value).toString();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString(); }
  assert.deepEqual(parseEvents(text).map((e) => e.event), ['sources', 'token', 'done']);
  assert.equal(calls[0].body.depth, 'quick');
  assert.equal(calls[0].body.mode, 'auto');
});

test('deep SSE plans, sub-question tags, and terminal outcomes pass through unchanged', async () => {
  const plan = { subQuestions: [1, 2, 3].map((i) => ({ i, question: `Question ${i}`, reason: `Reason ${i}` })) };
  const text = frame('plan', plan) + frame('trace', { step: 1, tool: 'web_search', input: {}, ok: true, ms: 1, subQuestion: 1 }) + frame('sources', sources.map((s) => ({ ...s, subQuestion: 1 }))) + frame('token', { text: 'Answer [1].' }) + frame('done', { ...done, depth: 'deep', subQuestions: 3, terminated: 'cap' });
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
  const res = await ask('deep', { headers: { 'x-user-id': 'stream-deep' }, body: '{"query":"deep","depth":"deep"}' });
  assert.equal(await res.text(), text);
  assert.deepEqual(parseEvents(text).map((e) => e.event), ['plan', 'trace', 'sources', 'token', 'done']);
});

test('an HTTP 200 ask with a non-SSE body is rejected as 502', async () => {
  handler = (_req, res) => json(res, 200, { answer: 'wrong protocol' });
  const res = await ask('bad protocol', { headers: { 'x-user-id': 'protocol' } });
  assert.equal(res.status, 502);
  ErrorBody.parse(await res.json());
});

test('an upstream SSE stream closing without done/error emits a visible 502 error', async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame('sources', sources)); };
  const res = await ask('incomplete', { headers: { 'x-user-id': 'incomplete' } });
  const events = parseEvents(await res.text());
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.status, 502);
});

test('split terminal frames and CRLF SSE are recognized without changing bytes', async () => {
  const text = answer.replace(/\n/g, '\r\n');
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(text.slice(0, -8));
    const timer = setTimeout(() => res.end(text.slice(-8)), 10);
    res.on('close', () => clearTimeout(timer));
  };
  const res = await ask('split frames', { headers: { 'x-user-id': 'split' } });
  assert.equal(await res.text(), text);
});

test('invalid done data and a partial final frame produce an error instead of silent completion', async () => {
  for (const ending of [frame('done', {}), 'event: token\ndata: {"text":"unfinished']) {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame('sources', sources) + ending); };
    const res = await ask('invalid terminal', { headers: { 'x-user-id': `invalid-terminal-${ending.length}` } });
    const text = await res.text();
    const lastFrame = text.trim().split('\n\n').at(-1);
    assert.match(lastFrame, /^event: error/);
    assert.equal(JSON.parse(lastFrame.split('data: ')[1]).status, 502);
  }
});

test('an upstream error frame passes through without appending a second error', async () => {
  const text = frame('sources', []) + frame('error', { status: 502, error: 'provider failed after stream opened' });
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(text); };
  const res = await ask('upstream error', { headers: { 'x-user-id': 'upstream-error' } });
  assert.equal(await res.text(), text);
});

test('an upstream socket reset mid-answer emits a 502 error event', async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame('sources', sources));
    const timer = setTimeout(() => res.destroy(), 20);
    res.on('close', () => clearTimeout(timer));
  };
  const res = await ask('reset stream', { headers: { 'x-user-id': 'stream-reset' } });
  assert.equal(parseEvents(await res.text()).at(-1).data.status, 502);
});

test('a reset after a mutating request is accepted never replays that request', async () => {
  handler = async (req, res) => { for await (const chunk of req) void chunk; res.destroy(); };
  const res = await request('/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 502);
  assert.equal(calls.length, 1);
});

test('safe reads may retry one reset', async () => {
  handler = (_req, res) => { if (calls.length === 1) res.destroy(); else json(res, 200, { threads: [] }); };
  const res = await request('/threads');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('a timeout before answer headers becomes HTTP 502', async () => {
  handler = () => {};
  const res = await ask('hang', { headers: { 'x-user-id': 'timeout-before' } });
  assert.equal(res.status, 502);
  ErrorBody.parse(await res.json());
});

test('a timeout after answer headers becomes an SSE error', async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame('sources', sources)); };
  const res = await ask('hang stream', { headers: { 'x-user-id': 'timeout-after' } });
  const events = parseEvents(await res.text());
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.status, 502);
});

test('a client disconnect closes the upstream answer connection', async () => {
  let closed;
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  handler = (_req, res) => { res.on('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame('sources', sources)); };
  const cancel = new AbortController();
  const res = await ask('leave', { signal: cancel.signal, headers: { 'x-user-id': 'disconnect' } });
  await res.body.getReader().read();
  cancel.abort();
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not cancelled')), 2000).unref())]);
});

test('a client disconnect also cancels an ordinary JSON request', async () => {
  let received;
  let closed;
  const arrived = new Promise((resolve) => { received = resolve; });
  const upstreamClosed = new Promise((resolve) => { closed = resolve; });
  handler = (_req, res) => { res.on('close', closed); received(); };
  const cancel = new AbortController();
  const pending = request('/threads', { signal: cancel.signal }).catch((err) => err);
  await arrived;
  cancel.abort();
  await pending;
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('JSON request not cancelled')), 2000).unref())]);
});

test('multipart uploads reach the agent byte-for-byte and keep its 202 status', async () => {
  const raw = '--boundary\r\nContent-Disposition: form-data; name="file"; filename="team.md"\r\nContent-Type: text/markdown\r\n\r\n# Team document\r\n--boundary--\r\n';
  handler = async (req, res, call) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    call.body = Buffer.concat(chunks).toString();
    json(res, 202, { docId: 'doc_test', status: 'pending' });
  };
  const res = await request('/spaces/spc_test/documents', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=boundary' }, body: raw });
  assert.equal(res.status, 202);
  assert.equal(calls[0].body, raw);
  assert.equal(calls[0].headers['content-type'], 'multipart/form-data; boundary=boundary');
});

test('an obviously oversized multipart upload is rejected before proxying', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/spaces/spc_test/documents`, { method: 'POST', headers: { 'x-user-id': 'oversize', 'content-type': 'multipart/form-data; boundary=b', 'content-length': MAX_UPLOAD_BYTES + 1024 * 1024 + 1 } }, (res) => { res.resume(); resolve(res); });
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(res.statusCode, 413);
  assert.equal(calls.length, 0);
});

test('evaluation report is public and served verbatim; UI routes fall back to index.html', async () => {
  const report = await fetch(`${origin}/evals/report.json`);
  assert.equal(report.status, 200);
  assert.equal(await report.text(), '{"testFixture":true}\n');
  assert.equal(report.headers.get('cache-control'), 'no-cache');
  for (const path of ['/', '/evals']) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Gateway UI fixture/);
  }
  const unknown = await request('/stats/no-such-route');
  assert.equal(unknown.status, 404);
});

test('one gateway request log contains the shared request ID and response status', async () => {
  const res = await request('/threads', { headers: { 'x-request-id': 'req_log' } });
  await res.text();
  const entries = requestLogs.filter((entry) => entry.requestId === 'req_log');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 200);
  assert.equal(entries[0].userId, 'tester');
  assert.equal(entries[0].method, 'GET');
  assert.equal(entries[0].route, '/threads');
  assert.ok(entries[0].ms >= 0);
});
