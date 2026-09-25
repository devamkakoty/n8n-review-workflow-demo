# Multi-source lead capture: synthetic CRM preview

**One reviewable lead record per contact group, with duplicate dispositions
and a clear view of response delays.**

This original, AI-assisted **synthetic portfolio example** addresses the
requested buyer scenario: Meta/web/WhatsApp-like lead capture into a CRM,
duplicate prevention, and response/SLA visibility. It is not client work,
a production deployment, or evidence of a completed buyer engagement.
All contacts and response timestamps are invented.

## Run locally

From the `n8n-review-demo` repository root, using Node.js 22 or newer:

```sh
node examples/lead-capture/run.mjs
node --test examples/lead-capture/lead-capture.test.mjs
node examples/lead-capture/build-workflow.mjs --check
```

No install, credentials, API, listener, network request, or real service is
needed. The runner prints a small summary; it writes no data.
The original demo and its existing `npm test` command are unchanged.

### Optional n8n view

Import this directory's `workflow.json`, **not the root demo workflow**.
It is inactive and contains only a Manual Trigger and a JavaScript Code node.
Run manually and inspect `crmRecords`, `results`, and `metrics` in the Code
node output. There is no CRM, messaging, HTTP, webhook, or scheduled node.
The code ignores incoming items and always uses the embedded synthetic fixture.
Repeated manual runs recompute the same preview; nothing is persisted.

`build-workflow.mjs` embeds the exact tested function and fixture. After
editing either, regenerate this small workflow configuration with:

```sh
node examples/lead-capture/build-workflow.mjs
```

## Inspectable result

The eight-event fixture produces:

| Measure | Synthetic result |
| --- | --- |
| Accepted / duplicate events | 5 / 3 |
| CRM-ready **preview** records | 5; **zero CRM writes** |
| Responded / unanswered contact groups | 3 / 2 |
| Mean / maximum first-response latency | 280 / 420 seconds |
| Five-minute SLA | 2 met, 1 late response, 1 unanswered overdue, 1 pending |
| SLA met among evaluated groups | 50% (2 of 4; pending excluded) |

Avery appears in all three channels plus a repeated Meta event, yet generates
only one CRM preview. Each event remains inspectable with a normalized
identity, its source/event key, `accepted` or `duplicate`, a reason, and the
canonical `leadId`. Acceptance means inclusion in this preview, not a saved
CRM record, a qualified lead, consent, or an actual response.

## Input and deterministic rules

`captureLeads(events, { asOf, slaSeconds: 300 })` is a pure function.
The deliberately simplified fixtures share `source`, `eventId`,
`capturedAt`, optional `firstResponseAt`, and `payload`:

| Source | Synthetic payload fields |
| --- | --- |
| `meta` | `full_name`, `email`, `phone_number` |
| `web` | `name`, `email`, `phone` |
| `whatsapp` | `profile.name`, `from` (international phone), optional `email` |

These are **not vendor webhook schemas**. Only listed fields are used.

- Trim names and collapse whitespace; trim/lowercase ASCII emails.
  Email syntax checks are basic, not deliverability checks. Plus-addresses
  and dots are preserved; names are never matching keys.
- Strip common phone formatting, but require an explicit `+` and country
  code (8-15 digits). No guessed country, extension parsing, or number lookup.
  At least one valid email or phone is required.
- Equal normalized email **or** phone joins a contact group, transitively.
  Sort by earliest capture, then ASCII `source:eventId`; the first event
  is accepted, others are duplicates. Exact source-event replays count as
  duplicate events, not new leads. Input ordering does not change output.
- Reusing the same namespaced event key with changed normalized fields
  fails the whole batch, including changed response timestamps. This is an
  immutable snapshot example, not an incremental event-update API.
- CRM preview fields use the earliest available nonempty name/email/phone;
  all distinct normalized emails, phones, and sources are retained.
- Bound: 100 events, 80-character event IDs, 120-character names,
  254-character emails, 40-character raw phones, and SLA 0-86,400 seconds.
  This is not a general-purpose untrusted JavaScript object sandbox.
  Invalid input fails atomically rather than producing partial acceptance.

## Metric definitions

- All instants must be real calendar dates in UTC ISO form
  `YYYY-MM-DDTHH:mm:ssZ` or with exactly three millisecond digits.
  `asOf` is explicit; no system clock is used. Future observations and
  responses before their event's capture are rejected.
- First-response latency = earliest supplied response in the contact group
  minus its earliest capture. Responses on duplicates can supply that first
  response, but do not inflate the responded count.
- A response at or before the SLA threshold is `met`; later is `late`.
  Without a response, age strictly greater than the threshold is `overdue`;
  otherwise it is `pending`. Exact deadline equality is still pending.
- Mean/max include only responded unique groups. SLA met percentage =
  `met / (met + late + overdue) * 100`; pending groups are excluded.
  Empty denominators produce `null`, not 0% or 100%. Mean and percentage
  are rounded to two decimals. Per-source counts describe event dispositions,
  not unique-person attribution or source performance.

## Evidence and scope

The local tests cover fixture totals, normalized fields, replays/conflicts,
transitive matches, reordered inputs, bounds, timestamp validation, SLA
boundaries, missing responses, and frozen inputs. They also check inactive
workflow structure, source parity, absence of credentials/network nodes,
and execute its embedded JavaScript in a bounded Node VM.
**That is component verification, not an actual n8n import or engine run.**

On September 25, 2026, **33/33 tests passed on Node.js 22.15.0**:
13 for this example and all 20 existing regression tests. Combined command:

```sh
node --test examples/lead-capture/lead-capture.test.mjs test/planner.test.mjs test/server.test.mjs
```

The example has no external dependencies and adds no runtime installation.
Everything lives in this directory; no existing core behavior is modified.

Production work would require agreed matching rules (shared family/team
contacts can falsely merge), authenticated vendor adapters, consent handling,
durable deduplication and CRM upserts, retries, access controls, and real
response-event instrumentation. This batch-only sample has no cross-run
ledger, concurrent-write protection, consent inference, or exactly-once
guarantee. Canonical IDs can change when an earlier event is added.

### Files

- `lead-capture.mjs`: normalization, grouping, CRM preview and metrics.
- `fixtures.mjs`: eight small, invented source events and fixed observation time.
- `run.mjs`: bounded local summary.
- `build-workflow.mjs` / `workflow.json`: reproducible inactive n8n configuration.
- `lead-capture.test.mjs`: dependency-free Node tests.
