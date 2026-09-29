// Deliberately small, reviewable test data. All identities and metrics are invented.
export const request = {
  agencyId: 'agency-demo', accountId: 'ad-demo-01', propertyId: 'property-demo',
  currency: 'USD', timezone: 'UTC', weekStart: '2026-09-21', asOf: '2026-09-28',
};

const days = [
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27',
];

export const fixture = {
  meta: {
    synthetic: true, currency: 'USD', timezone: 'UTC',
    data: days.map((date, index) => ({
      account_id: request.accountId, date_start: date, date_stop: date,
      spend: index < 7 ? '10.00' : '12.00',
      impressions: index < 7 ? '1000' : '1200', clicks: index < 7 ? '100' : '120',
    })),
  },
  ga4: {
    synthetic: true, currency: 'USD', timezone: 'UTC', trafficScope: 'synthetic_meta_paid',
    propertyId: request.propertyId, accountId: request.accountId,
    rows: days.map((date, index) => ({
      date: date.replaceAll('-', ''),
      sessions: index < 7 ? '80' : '100', keyEvents: index < 7 ? '4' : '5',
      purchaseRevenue: index < 7 ? '40.00' : '50.00',
    })),
  },
};
