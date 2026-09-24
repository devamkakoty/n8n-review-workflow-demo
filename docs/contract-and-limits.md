# HTTP contract, behavior and verification scope

Original, AI-assisted synthetic work sample, **not a client system**. The
planner consumes hardcoded fixture model responses, not a live LLM. Proposals
are inert pending-review text with `autoExecute: false`. No sending, scheduling,
approval execution, external API calls or real data are involved.

## Run the wrapper

From the repository root:

```powershell
node src/server.mjs
```

Default address: `http://127.0.0.1:8787`. Optional process-level `PORT` changes
the port; the bind address is always IPv4 loopback. Stop with Ctrl+C.
No npm install or dependencies are needed. The wrapper writes no files.
Changing the port also requires changing both workflow URLs.

### HTTP contract

- `GET /health`: 200 with `status: "ok"` and `mode: "synthetic_review_only"`.
- `POST /plan`: UTF-8 `application/json` (optional `charset=utf-8`), no content
  encoding. Input is `{ "notes": [...], "enabled": true }`; `enabled` is
  optional. Notes follow the existing planner contract in `src/planner.mjs`.
  Caller-supplied ledger and other envelope fields are rejected.
- Successful envelopes return 200 with `{results, summary}`. Note-level
  `invalid`, `conflict`, `model_unavailable`, `disabled` and `no_actions` remain
  explicit planner statuses, **not** HTTP failures. A mixed batch can therefore
  record successful notes while leaving failed notes retryable.
- HTTP errors return `{ "error": "<static_code>" }`: 400 malformed JSON/UTF-8
  or invalid envelope; 403 nonliteral loopback Host or any Origin header;
  404 unknown route (including query strings); 405 wrong method with `Allow`;
  408 body deadline; 413 oversized body; 415 unsupported media/encoding;
  500 unexpected internal error without source text or stack traces.
- Bodies are bounded to 65,536 bytes, including chunked requests, with a
  five-second body-read deadline. Header size is limited to 8 KiB.
  Low-level malformed HTTP is also subject to Node's HTTP parser; its errors
  need not use the application's JSON envelope.

One private in-memory ledger per server holds only hashes/proposal IDs, up to
the planner's 1,000-note cap. There is no reset or ledger-edit API. Restarting
loses the ledger; this is not durable duplicate protection. A response lost
after planning may still have updated the memory ledger. No multi-process,
load/concurrency, persistence or exactly-once guarantee is claimed.

Local processes are trusted. Loopback binding, literal Host checks and Origin
rejection reduce accidental browser exposure but are **not authentication**.
Do not expose this port through a proxy/tunnel or use real notes. Returned
draft content remains untrusted text and must be escaped if displayed.

## Synthetic n8n workflow

`workflow.json` contains only:

1. Manual Trigger.
2. HTTP Request: POST a static synthetic fixture to `/plan`.
3. HTTP Request: POST the **same static fixture** again.

No Code node, task runner, credentials, webhooks, expressions or integrations
are required by this file. The two requests are connected sequentially; the
second deliberately ignores the first response and replays the original body.

Expected inspection on a **fresh wrapper process**:

- First HTTP node: one `pending_review` result, two proposals (a task and an
  unsent email draft), `summary.proposalCount: 2`, both `autoExecute: false`.
- Replay node: one `duplicate` result, no proposals, `proposalCount: 0`.
- Inspect each node's own output; the final node only shows the replay.
- Running again without restarting yields duplicate at **both** nodes.
  Restart the wrapper for a fresh pending-review demonstration.

Import this inactive workflow into a separately managed local n8n runtime
and run it manually. n8n must run on the same host/network namespace as this wrapper:
container/cloud loopback does not point to the Windows host. Do not change
network/security settings or publicize the wrapper to work around this.

The workflow uses HTTP Request node version4.2 with JSON-body parameters.
See the main README for the distinction between component tests and any
separately recorded n8n-engine execution.

## Component verification

```powershell
node --test test/planner.test.mjs test/server.test.mjs
```

**Verified September 24, 2026:** 20/20 tests passed (11 existing planner tests,
9 wrapper/workflow component tests), zero failures/skips, on Node v22.15.0
and v24.21.0.
The test servers used ephemeral loopback ports and were closed after testing.

Tests cover the existing pure planner plus real loopback HTTP requests for
pending review, replay/conflict, failure/retry, no-actions/disabled, invalid
envelopes/UTF-8, route/method/Host/Origin/media errors, byte limits (including
chunked and multibyte input), body timeout, process-local ledger reset, and
startup port validation. Workflow checks parse its structure and POST its
static bodies directly through Node HTTP; they do **not** import or execute n8n.

**Not verified:** live LLMs, Google/Notion integration, Mac deployment,
approval UI, durable
storage, concurrent/load behavior or any client/household result.
Runtime installation and n8n-engine evidence are separate from these tests.
The pinned n8n2.39.8 runtime imported and executed the workflow successfully
on Node24.21.0. Persisted n8n node outputs confirm two pending-review proposals
followed by a duplicate with zero new proposals. See
[`verification.md`](verification.md) for the evidence and troubleshooting notes.
