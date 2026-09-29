// Simplified, synthetic source contracts, not live vendor API clients.
export function createFixtureAdapters(fixture, { failSource = null } = {}) {
  if (![null, 'meta', 'ga4'].includes(failSource)) {
    throw new TypeError('failSource must be meta, ga4 or null');
  }
  // JSON-shaped fixtures also run in n8n's Code sandbox without Node-only globals.
  const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const snapshot = copy(fixture);
  return Object.fromEntries(['meta', 'ga4'].map((source) => [source, {
    read() {
      if (source === failSource) throw new Error('Synthetic source unavailable');
      return copy(snapshot?.[source]);
    },
  }]));
}

export function getReportContext(request) {
  const invalid = () => { throw new TypeError('Invalid report request'); };
  if (!request || typeof request !== 'object' || Array.isArray(request)) invalid();
  for (const field of ['agencyId', 'accountId', 'propertyId']) {
    if (typeof request[field] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request[field])) invalid();
  }
  if (typeof request.currency !== 'string' || !/^[A-Z]{3}$/.test(request.currency)) invalid();
  if (request.timezone !== 'UTC') invalid();
  function date(value) {
    if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) invalid();
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
    return parsed;
  }
  const current = date(request.weekStart);
  const asOf = date(request.asOf);
  if (current.getUTCDay() !== 1) invalid();
  const day = 86_400_000;
  if (asOf.getTime() < current.getTime() + 7 * day) invalid();
  const iso = (offset) => new Date(current.getTime() + offset * day).toISOString().slice(0, 10);
  const days = Array.from({ length: 14 }, (_, i) => iso(i - 7));
  const key = [
    'synthetic-marketing', 'v1', request.agencyId, request.accountId,
    request.propertyId, request.currency, request.timezone, request.weekStart,
  ].join(':');
  return {
    key, agencyId: request.agencyId, accountId: request.accountId,
    propertyId: request.propertyId, currency: request.currency, timezone: 'UTC',
    current: { start: iso(0), end: iso(6) },
    prior: { start: iso(-7), end: iso(-1) },
    days,
  };
}

export function normalizeWeeklyMetrics(source, response, context) {
  const invalid = () => { throw new TypeError('Invalid or incomplete synthetic source rows'); };
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!['meta', 'ga4'].includes(source) || !object(response)) invalid();
  if (response.synthetic !== true || response.timezone !== 'UTC'
      || response.currency !== context.currency) invalid();
  if (source === 'ga4'
      && (response.propertyId !== context.propertyId || response.accountId !== context.accountId
      || response.trafficScope !== 'synthetic_meta_paid')) invalid();
  const rows = source === 'meta' ? response.data : response.rows;
  // Exactly one row per day, including explicit zero days. Missing is not zero.
  if (!Array.isArray(rows) || rows.length !== 14) invalid();
  const byDate = new Map();
  function count(value) {
    if (!['number', 'string'].includes(typeof value)) invalid();
    const text = String(value);
    if (!/^(0|[1-9]\d{0,9})$/.test(text)) invalid();
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number > 1_000_000_000) invalid();
    return number;
  }
  function cents(value) {
    if (!['number', 'string'].includes(typeof value)) invalid();
    const text = String(value);
    if (!/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(text)) invalid();
    const [whole, fraction = ''] = text.split('.');
    const number = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (number > 100_000_000) invalid();
    return number;
  }
  for (const row of rows) {
    if (!object(row)) invalid();
    let date;
    let metrics;
    if (source === 'meta') {
      date = row.date_start;
      if (row.account_id !== context.accountId || row.date_stop !== date) invalid();
      metrics = {
        spendCents: cents(row.spend), impressions: count(row.impressions), clicks: count(row.clicks),
      };
      if (metrics.clicks > metrics.impressions) invalid();
    } else {
      if (typeof row.date !== 'string' || !/^\d{8}$/.test(row.date)) invalid();
      date = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`;
      metrics = {
        sessions: count(row.sessions), keyEvents: count(row.keyEvents),
        revenueCents: cents(row.purchaseRevenue),
      };
    }
    if (!context.days.includes(date) || byDate.has(date)) invalid();
    byDate.set(date, metrics);
  }
  function sum(days) {
    const totals = source === 'meta'
      ? { spendCents: 0, impressions: 0, clicks: 0 }
      : { sessions: 0, keyEvents: 0, revenueCents: 0 };
    for (const date of days) {
      const row = byDate.get(date);
      if (!row) invalid();
      for (const field of Object.keys(totals)) totals[field] += row[field];
    }
    return totals;
  }
  return { prior: sum(context.days.slice(0, 7)), current: sum(context.days.slice(7)) };
}
