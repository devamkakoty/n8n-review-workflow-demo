import { captureLeads } from './lead-capture.mjs';
import { events, options } from './fixtures.mjs';

const { metrics, crmRecords } = captureLeads(events, options);
// Bounded summary of the eight-record synthetic fixture; no data file is written.
console.log(JSON.stringify({
  notice: 'Synthetic portfolio work; CRM preview only; no messages sent.',
  metrics,
  crmPreview: crmRecords.map(({ leadId, responseLatencySeconds, slaStatus }) => ({
    leadId, responseLatencySeconds, slaStatus,
  })),
}, null, 2));
