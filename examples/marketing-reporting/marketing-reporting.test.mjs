import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createFixtureAdapters, getReportContext } from './adapters.mjs';
import { createMarketingReporter, reportingSchedule, weekOverWeek } from './reporting.mjs';
import { estimateCosts } from './costs.mjs';
import { fixture, request } from './fixtures.mjs';
import { runSyntheticScenario } from './scenarios.mjs';
import { buildWorkflow, workflowText } from './build-workflow.mjs';

const run = (input = fixture, config = request) =>
  createMarketingReporter()(config, createFixtureAdapters(input));
const changeFixture = (mutate) => {
  const input = structuredClone(fixture);
  mutate(input);
  return input;
};
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('happy path: complete weekly normalization, safe ratios and exact five-line summary', () => {
  const result = run();
  assert.equal(result.status, 'report_ready');
  assert.equal(result.synthetic, true);
  assert.equal(result.delivery, 'not_sent');
  assert.deepEqual(result.alerts, []);
  const report = result.reports[0];
  assert.deepEqual(report.metrics, {
    prior: { spendCents: 7000, impressions: 7000, clicks: 700, sessions: 560, keyEvents: 28, revenueCents: 28000 },
    current: { spendCents: 8400, impressions: 8400, clicks: 840, sessions: 700, keyEvents: 35, revenueCents: 35000 },
  });
  assert.deepEqual(report.windows, {
    current: { start: '2026-09-21', end: '2026-09-27' },
    prior: { start: '2026-09-14', end: '2026-09-20' },
  });
  assert.deepEqual(report.changes.spendCents, { absolute: 1400, percent: 20, status: 'comparable' });
  assert.deepEqual(report.changes.keyEvents, { absolute: 7, percent: 25, status: 'comparable' });
  assert.deepEqual(report.derived.current, {
    ctrPercent: 10, cpc: 0.1, costPerKeyEvent: 2.4, revenueToSpend: 4.17,
  });
  assert.equal(report.summary.llmCalled, false);
  assert.deepEqual(report.summary.lines, [
    'SYNTHETIC | agency-demo/ad-demo-01 | 2026-09-21 to 2026-09-27 (UTC).',
    'Meta spend USD 84.00 (+20.00% WoW); clicks 840 (+20.00% WoW).',
    'GA4 scoped sessions 700 (+25.00% WoW); key events 35 (+25.00% WoW).',
    'GA4 scoped revenue USD 350.00 (+25.00% WoW).',
    'Preview only; inspect attribution and data freshness before any client delivery.',
  ]);
  assert.ok(!/Infinity|NaN/.test(JSON.stringify(result)));
});

test('prior zero is n/a, both zero is 0%, and a decline to zero is -100%', () => {
  assert.deepEqual(weekOverWeek(10, 0), { absolute: 10, percent: null, status: 'prior_zero' });
  assert.deepEqual(weekOverWeek(0, 0), { absolute: 0, percent: 0, status: 'both_zero' });
  assert.deepEqual(weekOverWeek(0, 10), { absolute: -10, percent: -100, status: 'comparable' });
  const report = runSyntheticScenario(fixture, request, 'prior_zero').firstRun.reports[0];
  assert.ok(Object.values(report.changes).every((value) => value.percent === null));
  assert.ok(Object.values(report.derived.prior).every((value) => value === null));
  assert.match(report.summary.lines[1], /n\/a; prior zero/);
  assert.equal(weekOverWeek(1, Number.MIN_VALUE).status, 'out_of_range');
  for (const invalid of [NaN, Infinity, -1, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => weekOverWeek(invalid, 0));
    assert.throws(() => weekOverWeek(0, invalid));
  }
});

test('all-zero weeks produce explicit zeros and null derived denominators', () => {
  const input = changeFixture((data) => {
    data.meta.data.forEach((row) => Object.assign(row, { spend: '0', impressions: '0', clicks: '0' }));
    data.ga4.rows.forEach((row) => Object.assign(row, { sessions: '0', keyEvents: '0', purchaseRevenue: '0' }));
  });
  const report = run(input).reports[0];
  assert.ok(Object.values(report.changes).every((value) => value.status === 'both_zero'));
  assert.ok(Object.values(report.derived.current).every((value) => value === null));
  assert.match(report.summary.lines[1], /0\.00%/);
});

