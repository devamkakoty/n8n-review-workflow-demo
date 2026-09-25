import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { captureLeads } from './lead-capture.mjs';
import { events, options } from './fixtures.mjs';
import { buildWorkflow, workflowText } from './build-workflow.mjs';

const run = (input = events, config = options) => captureLeads(input, config);
const web = (eventId, payload, extra = {}) => ({
  source: 'web', eventId, payload, capturedAt: '2026-09-25T09:00:00Z', ...extra,
});
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('fixture: eight events, five CRM previews, three duplicates and exact SLA metrics', () => {
  const output = run();
  assert.equal(output.synthetic, true);
  assert.equal(output.mode, 'offline_preview');
  assert.equal(output.results.length, 8);
  assert.equal(output.crmRecords.length, 5);
  assert.deepEqual(output.metrics, {
    received: 8, accepted: 5, duplicate: 3, responded: 3, unanswered: 2,
    responseLatencySeconds: { mean: 280, max: 420 },
    sla: { thresholdSeconds: 300, met: 2, late: 1, overdue: 1, pending: 1, evaluated: 4, metPercent: 50 },
    bySource: {
      meta: { received: 3, accepted: 2, duplicate: 1 },
      web: { received: 3, accepted: 2, duplicate: 1 },
      whatsapp: { received: 2, accepted: 1, duplicate: 1 },
    },
  });
  const avery = output.crmRecords[0];
  assert.equal(avery.name, 'Avery Example');
  assert.equal(avery.email, 'avery@example.test');
  assert.equal(avery.phone, '+12025550101');
  assert.deepEqual(avery.sources, ['meta', 'web', 'whatsapp']);
  assert.equal(avery.responseLatencySeconds, 120);
  assert.ok(output.crmRecords.every((r) => r.synthetic && r.writeDisposition === 'preview_only'));
  assert.equal(output.results.filter((r) => r.reason === 'source_event_replay').length, 1);
});

test('deterministic across reverse, rotations, repeated calls; does not mutate frozen inputs', () => {
  const input = freeze(structuredClone(events));
  const config = freeze(structuredClone(options));
  const expected = run(input, config);
  assert.deepEqual(run([...input].reverse()), expected);
  for (let i = 0; i < input.length; i++) {
    assert.deepEqual(run([...input.slice(i), ...input.slice(0, i)]), expected);
  }
  assert.deepEqual(run(input, config), expected);
  assert.deepEqual(input, events);
});

