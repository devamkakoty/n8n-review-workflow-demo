import { getReportContext, normalizeWeeklyMetrics } from './adapters.mjs';

export const reportingSchedule = Object.freeze({
  weekday: 'Monday', hour: 9, minute: 0, timezone: 'UTC',
  cron: '0 0 9 * * 1', reportingPeriod: 'previous complete Monday-Sunday',
  active: false,
});

export function weekOverWeek(current, prior) {
  if (![current, prior].every((value) => typeof value === 'number'
      && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('Metrics must be finite nonnegative safe numbers');
  }
  const absolute = current - prior;
  if (prior === 0) {
    return { absolute, percent: current === 0 ? 0 : null, status: current === 0 ? 'both_zero' : 'prior_zero' };
  }
  const percent = absolute / prior * 100;
  if (!Number.isFinite(percent)) return { absolute, percent: null, status: 'out_of_range' };
  return { absolute, percent: Number(percent.toFixed(2)), status: 'comparable' };
}

export function createMarketingReporter({ maxReports = 128 } = {}) {
  if (!Number.isInteger(maxReports) || maxReports < 1 || maxReports > 1024) {
    throw new TypeError('maxReports must be 1-1024');
  }
  const ledger = new Map();
  return function report(request, adapters) {
    let context;
    const base = {
      synthetic: true, mode: 'offline_preview', schedule: { ...reportingSchedule },
      delivery: 'not_sent',
    };
    function failure(code, stage, source, retryable) {
      const messages = {
        INVALID_REQUEST: 'Report identity, UTC dates or completed-week window is invalid.',
        SOURCE_FAILURE: 'A synthetic source read failed; no report was committed.',
        INVALID_ROWS: 'Source rows are invalid or incomplete; no report was committed.',
        REPORT_CONFLICT: 'This report key already has different normalized metrics.',
        LEDGER_FULL: 'Demo ledger is full; no report was committed.',
      };
      return {
        ...base, status: 'failed', reportKey: context?.key ?? null, reports: [],
        alerts: [{
          severity: 'error', code, stage, source, reportKey: context?.key ?? null,
          retryable, message: messages[code], delivery: 'output_only',
        }],
      };
    }
    try {
      context = getReportContext(request);
    } catch {
      return failure('INVALID_REQUEST', 'validation', null, false);
    }
    const weekly = {};
    for (const source of ['meta', 'ga4']) {
      let response;
      try {
        response = adapters[source].read();
      } catch {
        // Never expose adapter exception messages, credentials or raw rows in alerts.
        return failure('SOURCE_FAILURE', 'source_read', source, true);
      }
      try {
        weekly[source] = normalizeWeeklyMetrics(source, response, context);
      } catch {
        return failure('INVALID_ROWS', 'normalization', source, false);
      }
    }
    const prior = { ...weekly.meta.prior, ...weekly.ga4.prior };
    const current = { ...weekly.meta.current, ...weekly.ga4.current };
    const fingerprint = JSON.stringify({ prior, current });
    if (ledger.has(context.key)) {
      if (ledger.get(context.key) !== fingerprint) {
        return failure('REPORT_CONFLICT', 'idempotency', null, false);
      }
      return { ...base, status: 'duplicate', reportKey: context.key, reports: [], alerts: [] };
    }
    if (ledger.size >= maxReports) return failure('LEDGER_FULL', 'idempotency', null, false);
    const changes = Object.fromEntries(
      Object.keys(current).map((metric) => [metric, weekOverWeek(current[metric], prior[metric])]),
    );
    const roundedRatio = (a, b, scale = 1) => b === 0 ? null : Number((a / b * scale).toFixed(2));
    function derived(metrics) {
      return {
        ctrPercent: roundedRatio(metrics.clicks, metrics.impressions, 100),
        cpc: roundedRatio(metrics.spendCents, metrics.clicks, 0.01),
        costPerKeyEvent: roundedRatio(metrics.spendCents, metrics.keyEvents, 0.01),
        revenueToSpend: roundedRatio(metrics.revenueCents, metrics.spendCents),
      };
    }
    const change = (metric) => {
      const value = changes[metric];
      if (value.percent === null) return 'n/a; prior zero';
      return `${value.percent > 0 ? '+' : ''}${value.percent.toFixed(2)}%`;
    };
    const summary = {
      synthetic: true, generator: 'deterministic_template_v1', llmCalled: false,
      lines: [
        `SYNTHETIC | ${context.agencyId}/${context.accountId} | ${context.current.start} to ${context.current.end} (UTC).`,
        `Meta spend ${context.currency} ${(current.spendCents / 100).toFixed(2)} (${change('spendCents')} WoW); clicks ${current.clicks} (${change('clicks')} WoW).`,
        `GA4 scoped sessions ${current.sessions} (${change('sessions')} WoW); key events ${current.keyEvents} (${change('keyEvents')} WoW).`,
        `GA4 scoped revenue ${context.currency} ${(current.revenueCents / 100).toFixed(2)} (${change('revenueCents')} WoW).`,
        'Preview only; inspect attribution and data freshness before any client delivery.',
      ],
    };
    const output = {
      ...base, status: 'report_ready', reportKey: context.key, alerts: [],
      reports: [{
        reportKey: context.key, agencyId: context.agencyId, accountId: context.accountId,
        propertyId: context.propertyId, currency: context.currency, timezone: context.timezone,
        windows: { current: context.current, prior: context.prior },
        metrics: { current, prior }, changes,
        derived: { current: derived(current), prior: derived(prior) }, summary,
      }],
    };
    ledger.set(context.key, fingerprint);
    return output;
  };
}
