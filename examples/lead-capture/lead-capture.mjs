/**
 * Synthetic portfolio logic only: no I/O, credentials, clock reads or CRM writes.
 * Self-contained so the workflow builder can embed this exact function in n8n.
 */
export function captureLeads(events, { asOf, slaSeconds = 300 } = {}) {
  const fail = (message) => { throw new Error(message); };
  const object = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }
    return value;
  };
  const text = (value, label, max = 254) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) {
      fail(`${label} must be a string of at most ${max} characters`);
    }
    return value.trim();
  };
  const instant = (value, label) => {
    if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      fail(`${label} must be an ISO UTC timestamp`);
    }
    const ms = Date.parse(value);
    const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== canonical) {
      fail(`${label} must be a real calendar instant`);
    }
    return new Date(ms).toISOString();
  };
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const round = (n) => Math.round(n * 100) / 100;
  const cutoff = instant(asOf, 'asOf');
  if (!Number.isInteger(slaSeconds) || slaSeconds < 0 || slaSeconds > 86400) {
    fail('slaSeconds must be an integer from 0 to 86400');
  }
  if (!Array.isArray(events) || events.length > 100) {
    fail('events must be an array of at most 100 items');
  }

  // Only these explicit fixture adapters are supported; these are not vendor APIs.
  const rows = Array.from(events, (event) => {
    object(event, 'event');
    const source = text(event.source, 'source', 16);
    const eventId = text(event.eventId, 'eventId', 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(eventId)) fail('eventId is missing or invalid');
    const payload = object(event.payload, 'payload');
    let name, email, phone;
    switch (source) {
      case 'meta':
        ({ full_name: name, email, phone_number: phone } = payload);
        break;
      case 'web':
        ({ name, email, phone } = payload);
        break;
      case 'whatsapp':
        name = object(payload.profile, 'profile').name;
        ({ email, from: phone } = payload);
        break;
      default:
        fail('unsupported source');
    }
    name = text(name, 'name', 120).replace(/\s+/g, ' ');
    email = text(email, 'email').toLowerCase();
    // Intentionally basic ASCII validation, not an email-deliverability check.
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[^\x21-\x7e]/.test(email))) {
      fail('email is invalid');
    }
    phone = text(phone, 'phone', 40);
    if (phone) {
      if (!/^[+0-9 ().-]+$/.test(phone)) fail('phone is invalid');
      phone = phone.replace(/[ ().-]/g, '');
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        fail('phone must include + and country code (8 to 15 digits)');
      }
    }
    if (!email && !phone) fail('a valid email or phone is required');
    const capturedAt = instant(event.capturedAt, 'capturedAt');
    const firstResponseAt = event.firstResponseAt == null
      ? null : instant(event.firstResponseAt, 'firstResponseAt');
    if (capturedAt > cutoff || (firstResponseAt && firstResponseAt > cutoff)) {
      fail('event timestamps cannot be after asOf');
    }
    if (firstResponseAt && firstResponseAt < capturedAt) {
      fail('firstResponseAt cannot precede capturedAt');
    }
    return {
      source, eventId, eventKey: `${source}:${eventId}`, name,
      email: email || null, phone: phone || null, capturedAt, firstResponseAt,
    };
  }).sort((a, b) => compare(a.capturedAt, b.capturedAt) || compare(a.eventKey, b.eventKey));

  // A changed normalized payload under the same namespaced event key is a conflict,
  // not a replay. Validate the whole batch before returning any accepted records.
  const seenEvents = new Map();
  for (const row of rows) {
    const fingerprint = JSON.stringify(row);
    if (seenEvents.has(row.eventKey) && seenEvents.get(row.eventKey) !== fingerprint) {
      fail(`conflicting replay: ${row.eventKey}`);
    }
    seenEvents.set(row.eventKey, fingerprint);
  }

  // Connected components handle an email-only -> email+phone -> phone-only bridge.
  // The earliest capture, then ASCII event key, wins regardless of input ordering.
  const parents = rows.map((_, i) => i);
  const root = (i) => {
    while (parents[i] !== i) i = parents[i];
    return i;
  };
  const identities = new Map();
  rows.forEach((row, i) => {
    for (const key of [row.email && `email:${row.email}`, row.phone && `phone:${row.phone}`]) {
      if (!key) continue;
      if (identities.has(key)) {
        const a = root(i), b = root(identities.get(key));
        parents[Math.max(a, b)] = Math.min(a, b);
      } else {
        identities.set(key, i);
      }
    }
  });
  const groups = new Map();
  rows.forEach((row, i) => {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const crmRecords = [];
  const results = [];
  const bySource = Object.fromEntries(
    ['meta', 'web', 'whatsapp'].map((source) => [source, { received: 0, accepted: 0, duplicate: 0 }]),
  );
  const sla = { thresholdSeconds: slaSeconds, met: 0, late: 0, overdue: 0, pending: 0 };
  const latencies = [];
  for (const group of groups.values()) {
    const first = group[0];
    const leadId = `synthetic:${first.eventKey}`;
    const emails = [...new Set(group.map((r) => r.email).filter(Boolean))].sort(compare);
    const phones = [...new Set(group.map((r) => r.phone).filter(Boolean))].sort(compare);
    const responses = group.map((r) => r.firstResponseAt).filter(Boolean).sort(compare);
    const firstResponseAt = responses[0] ?? null;
    const responseLatencySeconds = firstResponseAt
      ? (Date.parse(firstResponseAt) - Date.parse(first.capturedAt)) / 1000 : null;
    const ageSeconds = (Date.parse(cutoff) - Date.parse(first.capturedAt)) / 1000;
    const slaStatus = responseLatencySeconds === null
      ? (ageSeconds > slaSeconds ? 'overdue' : 'pending')
      : (responseLatencySeconds <= slaSeconds ? 'met' : 'late');
    sla[slaStatus]++;
    if (responseLatencySeconds !== null) latencies.push(responseLatencySeconds);
    crmRecords.push({
      leadId, synthetic: true, writeDisposition: 'preview_only',
      name: group.find((r) => r.name)?.name || null,
      email: group.find((r) => r.email)?.email || null,
      phone: group.find((r) => r.phone)?.phone || null,
      emails, phones, sources: [...new Set(group.map((r) => r.source))].sort(compare),
      firstCapturedAt: first.capturedAt, firstResponseAt,
      responseLatencySeconds, slaStatus,
    });
    const replayKeys = new Set();
    group.forEach((row, index) => {
      const disposition = index === 0 ? 'accepted' : 'duplicate';
      const reason = index === 0 ? 'first_in_contact_group'
        : replayKeys.has(row.eventKey) ? 'source_event_replay' : 'shared_contact_group';
      results.push({ ...row, leadId, disposition, reason });
      replayKeys.add(row.eventKey);
      bySource[row.source].received++;
      bySource[row.source][disposition]++;
    });
  }
  results.sort((a, b) => compare(a.capturedAt, b.capturedAt) || compare(a.eventKey, b.eventKey));
  const responded = latencies.length;
  const evaluated = sla.met + sla.late + sla.overdue;
  return {
    synthetic: true, mode: 'offline_preview', asOf: cutoff,
    crmRecords, results,
    metrics: {
      received: rows.length, accepted: crmRecords.length, duplicate: rows.length - crmRecords.length,
      responded, unanswered: crmRecords.length - responded,
      responseLatencySeconds: {
        mean: responded ? round(latencies.reduce((a, b) => a + b, 0) / responded) : null,
        max: responded ? Math.max(...latencies) : null,
      },
      sla: { ...sla, evaluated, metPercent: evaluated ? round(sla.met / evaluated * 100) : null },
      bySource,
    },
  };
}