test('all permutations of a transitive email/phone bridge merge into one lead', () => {
  const a = web('a', { email: 'bridge@example.test' });
  const b = web('b', { phone: '+12025550104' });
  const c = web('c', { email: ' BRIDGE@EXAMPLE.TEST ', phone: '+1 (202) 555-0104' });
  const expected = run([a, b, c]);
  for (const input of [[a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
    assert.deepEqual(run(input), expected);
  }
  assert.equal(expected.metrics.accepted, 1);
  assert.equal(expected.metrics.duplicate, 2);
  assert.equal(expected.crmRecords[0].leadId, 'synthetic:web:a');
  assert.equal(expected.crmRecords[0].phone, '+12025550104');
});

test('earliest capture wins, with an ASCII event-key tie break', () => {
  const late = web('a', { email: 'tie@example.test' }, { capturedAt: '2026-09-25T09:01:00Z' });
  const early = web('z', { email: 'tie@example.test' });
  assert.equal(run([late, early]).crmRecords[0].leadId, 'synthetic:web:z');
  const tie = web('a', { email: 'tie@example.test' });
  assert.equal(run([early, tie]).crmRecords[0].leadId, 'synthetic:web:a');
});

test('does not fuzzy-match names, plus-addresses, email dots or infer local country codes', () => {
  const input = [
    web('1', { name: 'Same Name', email: 'a.b@example.test' }),
    web('2', { name: 'Same Name', email: 'ab@example.test' }),
    web('3', { name: 'Same Name', email: 'ab+tag@example.test' }),
  ];
  assert.equal(run(input).metrics.accepted, 3);
  assert.throws(() => run([web('4', { phone: '202-555-0101' })]), /country code/);
});

test('replays are namespaced by source and conflicts fail the entire batch', () => {
  const a = web('same-id', { email: 'one@example.test' });
  const b = { ...a, source: 'meta', payload: { email: 'two@example.test' } };
  assert.equal(run([a, b]).metrics.accepted, 2);
  assert.equal(run([a, structuredClone(a)]).metrics.duplicate, 1);
  for (const change of [
    { payload: { email: 'changed@example.test' } },
    { firstResponseAt: '2026-09-25T09:02:00Z' },
    { capturedAt: '2026-09-25T09:01:00Z' },
  ]) {
    assert.throws(() => run([a, { ...a, ...change }]), /conflicting replay: web:same-id/);
  }
});

test('uses earliest observed response across the whole group, not duplicate response counts', () => {
  const a = web('a', { email: 'reply@example.test' });
  const b = web('b', { email: 'reply@example.test' }, {
    capturedAt: '2026-09-25T09:01:00Z', firstResponseAt: '2026-09-25T09:04:00Z',
  });
  const c = web('c', { email: 'reply@example.test' }, {
    capturedAt: '2026-09-25T09:02:00Z', firstResponseAt: '2026-09-25T09:03:00Z',
  });
  const output = run([c, b, a, c]);
  assert.equal(output.metrics.responded, 1);
  assert.equal(output.crmRecords[0].responseLatencySeconds, 180);
  assert.equal(output.metrics.sla.met, 1);
});

test('SLA boundary is inclusive; unresponded leads cross overdue only after deadline', () => {
  const capturedAt = '2026-09-25T09:15:00Z';
  const input = [
    web('met', { email: 'met@example.test' }, { capturedAt, firstResponseAt: options.asOf }),
    web('pending', { email: 'pending@example.test' }, { capturedAt }),
    web('overdue', { email: 'overdue@example.test' }, { capturedAt: '2026-09-25T09:14:59.999Z' }),
  ];
  const output = run(input);
  assert.deepEqual(output.metrics.sla, {
    thresholdSeconds: 300, met: 1, late: 0, overdue: 1, pending: 1, evaluated: 2, metPercent: 50,
  });
  const immediate = web('zero', { email: 'zero@example.test' }, {
    capturedAt: options.asOf, firstResponseAt: options.asOf,
  });
  assert.equal(run([immediate], { ...options, slaSeconds: 0 }).metrics.sla.met, 1);
});

test('empty and entirely pending batches have null, not invented, latency/compliance', () => {
  for (const input of [[], [web('pending', { email: 'p@example.test' }, { capturedAt: options.asOf })]]) {
    const output = run(input);
    assert.deepEqual(output.metrics.responseLatencySeconds, { mean: null, max: null });
    assert.equal(output.metrics.sla.metPercent, null);
    assert.equal(output.metrics.sla.evaluated, 0);
  }
});

test('invalid calendar, timezone, future and negative response times are rejected', () => {
  const good = web('time', { email: 'time@example.test' });
  for (const capturedAt of [
    '2026-02-30T09:00:00Z', '2026-09-25', '2026-09-25T09:00:00+00:00',
    '2026-09-25T09:00:00', '2026-09-25T09:21:00Z', 0,
  ]) {
    assert.throws(() => run([{ ...good, capturedAt }]));
  }
  for (const firstResponseAt of ['2026-09-25T08:59:59Z', '2026-09-25T09:21:00Z', '']) {
    assert.throws(() => run([{ ...good, firstResponseAt }]));
  }
  assert.throws(() => run([good], { slaSeconds: 300 }), /asOf/);
});

test('rejects missing identities, unsupported sources, malformed objects and long fields', () => {
  const good = web('valid', { email: 'valid@example.test' });
  for (const input of [
    [null], [7], [[]], [{}], [undefined], new Array(1),
    [{ ...good, source: 'other' }], [{ ...good, eventId: 'spaces not allowed' }],
    [{ ...good, payload: [] }], [{ ...good, source: 'whatsapp' }],
    [web('blank', {})], [web('bad-email', { email: 'not-an-email' })],
    [web('control', { email: 'a\u0000@example.test' })],
    [web('number', { phone: 12025550101 })],
    [web('extension', { phone: '+12025550101 ext 4' })],
    [web('letters', { phone: '+1abc2025550101' })],
    [web('plus', { phone: '++12025550101' })],
    [web('short', { phone: '+123' })],
    [web('long', { name: 'x'.repeat(121), email: 'x@example.test' })],
    [web('long-email', { email: `${'x'.repeat(254)}@example.test` })],
  ]) assert.throws(() => run(input));
  // Do not silently discard a malformed supplied email just because phone is valid.
  assert.throws(() => run([web('bad', { email: 'broken', phone: '+12025550101' })]), /email/);
});

test('batch and configuration limits are enforced, with 100 events accepted at the bound', () => {
  const input = Array.from({ length: 100 }, (_, i) => web(`id-${i}`, { email: `lead${i}@example.test` }));
  assert.equal(run(input).metrics.accepted, 100);
  assert.throws(() => run([...input, input[0]]), /at most 100/);
  for (const bad of [null, {}, 'events']) assert.throws(() => run(bad), /array/);
  for (const slaSeconds of [-1, 86401, 1.5, '300', NaN]) {
    assert.throws(() => run([], { ...options, slaSeconds }), /slaSeconds/);
  }
});

test('workflow is inactive, self-contained, credential-free, and byte-for-byte reproducible', async () => {
  const saved = await readFile(new URL('./workflow.json', import.meta.url), 'utf8');
  assert.equal(saved, workflowText());
  assert.ok(Buffer.byteLength(saved) < 64 * 1024);
  const flow = JSON.parse(saved);
  assert.deepEqual(flow, buildWorkflow());
  assert.equal(flow.active, false);
  assert.deepEqual(flow.nodes.map((n) => n.type), ['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.code']);
  assert.ok(flow.nodes.every((n) => !('credentials' in n)));
  const code = flow.nodes[1];
  assert.equal(code.parameters.mode, 'runOnceForAllItems');
  assert.equal(code.parameters.language, 'javaScript');
  assert.deepEqual(flow.connections[flow.nodes[0].name].main, [[{
    node: code.name, type: 'main', index: 0,
  }]]);
  assert.equal(Object.keys(flow.connections).length, 1);
  assert.doesNotMatch(code.parameters.jsCode, /\b(?:fetch|require|process|XMLHttpRequest|WebSocket)\b|https?:\/\//);
  // Component execution only: this is not an n8n import/engine verification.
  const sandbox = { Date: class extends Date { static now() { throw new Error('clock read'); } } };
  const result = runInNewContext(`(function () { ${code.parameters.jsCode}\n})()`, sandbox, {
    timeout: 1000, contextCodeGeneration: { strings: false, wasm: false },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ json: run() }]);
});
