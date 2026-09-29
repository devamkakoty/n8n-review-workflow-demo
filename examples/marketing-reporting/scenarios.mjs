import { createFixtureAdapters } from './adapters.mjs';
import { createMarketingReporter } from './reporting.mjs';
import { estimateCosts } from './costs.mjs';

export function runSyntheticScenario(fixture, request, scenario = 'happy_path') {
  if (!['happy_path', 'prior_zero', 'source_failure', 'invalid_rows'].includes(scenario)) {
    throw new TypeError('Unknown synthetic scenario');
  }
  const input = JSON.parse(JSON.stringify(fixture));
  if (scenario === 'prior_zero') {
    for (const row of input.meta.data.slice(0, 7)) {
      row.spend = '0.00'; row.impressions = '0'; row.clicks = '0';
    }
    for (const row of input.ga4.rows.slice(0, 7)) {
      row.sessions = '0'; row.keyEvents = '0'; row.purchaseRevenue = '0.00';
    }
  }
  if (scenario === 'invalid_rows') input.meta.data[0].spend = '-1.00';
  const adapters = createFixtureAdapters(input, {
    failSource: scenario === 'source_failure' ? 'ga4' : null,
  });
  const report = createMarketingReporter();
  const firstRun = report(request, adapters);
  return {
    synthetic: true, scenario, firstRun,
    replay: firstRun.status === 'report_ready' ? report(request, adapters) : null,
    costs: estimateCosts(),
  };
}
