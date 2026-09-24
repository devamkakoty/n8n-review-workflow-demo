import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { startReviewServer, MAX_BODY_BYTES } from '../src/server.mjs';

const note = (noteId = 'fixture') => ({
  noteId, text: 'Synthetic test note only.',
  modelResult: { status: 'ok', actions: [{ kind: 'task', title: 'Review fixture' }] },
});
const payload = (n = note()) => JSON.stringify({ notes: [n] });

async function setup(t) {
  const server = await startReviewServer({ port: 0 });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  assert.equal(server.address().address, '127.0.0.1');
  return server;
}

function request(server, { path = '/plan', method = 'POST', body = payload(),
  headers = {}, chunked = false, unfinished = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) { reject(error); }
        req.destroy();
      });
    });
    req.on('error', reject);
    if (chunked || unfinished) {
      req.write(body);
      if (!unfinished) req.end();
    } else req.end(body);
  });
}

test('loopback HTTP plans review-only proposals then suppresses replay and conflicts', async (t) => {
  const server = await setup(t);
  const first = await request(server);
  assert.equal(first.status, 200);
  assert.equal(first.body.summary.pending_review, 1);
  assert.equal(first.body.results[0].proposals[0].autoExecute, false);
  assert.equal(first.body.results[0].proposals[0].status, 'pending_review');
  assert.equal(Object.hasOwn(first.body, 'ledger'), false);
  assert.equal(first.headers['cache-control'], 'no-store');
  const second = await request(server);
  assert.equal(second.body.summary.duplicate, 1);
  assert.deepEqual(second.body.results[0].proposals, []);
  const changed = await request(server, { body: payload({ ...note(), text: 'Changed fixture' }) });
  assert.equal(changed.body.results[0].status, 'conflict');
  assert.equal(changed.body.results[0].error, 'note_text_changed');
});

test('no-actions, disabled, unavailable and invalid notes retain planner semantics', async (t) => {
  const server = await setup(t);
  for (const [body, status] of [
    [JSON.stringify({ notes: [note()], enabled: false }), 'disabled'],
    [payload({ ...note(), modelResult: { status: 'unavailable' } }), 'model_unavailable'],
    [payload({ ...note(), modelResult: { status: 'ok', actions: [{ kind: 'send_email', title: 'No' }] } }), 'invalid'],
  ]) {
    const response = await request(server, { body });
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].status, status);
  }
  assert.equal((await request(server)).body.summary.pending_review, 1);
  const empty = payload({ ...note('empty'), modelResult: { status: 'ok', actions: [] } });
  assert.equal((await request(server, { body: empty })).body.summary.no_actions, 1);
  assert.equal((await request(server, { body: empty })).body.summary.duplicate, 1);
});

test('health, route, method, origin, host and media failures are explicit', async (t) => {
  const server = await setup(t);
  const health = await request(server, { path: '/health', method: 'GET', body: '' });
  assert.deepEqual(health.body, { status: 'ok', mode: 'synthetic_review_only' });
  for (const [options, status, error] of [
    [{ path: '/execute' }, 404, 'not_found'],
    [{ path: '/plan?reset=true' }, 404, 'not_found'],
    [{ method: 'GET' }, 405, 'method_not_allowed'],
    [{ method: 'OPTIONS' }, 405, 'method_not_allowed'],
    [{ path: '/health' }, 405, 'method_not_allowed'],
    [{ headers: { Origin: 'http://127.0.0.1' } }, 403, 'local_requests_only'],
    [{ headers: { Host: 'untrusted.example' } }, 403, 'local_requests_only'],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415, 'unsupported_media_type'],
    [{ headers: { 'Content-Encoding': 'gzip' } }, 415, 'unsupported_media_type'],
  ]) {
    const response = await request(server, options);
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    if (status === 405) assert.ok(response.headers.allow);
  }
});

test('bad JSON, UTF-8, envelopes and caller ledger return 400 without state changes', async (t) => {
  const server = await setup(t);
  for (const body of ['', '{', Buffer.from([0xff]), 'null', '[]', '{}',
    '{"notes":[],"ledger":{}}', '{"notes":[],"enabled":"yes"}',
    '{"notes":[],"execute":true}', '{"notes":"not-array"}',
    '{"notes":[],"__proto__":{}}']) {
    const response = await request(server, { body });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /^(invalid_json|invalid_request)$/);
  }
  assert.equal((await request(server)).body.summary.pending_review, 1);
});

test('64 KiB byte bound accepts exact boundary and rejects length/chunked overflow', async (t) => {
  const server = await setup(t);
  const base = '{"notes":[]}';
  const boundary = base.padEnd(MAX_BODY_BYTES, ' ');
  const exact = await request(server, { body: boundary, headers: {
    'Content-Type': 'application/json; charset=utf-8',
  } });
  assert.equal(exact.status, 200);
  for (const chunked of [false, true]) {
    const response = await request(server, { body: `${boundary} `, chunked });
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { error: 'body_too_large' });
  }
  const multibyte = await request(server, {
    body: JSON.stringify({ notes: [], extra: 'é'.repeat(MAX_BODY_BYTES / 2) }),
    chunked: true,
  });
  assert.equal(multibyte.status, 413);
});

test('unfinished body times out with 408 and leaves ledger unchanged', async (t) => {
  const server = await setup(t);
  const response = await request(server, { body: '{"notes":', unfinished: true });
  assert.equal(response.status, 408);
  assert.deepEqual(response.body, { error: 'body_timeout' });
  assert.equal((await request(server)).body.summary.pending_review, 1);
});

test('ledger is isolated per server and disappears after closing/restarting', async (t) => {
  const first = await setup(t);
  await request(first);
  await new Promise((resolve) => first.close(resolve));
  const second = await setup(t);
  assert.equal((await request(second)).body.summary.pending_review, 1);
});

test('invalid ports and occupied loopback ports reject startup', async (t) => {
  for (const port of [-1, 65536, 1.5, '8787', NaN]) {
    await assert.rejects(startReviewServer({ port }), /invalid_port/);
  }
  const server = await setup(t);
  await assert.rejects(startReviewServer({ port: server.address().port }), { code: 'EADDRINUSE' });
});

test('workflow structure and its two static HTTP bodies work via wrapper, not n8n', async (t) => {
  const workflow = JSON.parse(await readFile(new URL('../workflow.json', import.meta.url), 'utf8'));
  assert.equal(workflow.active, false);
  assert.deepEqual(workflow.nodes.map((n) => n.type), [
    'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.httpRequest',
  ]);
  const [trigger, first, replay] = workflow.nodes;
  assert.equal(workflow.connections[trigger.name].main[0][0].node, first.name);
  assert.equal(workflow.connections[first.name].main[0][0].node, replay.name);
  assert.equal(first.parameters.jsonBody, replay.parameters.jsonBody);
  const server = await setup(t);
  for (const [node, expected] of [[first, 'pending_review'], [replay, 'duplicate']]) {
    assert.equal(node.typeVersion, 4.2);
    assert.equal(node.parameters.url, 'http://127.0.0.1:8787/plan');
    assert.equal(node.parameters.sendBody, true);
    assert.equal(node.parameters.contentType, 'json');
    assert.equal(node.parameters.specifyBody, 'json');
    const response = await request(server, {
      method: node.parameters.method, body: node.parameters.jsonBody,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].status, expected);
    assert.equal(response.body.summary.proposalCount, expected === 'pending_review' ? 2 : 0);
  }
});
