# B5 validation run — 2026-11-07 (automatic gate only)

## Execution

- PR: #40 (Draft), branch: `refactor/architecture-b1-b5-review-20261104`
- Head tested: `986ca16316b946d4b090f3ac3656a7f13b18f421`
- Workflow: [Tests run 42386756255, attempt 2](https://github.com/WeiqiaoCode/noname-ai/actions/runs/42386756255)
- Trigger: explicitly re-ran GitHub Actions Node 22 job; run 2 concluded **success**.
- Node 18/20/22: all workflow jobs concluded success.
- Node 22 job logs: semantic-audit snapshot verification passed; `npm test` passed.

### Test results (from Node 22 job logs)

| Test gate | Result |
| --- | --- |
| Main gate `run_tests.mjs` | 1,899 assertions passed |
| Phase/AOE | 31 passed |
| Decision tracing | 24 passed |
| Decision transactions | 33 passed |
| Configuration schema | 130 passed |
| Execution gateway | 88 passed |
| Decision quality baseline | 57 passed |
| B1-L01 async plugin lifecycle | 3 subtests passed, 0 failed |
| B1-F01..F04 legacy feature ABI | 3 subtests passed, 0 failed |

Note: counts above are reported by individual scripts and **must not be summed as unique gameplay scenarios**.

## B5 acceptance matrix

| Scenario | Status on 2026-11-07 | Required next proof |
| --- | --- | --- |
| Repository CI, semantic snapshot, Node integration fixtures | PASS | Keep green on final head |
| Loading / repeated installation / unloading on real Noname | PREVIOUS PARTIAL EVIDENCE (1.11.7); not rerun | Target-version client log, idempotent install/uninstall |
| Controlled real skill success, ordinary and silent cancellation | PREVIOUS PARTIAL EVIDENCE (1.11.7); not rerun | Preserve 13 controlled checks; test natural choices |
| Old callback late-finish/cancel and page-reload new match | PREVIOUS PARTIAL EVIDENCE (1.11.7); not rerun | Same-page lifecycle reuse and late callback correlation |
| Natural long match / response / turn end | NOT VERIFIED | Complete isolated game with decisionId, host event and training linkage |
| Game-over with original pending GameEvent | INCONCLUSIVE in earlier test (event wait did not return) | Observe late event disposition without violating host lifecycle |
| Training trigger, candidate creation, A/B swap and restore, promote/discard | NOT VERIFIED on real host | Full lifecycle with state/weights snapshot before and after |
| Export + import/restore | Export previously observed, import NOT VERIFIED | Round-trip with counts, checksums and no live data overwrite |
| Feature slots 112–119 semantic correctness | NOT FIXED (pre-existing) | New semantic epoch and model compatibility plan |

## Runtime environment boundary

This verification ran in the **GitHub Actions Node environment**, not the real Noname client. The currently connected tools cannot open a local game/browser host, inspect player GameEvents, or exercise browser IndexedDB within a live match. Existing `evidence/host-scenarios.js` and `late-scenarios.js` are **real-host-only** scripts and were **not executed** in this run.

A previous controlled host reported `lib.version=1.11.7`. It does not establish support for `1.11.6.1` or other client builds.

**Merge gate:** Keep PR #40 as Draft; automated tests passing is necessary but insufficient for a production merge. No model weights, persisted samples, host code, or main branch modified during this validation.
