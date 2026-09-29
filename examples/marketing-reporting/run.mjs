import { fixture, request } from './fixtures.mjs';
import { runSyntheticScenario } from './scenarios.mjs';

if (process.argv.length > 3) throw new Error('Usage: node run.mjs [scenario]');
const output = runSyntheticScenario(fixture, request, process.argv[2] ?? 'happy_path');
const result = output.firstRun;
console.log('SYNTHETIC marketing reporting demo; no client work, live APIs, LLM or delivery.');
console.log(`Status: ${result.status}; replay: ${output.replay?.status ?? 'not attempted'}`);
console.log(`Report key: ${result.reportKey}`);
for (const line of result.reports[0]?.summary.lines ?? []) console.log(line);
for (const alert of result.alerts) console.log(`ALERT (output only): ${JSON.stringify(alert)}`);
console.log('Hypothetical monthly token costs, six accounts per agency:');
for (const cost of output.costs.scenarios) {
  console.log(`${cost.agencies} agencies: ${cost.summariesPerMonth} summaries, USD ${cost.tokenMonthlyUsd.toFixed(3)}`);
}
if (result.status === 'failed') process.exitCode = 1;
