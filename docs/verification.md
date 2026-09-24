# Verification record — September 24, 2026

## Passed

| Check | Observed result |
| --- | --- |
| Planner and HTTP/workflow-fixture tests, Node22.15.0 | 20 passed; zero failures/skips |
| Same tests, Node24.21.0 | 20 passed; zero failures/skips |
| Fresh fixture through the actual local HTTP API | Two pending-review proposals |
| Identical fixture replay through the same API | Duplicate; zero new proposals |
| Pinned n8n runtime installation | n8n2.39.8 installed and version verified |
| n8n workflow import | Exit0; saved inactive workflow matches the reviewed nodes/connections |
| Actual n8nCLI workflow execution | One execution, status`success`, finished=true |
| Saved n8n node outputs | First request: two pending-review proposals; replay: zero proposals |

Component-test command:

```sh
node --test test/planner.test.mjs test/server.test.mjs
```

The component tests exercise actual loopback HTTP. The separate n8n run
executes the workflow through the n8n engine. Both use fixture model responses.

## Actual n8n execution

- Runtime: n8n2.39.8 and Node24.21.0 on Windows.
- Recorded execution: September24,2026,12:26:55.356–12:27:08.963UTC.
- The imported workflow was inactive. The manual workflow was invoked through
  the CLI with its assigned workflow ID and `--rawOutput`.
- The saved inactive workflow was compared with the reviewed source.
- n8n's own persisted execution record reports `success` and `finished=true`.
- The saved execution data was decoded using n8n's installed Flatted
  dependency, then both HTTP-node outputs were checked.
- [`execution-result.json`](execution-result.json) contains the extracted
  synthetic node outputs only, without the private runtime profile/database.
- Its SHA256 is
  `f3afb07619c7b336b3e16574e693274356f33ec600420de9b96d33bcf9a40f09`.
- No sample service was left running. No browser-editor interaction is
  represented as verified; this was a CLI engine execution.

## Troubleshooting history

The first cold-start import exceeded a90-second limit during initialization.
Read-only inspection found partial schema initialization but no imported
workflow. A command-load diagnostic then completed successfully, and the
subsequent import completed against that inspected local state.

The Node24 test harness initially misclassified its spec-reporter output
because it expected TAP. Reviewing the unchanged log confirmed20passes and
exit code0; the tests were not repeated to produce a different result.

An error-only logging setting suppressed the CLI's normal JSON result
output. Rather than rerunning the successful workflow, its stored execution
and actual node outputs were verified read-only. Use normal info logging
when capturing CLI result output.

## Scope

This original, AI-assisted sample has no client data, live LLM calls or
Google/Notion integration. Its duplicate ledger is process-local and resets
when the wrapper restarts. The results do not claim production deployment,
durable exactly-once processing or a completed client engagement.
