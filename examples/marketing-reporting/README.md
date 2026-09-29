# Synthetic weekly marketing reporting

**A complete weekly Meta Ads / GA4 reporting preview, with replay protection,
explicit failure alerts and inspectable cost assumptions.**

This is an original, AI-assisted **synthetic demonstration**, not client work
or a production deployment. Every identity and metric is invented. There are
no live credentials, API requests, LLM calls, notifications or report deliveries.
It uses Node.js built-in modules only and requires no install.

## Run

From `services/n8n-review-demo`, with Node.js 22 or newer:

```sh
node examples/marketing-reporting/run.mjs
node examples/marketing-reporting/run.mjs prior_zero
node examples/marketing-reporting/run.mjs source_failure
node examples/marketing-reporting/run.mjs invalid_rows
node --test examples/marketing-reporting/marketing-reporting.test.mjs
node examples/marketing-reporting/build-workflow.mjs --check
```

The runner prints a bounded preview and writes no data. Failure scenarios
intentionally exit with code **1**; successful scenarios exit with **0**.
The root `npm test` command remains focused on the original service. Run the
complete regression set, including this example, with:

```sh
npm run test:all
```

## Reporting Contract

`createMarketingReporter()` returns a synchronous `report(request, adapters)`
function with a private, bounded in-memory ledger. `createFixtureAdapters()`
provides isolated, synchronous `meta.read()` and `ga4.read()` fixtures, plus a
`failSource` switch. The fixtures are small JSON-shaped test inputs, not a
general-purpose untrusted JavaScript object sandbox.

One invocation handles one agency/ad-account/GA4-property mapping and two
complete UTC weeks. The fixed example reports **September 21-27, 2026**
against **September 14-20, 2026**, as observed September 28. `weekStart` must
be a Monday, and `asOf` must be a valid UTC calendar date at least seven days
later. `asOf` is explicit, not taken from the computer clock.

These deliberately simplified adapters are **not vendor API schemas**:

| Source | Fixture Contract | Normalized Metrics |
| --- | --- | --- |
| Meta Ads | `data`: daily `date_start`, `date_stop`, `account_id`, `spend`, `impressions`, `clicks` | `spendCents`, `impressions`, `clicks` |
| GA4 | `rows`: daily `date` as `YYYYMMDD`, `sessions`, `keyEvents`, `purchaseRevenue` | `sessions`, `keyEvents`, `revenueCents` |

Each response declares `synthetic`, `currency` and `timezone`. GA4 also declares
`propertyId`, `accountId` and `trafficScope: synthetic_meta_paid`. These are
fixture assumptions, not evidence of real attribution. GA4 metrics remain
separate from Meta metrics; no platform conversions are added to GA4 events.
Revenue-to-spend and cost-per-key-event are arithmetic on this scoped fixture,
not audited ROAS or an attribution claim.

- Exactly 14 distinct daily rows per source, one for each day of the two
  weeks. Missing days are errors, not fabricated zeros. Extra dates, duplicate
  days, malformed rows, mismatched accounts/properties/currencies/timezones
  and unscoped GA4 traffic fail the report atomically.
- IDs use 1-64 ASCII letters, digits, underscores or hyphens. Dates are real
  calendar dates in 2000-2099. UTC only; no FX conversion or timezone guessing.
- Counts are nonnegative integers at most 1,000,000,000 per day. Amounts are
  nonnegative, have at most two decimal places and are at most 1,000,000 currency
  units per day. Only currencies with two-decimal units fit this demo's
  money contract. Blank, exponential, signed and whitespace-padded numeric
  strings are rejected; input is not silently coerced into zero.
- Money is summed in integer cents. Weekly counts are summed before computing
  CTR, CPC, cost per key event and revenue-to-spend, rather than averaging daily
  ratios. Derived ratios have two decimals and return `null` on zero denominators.
- Every base metric has an absolute WoW change and a two-decimal percentage.
  A positive current value with prior zero yields `percent: null`,
  `status: prior_zero`, rendered as `n/a; prior zero`. Both zero yields 0%;
  a decline to zero from a positive prior yields -100%. No fabricated 100%
  growth or nonfinite JSON numbers.
- The deterministic summary has exactly five lines and `llmCalled: false`.
  It states observations, not invented causal explanations or recommendations.

### Replay And Failures

The versioned key is:

```text
synthetic-marketing:v1:<agency>:<account>:<property>:<currency>:UTC:<weekStart>
```

It excludes execution time. Equal normalized weekly metrics under the same
key return `status: duplicate`, `reports: []`. Changed weekly metrics under
that key return `REPORT_CONFLICT`; they do not overwrite the first report.
Input order or equivalent numeric formatting does not affect comparison.
Changes to daily distributions that preserve weekly totals are intentionally
equivalent, not a raw-source revision audit.

