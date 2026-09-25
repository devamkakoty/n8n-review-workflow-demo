import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { captureLeads } from './lead-capture.mjs';
import { events, options } from './fixtures.mjs';

// Embed the tested function and small reviewable fixture, not a separate algorithm.
export function buildWorkflow() {
  return {
    name: 'SYNTHETIC - offline lead capture and SLA preview',
    active: false,
    nodes: [
      {
        parameters: {}, id: 'synthetic-manual', name: 'Run synthetic fixture',
        type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0],
      },
      {
        parameters: {
          mode: 'runOnceForAllItems', language: 'javaScript',
          jsCode: [
            '// SYNTHETIC portfolio preview. No credentials, services, messages or CRM writes.',
            captureLeads.toString(),
            `const events = ${JSON.stringify(events, null, 2)};`,
            `const options = ${JSON.stringify(options, null, 2)};`,
            'return [{ json: captureLeads(events, options) }];',
          ].join('\n\n'),
        },
        id: 'synthetic-lead-preview', name: 'Normalize deduplicate and measure - preview only',
        type: 'n8n-nodes-base.code', typeVersion: 2, position: [280, 0],
      },
    ],
    connections: {
      'Run synthetic fixture': {
        main: [[{ node: 'Normalize deduplicate and measure - preview only', type: 'main', index: 0 }]],
      },
    },
    settings: { executionOrder: 'v1' },
  };
}

export const workflowText = () => `${JSON.stringify(buildWorkflow(), null, 2)}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = new URL('./workflow.json', import.meta.url);
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) {
    throw new Error('Usage: node build-workflow.mjs [--check]');
  }
  if (process.argv[2] === '--check') {
    if (await readFile(destination, 'utf8') !== workflowText()) {
      throw new Error('workflow.json is stale; run node examples/lead-capture/build-workflow.mjs');
    }
    console.log('Workflow matches the tested source and synthetic fixture.');
  } else {
    await writeFile(destination, workflowText(), 'utf8');
    console.log(`Wrote inactive workflow: ${fileURLToPath(destination)}`);
  }
}