test('duplicate replay emits no report; equivalent order/number formatting does not conflict', () => {
  const reporter = createMarketingReporter();
  const first = reporter(request, createFixtureAdapters(fixture));
  const reordered = changeFixture((input) => {
    input.meta.data.reverse().forEach((row) => { row.spend = Number(row.spend); });
    input.ga4.rows.reverse();
  });
  const replay = reporter({ ...request, asOf: '2026-09-29' }, createFixtureAdapters(reordered));
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.reportKey, first.reportKey);
  assert.deepEqual(replay.reports, []);
  assert.deepEqual(replay.alerts, []);
  assert.deepEqual(run(reordered), first);
});

test('changed normalized metrics conflict without overwriting the first committed key', () => {
  const reporter = createMarketingReporter();
  reporter(request, createFixtureAdapters(fixture));
  const changed = changeFixture((input) => { input.ga4.rows[13].sessions = '101'; });
  const conflict = reporter(request, createFixtureAdapters(changed));
  assert.equal(conflict.alerts[0].code, 'REPORT_CONFLICT');
  assert.equal(conflict.alerts[0].retryable, false);
  assert.deepEqual(conflict.reports, []);
  assert.equal(reporter(request, createFixtureAdapters(fixture)).status, 'duplicate');
});

test('key isolates tenant, account, property, currency and week but excludes run date', () => {
  assert.equal(getReportContext(request).key,
    'synthetic-marketing:v1:agency-demo:ad-demo-01:property-demo:USD:UTC:2026-09-21');
  const keys = [
    {}, { agencyId: 'other' }, { accountId: 'other' }, { propertyId: 'other' },
    { currency: 'EUR' }, { weekStart: '2026-09-14' },
  ].map((change) => getReportContext({ ...request, ...change }).key);
  assert.equal(new Set(keys).size, keys.length);
  const reporter = createMarketingReporter();
  assert.equal(reporter(request, createFixtureAdapters(fixture)).status, 'report_ready');
  assert.equal(reporter({ ...request, agencyId: 'other' }, createFixtureAdapters(fixture)).status, 'report_ready');
});

test('each source failure emits a sanitized alert and allows recovery under the same key', () => {
  for (const source of ['meta', 'ga4']) {
    const reporter = createMarketingReporter();
    const adapters = createFixtureAdapters(fixture);
    adapters[source].read = () => { throw new Error('secret-token-must-not-appear'); };
    const failed = reporter(request, adapters);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.reports, []);
    assert.equal(failed.alerts[0].code, 'SOURCE_FAILURE');
    assert.equal(failed.alerts[0].source, source);
    assert.equal(failed.alerts[0].retryable, true);
    assert.equal(failed.alerts[0].delivery, 'output_only');
    assert.ok(!JSON.stringify(failed).includes('secret-token'));
    assert.equal(reporter(request, createFixtureAdapters(fixture)).status, 'report_ready');
  }
  assert.equal(runSyntheticScenario(fixture, request, 'source_failure').firstRun.alerts[0].code, 'SOURCE_FAILURE');
});

test('invalid, missing, duplicated, out-of-window and oversized rows fail atomically', () => {
  const mutations = [
    (x) => { x.meta.data[0].spend = ''; },
    (x) => { x.meta.data[0].spend = '-1'; },
    (x) => { x.meta.data[0].spend = '1.001'; },
    (x) => { x.meta.data[0].spend = '1000000.01'; },
    (x) => { x.meta.data[0].clicks = '1e2'; },
    (x) => { x.meta.data[0].clicks = 0.5; },
    (x) => { x.meta.data[0].impressions = 1_000_000_001; },
    (x) => { x.meta.data[0].clicks = 1001; },
    (x) => { x.meta.data[0].account_id = 'wrong-account'; },
    (x) => { x.meta.data[0].date_start = '2026-02-30'; },
    (x) => { x.meta.data[0].date_stop = '2026-09-15'; },
    (x) => { x.meta.data[0] = null; },
    (x) => { delete x.meta.data[0]; },
    (x) => { x.meta.data = []; },
    (x) => { x.meta.data.push(x.meta.data[0]); },
    (x) => { x.meta.data[0] = x.meta.data[1]; },
    (x) => { x.ga4.rows.pop(); },
    (x) => { x.ga4.rows[0].date = '20261301'; },
    (x) => { x.ga4.rows[0].date = '20260913'; },
    (x) => { x.ga4.rows[0].sessions = NaN; },
    (x) => { x.ga4.rows[0].purchaseRevenue = Infinity; },
    (x) => { x.ga4.rows[0].keyEvents = null; },
    (x) => { x.ga4.rows[0].sessions = ' 80 '; },
    (x) => { x.ga4.propertyId = 'wrong-property'; },
    (x) => { x.ga4.accountId = 'wrong-account'; },
    (x) => { x.ga4.trafficScope = 'all_site_traffic'; },
    (x) => { x.meta.currency = 'EUR'; },
    (x) => { x.ga4.timezone = 'America/New_York'; },
    (x) => { x.meta.synthetic = false; },
  ];
  for (const mutate of mutations) {
    const reporter = createMarketingReporter();
    const failed = reporter(request, createFixtureAdapters(changeFixture(mutate)));
    assert.equal(failed.status, 'failed', mutate.toString());
    assert.equal(failed.alerts[0].code, 'INVALID_ROWS');
    assert.deepEqual(failed.reports, []);
    assert.equal(reporter(request, createFixtureAdapters(fixture)).status, 'report_ready');
  }
});

