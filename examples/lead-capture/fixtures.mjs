// Deliberately small, invented fixture: reserved example.test emails and
// fictional NANP 555-01xx numbers. These are not buyer records or API payloads.
export const options = { asOf: '2026-09-25T09:20:00Z', slaSeconds: 300 };

const firstMeta = {
  source: 'meta', eventId: 'm-001', capturedAt: '2026-09-25T09:00:00Z',
  firstResponseAt: '2026-09-25T09:02:00Z',
  payload: {
    full_name: '  Avery   Example  ', email: ' AVERY@EXAMPLE.TEST ',
    phone_number: '+1 (202) 555-0101',
  },
};

export const events = [
  firstMeta,
  {
    source: 'web', eventId: 'w-001', capturedAt: '2026-09-25T09:01:00Z',
    payload: { name: 'Avery Example', email: 'avery@example.test' },
  },
  {
    source: 'web', eventId: 'w-002', capturedAt: '2026-09-25T09:03:00Z',
    firstResponseAt: '2026-09-25T09:10:00Z',
    payload: { name: 'Blake Example', email: 'blake@example.test', phone: '+1-202-555-0102' },
  },
  {
    source: 'whatsapp', eventId: 'wa-001', capturedAt: '2026-09-25T09:04:00Z',
    firstResponseAt: '2026-09-25T09:05:00Z',
    payload: { profile: { name: 'Avery Example' }, from: '+12025550101' },
  },
  {
    source: 'whatsapp', eventId: 'wa-002', capturedAt: '2026-09-25T09:05:00Z',
    payload: { profile: { name: 'Casey Example' }, from: '+1 202 555 0103' },
  },
  {
    source: 'meta', eventId: 'm-002', capturedAt: '2026-09-25T09:18:00Z',
    payload: { full_name: 'Drew Example', email: 'drew@example.test' },
  },
  {
    source: 'web', eventId: 'w-003', capturedAt: '2026-09-25T09:10:00Z',
    firstResponseAt: '2026-09-25T09:15:00Z',
    payload: { name: 'Emery Example', email: 'emery@example.test' },
  },
  structuredClone(firstMeta), // Exact source-event replay, not a second CRM candidate.
];