All rows are validated before committing a key. A failed attempt can be retried
with corrected data. Even replays read and validate sources before comparison.
The ledger defaults to 128 reports (configurable 1-1024) and fails closed when
full rather than evicting replay protection. Independent reporter instances
have independent ledgers. There is no persistence, cross-process concurrency
protection, revision publishing or exactly-once delivery claim.

Failures produce `status: failed`, `reports: []` and an explicit `alerts` array
containing `code`, `stage`, `source`, `reportKey`, `severity`, `retryable` and a
sanitized message. Codes are `INVALID_REQUEST`, `SOURCE_FAILURE`, `INVALID_ROWS`,
`REPORT_CONFLICT` and `LEDGER_FULL`. Source exceptions are never echoed.
Alerts have `delivery: output_only`; reports have `delivery: not_sent`.
No retry or notification is actually dispatched.

## Cost Model

`estimateCosts(options)` models one weekly summary per account, **six accounts
per agency**, for **5, 15 and 30 agencies** by default. The input/output token
counts and separate USD rates per million tokens are configurable, as are
weeks per month, a summary-attempt multiplier and a shared platform allowance.
Defaults are illustrative arithmetic inputs, **not current vendor quotes**.

```js
estimateCosts({
  inputTokensPerSummary: 1500,
  outputTokensPerSummary: 250,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 4,
  weeksPerMonth: 52 / 12,
  summaryAttemptMultiplier: 1,
  platformMonthlyUsd: 0,
});
```

Per-summary token cost = `(inputTokens * inputRate + outputTokens * outputRate)
/ 1,000,000`. Monthly token cost = summaries/week * weeks/month *
attempt multiplier * per-summary cost. A zero platform allowance means
**not estimated**, not free hosting. It is added once per scenario, not once
per agency. The attempt multiplier models extra summary-token consumption,
not extra source reads or workflow executions.

| Agencies | Ad Accounts | Summaries/Month | Hypothetical Token USD/Month |
| --- | --- | --- | --- |
| 5 | 30 | 130 | 0.325 |
| 15 | 90 | 390 | 0.975 |
| 30 | 180 | 780 | 1.950 |

The 52/12 convention is an annualized month, not an actual calendar schedule
count. Workload estimates assume one batched workflow execution per agency
per week and two source reads per account covering both weeks. The importable
fixture below does not implement that agency-level fan-out. Pagination,
API fees, taxes, labor, storage, ad spend and other LLM calls are excluded.
Actual LLM calls and token spending in this demo are **zero**.

## Optional n8n Workflow

Import this directory's `workflow.json`, not the root workflow. It contains a
Manual Trigger, a **disabled** Schedule Trigger and a Code node. The workflow
is inactive. Monday schedule metadata is **09:00 UTC**, cron `0 0 9 * * 1`.
Manual execution runs the fixed synthetic weeks, not a rolling live report.
Leave the schedule disabled; enabling it would only repeat historical fixtures.

Inspect `firstRun.reports`, `firstRun.alerts`, `replay` and `costs`. The Code
node's `scenario` constant can be `happy_path`, `prior_zero`, `source_failure`
or `invalid_rows`. It ignores incoming data and uses embedded fixtures.
Replay is demonstrated inside one execution; its ledger resets on the next
n8n execution. There are no network, LLM or delivery nodes.

The builder embeds the exact tested functions and small reviewable fixture:

```sh
node examples/marketing-reporting/build-workflow.mjs
```

It validates the output destination inside this example on `D:` and caps the
generated configuration at 256 KiB. No dependencies or runtime installations
are added.

## Verification And Limits

On **September 29, 2026**, Node.js **22.15.0** passed **17/17 example tests**
and **50/50 tests including the existing suites**. Tests cover normalization,
zero baselines, replay/conflicts, recovery, invalid rows, bounds, isolation,
cost assumptions and workflow/source parity. Each embedded workflow scenario
is executed in a bounded Node VM with no injected globals.

**This is component and workflow-fixture verification, not a verified n8n
engine import or execution.** No n8n runtime was installed or activated.
The CLI's source-failure output and expected nonzero exit were also checked.

Production deployment would additionally require authenticated live adapters,
pagination, source freshness checks, agreed timezone/currency/attribution
rules, real account mapping, timeouts and backoff, durable transactional keys,
an outbox/delivery ledger, monitoring, access controls and retention policy.
This example demonstrates those reporting boundaries without claiming to
implement the surrounding production infrastructure.

## Files

- `adapters.mjs`: fixture adapters, request validation and weekly normalization.
- `reporting.mjs`: metrics, deterministic summary, replay ledger and alert output.
- `costs.mjs`: configurable workload and token-cost estimates.
- `fixtures.mjs`: deliberately small invented source rows and fixed dates.
- `scenarios.mjs` / `run.mjs`: shared scenarios and bounded CLI.
- `build-workflow.mjs` / `workflow.json`: reproducible inactive n8n configuration.
- `marketing-reporting.test.mjs`: dependency-free component and workflow tests.