test('invalid requests fail before adapter reads, including incomplete or non-Monday weeks', () => {
  let reads = 0;
  const adapters = { meta: { read() { reads++; } } };
  for (const config of [
    null, [], {}, { ...request, agencyId: 'x:y' }, { ...request, accountId: 'x'.repeat(65) },
    { ...request, weekStart: '2026-09-22' }, { ...request, weekStart: '2026-02-30' },
    { ...request, asOf: '2026-09-27' }, { ...request, asOf: '2026-02-30' },
    { ...request, timezone: 'Asia/Kolkata' }, { ...request, currency: '' },
  ]) {
    const result = createMarketingReporter()(config, adapters);
    assert.equal(result.alerts[0].code, 'INVALID_REQUEST');
    assert.equal(result.reportKey, null);
  }
  assert.equal(reads, 0);
  assert.equal(getReportContext({ ...request, weekStart: '2024-03-04', asOf: '2024-03-11' }).prior.start, '2024-02-26');
  assert.equal(getReportContext({ ...request, weekStart: '2026-01-05' }).prior.start, '2025-12-29');
});

test('integer-cent aggregation avoids daily decimal drift; per-row upper bounds remain finite', () => {
  const pennies = changeFixture((input) => {
    input.meta.data.forEach((row) => { row.spend = '0.01'; });
  });
  assert.equal(run(pennies).reports[0].metrics.current.spendCents, 7);
  const large = changeFixture((input) => {
    input.meta.data.forEach((row) => Object.assign(row, {
      spend: '1000000.00', impressions: '1000000000', clicks: '1000000000',
    }));
  });
  const result = run(large);
  assert.equal(result.status, 'report_ready');
  assert.equal(result.reports[0].metrics.current.impressions, 7_000_000_000);
  assert.ok(!/Infinity|NaN/.test(JSON.stringify(result)));
});

test('bounded private ledger fails closed rather than silently evicting replay protection', () => {
  const reporter = createMarketingReporter({ maxReports: 1 });
  const adapters = createFixtureAdapters(fixture);
  reporter(request, adapters);
  assert.equal(reporter({ ...request, agencyId: 'second' }, adapters).alerts[0].code, 'LEDGER_FULL');
  assert.equal(reporter(request, adapters).status, 'duplicate');
  for (const maxReports of [0, 1025, 1.5, NaN]) assert.throws(() => createMarketingReporter({ maxReports }));
});

test('frozen fixtures, snapshot adapters and returned objects cannot mutate ledger fingerprints', () => {
  const input = freeze(structuredClone(fixture));
  assert.deepEqual(run(input, freeze(structuredClone(request))), run());
  const mutable = structuredClone(fixture);
  const adapters = createFixtureAdapters(mutable);
  mutable.meta.data[0].spend = '99';
  adapters.meta.read().data[0].spend = '98';
  const reporter = createMarketingReporter();
  const first = reporter(request, adapters);
  assert.equal(first.reports[0].metrics.prior.spendCents, 7000);
  first.reports[0].metrics.prior.spendCents = 0;
  assert.equal(reporter(request, adapters).status, 'duplicate');
});

