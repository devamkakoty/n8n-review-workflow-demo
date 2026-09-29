import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureAdapters, getReportContext, normalizeWeeklyMetrics } from './adapters.mjs';
import { createMarketingReporter, reportingSchedule, weekOverWeek } from './reporting.mjs';
import { estimateCosts } from './costs.mjs';
import { fixture, request } from './fixtures.mjs';
import { runSyntheticScenario } from './scenarios.mjs';

export function buildWorkflow(scenario = 'happy_path') {
  if (!['happy_path', 'prior_zero', 'source_failure', 'invalid_rows'].includes(scenario)) {
    throw new TypeError('Unknown synthetic scenario');
  }
  const previewName = 'Synthetic weekly report and replay';
  const code = [
    '// SYNTHETIC ONLY. No client data, credentials, network, LLM or message delivery.',
    '// Fixed historical weeks. The ledger is reset per execution; replay is demonstrated inside it.',
    `const reportingSchedule = ${JSON.stringify(reportingSchedule)};`,
    ...[
      createFixtureAdapters, getReportContext, normalizeWeeklyMetrics,
      weekOverWeek, createMarketingReporter, estimateCosts, runSyntheticScenario,
    ].map((fn) => fn.toString()),
    `const fixture = ${JSON.stringify(fixture, null, 2)};`,
    `const request = ${JSON.stringify(request, null, 2)};`,
    `const scenario = ${JSON.stringify(scenario)};`,
    'return [{ json: runSyntheticScenario(fixture, request, scenario) }];',
  ].join('\n\n');
  return {
    name: 'SYNTHETIC - weekly Meta and GA4 reporting preview',
    active: false,
    nodes: [
      {
        id: 'marketing-manual', name: 'Run synthetic fixture',
        type: 'n8n-nodes-base.manualTrigger', typeVersion: 1,
        parameters: {}, position: [0, 0],
      },
      {
        id: 'marketing-monday', name: 'Monday 09:00 UTC - disabled',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2, disabled: true, position: [0, 200],
        parameters: {
          rule: { interval: [{ field: 'cronExpression', expression: reportingSchedule.cron }] },
        },
        notes: 'Schedule metadata only. Disabled; fixed historical fixture, not rolling live reporting.',
        notesInFlow: true,
      },
      {
        id: 'marketing-preview', name: previewName,
        type: 'n8n-nodes-base.code', typeVersion: 2, position: [320, 0],
        parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code },
        notes: 'Inspect firstRun.reports, firstRun.alerts, replay and costs. Alerts are output only, never sent.',
        notesInFlow: true,
      },
    ],
    connections: Object.fromEntries(['Run synthetic fixture', 'Monday 09:00 UTC - disabled'].map(
      (name) => [name, { main: [[{ node: previewName, type: 'main', index: 0 }]] }],
    )),
    settings: { executionOrder: 'v1', timezone: 'UTC' },
  };
}

export const workflowText = () => `${JSON.stringify(buildWorkflow(), null, 2)}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) {
    throw new Error('Usage: node build-workflow.mjs [--check]');
  }
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const actualDirectory = await realpath(directory);
  const destination = resolve(directory, 'workflow.json');
  if (!/^D:[\\/]/i.test(actualDirectory) || resolve(actualDirectory) !== resolve(directory)
      || relative(actualDirectory, destination) !== 'workflow.json') {
    throw new Error('Workflow destination must stay in this example directory on D:');
  }
  const existing = await lstat(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && !existing.isFile()) throw new Error('Workflow destination must be a regular file');
  const text = workflowText();
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Workflow exceeds the example size bound');
  if (process.argv[2] === '--check') {
    if (await readFile(destination, 'utf8') !== text) throw new Error('workflow.json is stale; rebuild it');
    console.log('Workflow matches tested source and synthetic fixtures.');
  } else {
    await writeFile(destination, text, 'utf8');
    console.log(`Wrote inactive synthetic workflow: ${destination} (${Buffer.byteLength(text)} bytes)`);
  }
}