test('cost defaults cover 5/15/30 agencies, six accounts each and explicit monthly assumptions', () => {
  const costs = estimateCosts();
  assert.equal(costs.actualLlmCalls, 0);
  assert.equal(costs.actualTokenSpendUsd, 0);
  assert.equal(costs.perSummaryTokenCostUsd, 0.0025);
  assert.equal(costs.assumptions.weeksPerMonth, 52 / 12);
  assert.deepEqual(costs.scenarios.map((row) => [
    row.agencies, row.adAccounts, row.summariesPerMonth, row.tokenMonthlyUsd,
  ]), [[5, 30, 130, 0.325], [15, 90, 390, 0.975], [30, 180, 780, 1.95]]);
  assert.equal(costs.scenarios[0].inputTokensPerMonth, 195000);
  assert.equal(costs.scenarios[0].outputTokensPerMonth, 32500);
  assert.equal(costs.scenarios[0].sourceReadsPerMonth, 260);
  assert.equal(costs.scenarios[0].workflowExecutionsPerMonth, 21.666667);
});

test('configurable tokens, separate token rates, retries and shared platform allowance', () => {
  const costs = estimateCosts({
    agencyCounts: [5], weeksPerMonth: 4, inputTokensPerSummary: 1000,
    outputTokensPerSummary: 500, inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 6, summaryAttemptMultiplier: 1.5, platformMonthlyUsd: 10,
  });
  assert.equal(costs.perSummaryTokenCostUsd, 0.005);
  assert.equal(costs.scenarios[0].summariesPerMonth, 120);
  assert.equal(costs.scenarios[0].summaryAttemptsPerMonth, 180);
  assert.equal(costs.scenarios[0].tokenMonthlyUsd, 0.9);
  assert.equal(costs.scenarios[0].estimatedMonthlyUsd, 10.9);
  assert.equal(costs.scenarios[0].inputTokensPerMonth, 180000);
  assert.equal(costs.scenarios[0].outputTokensPerMonth, 90000);
  const zero = estimateCosts({ inputTokensPerSummary: 0, outputTokensPerSummary: 0, platformMonthlyUsd: 3 });
  assert.ok(zero.scenarios.every((row) => row.tokenMonthlyUsd === 0 && row.estimatedMonthlyUsd === 3));
});

test('invalid and unbounded cost assumptions are rejected instead of coerced', () => {
  for (const config of [
    { agencyCounts: [] }, { agencyCounts: [5, 5] }, { agencyCounts: new Array(1) },
    { agencyCounts: [0] }, { agencyCounts: ['5'] }, { agencyCounts: [1001] },
    { weeksPerMonth: 0 }, { weeksPerMonth: 6 },
    { inputTokensPerSummary: 0.1 }, { outputTokensPerSummary: -1 },
    { inputUsdPerMillionTokens: NaN }, { outputUsdPerMillionTokens: Infinity },
    { inputUsdPerMillionTokens: '1' }, { summaryAttemptMultiplier: 0.5 },
    { platformMonthlyUsd: -1 },
  ]) assert.throws(() => estimateCosts(config));
});

test('workflow is inactive, credential-free, Monday UTC and generated from the tested source', async () => {
  const text = await readFile(new URL('./workflow.json', import.meta.url), 'utf8');
  assert.equal(text, workflowText());
  assert.ok(Buffer.byteLength(text) < 256 * 1024);
  const workflow = JSON.parse(text);
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.timezone, reportingSchedule.timezone);
  assert.deepEqual(workflow.nodes.map((node) => node.type), [
    'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.code',
  ]);
  const schedule = workflow.nodes[1];
  assert.equal(schedule.disabled, true);
  assert.equal(schedule.parameters.rule.interval[0].expression, '0 0 9 * * 1');
  assert.ok(workflow.nodes.every((node) => !node.credentials));
  assert.ok(!/\bfetch\s*\(|\brequire\s*\(|\bimport\s/.test(workflow.nodes[2].parameters.jsCode));
  for (const connections of Object.values(workflow.connections)) {
    assert.equal(connections.main[0][0].node, workflow.nodes[2].name);
  }
});

test('embedded workflow code matches local happy, prior-zero, failure and invalid-row scenarios', () => {
  for (const scenario of ['happy_path', 'prior_zero', 'source_failure', 'invalid_rows']) {
    const workflow = buildWorkflow(scenario);
    const code = workflow.nodes[2].parameters.jsCode;
    const actual = runInNewContext(`(function () { ${code}\n})()`, {}, { timeout: 1000 });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), [{
      json: runSyntheticScenario(fixture, request, scenario),
    }]);
  }
  assert.throws(() => buildWorkflow('unknown'));
  assert.throws(() => runSyntheticScenario(fixture, request, 'unknown'));
});
