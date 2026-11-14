# Failure modes and limits

| Failure | Existing or planned behavior | Operator consequence |
|---|---|---|
| Worker dies while holding a job | Lease expires; a later claimant can retry. `SKIP LOCKED` lets claimers pass locked rows. | Handler work can repeat. Use idempotent handlers, especially for external effects. |
| Stale worker reports completion | Current random lease capability check rejects the stale queue write. | It cannot reverse an external action the worker already performed. |
| External service accepted an action, worker died before completion | The database and remote service do not share a transaction. | Duplicate delivery/action is possible; downstream idempotency or an outbox pattern is needed. |
| PostgreSQL unavailable | API readiness/operations depending on DB fail; workers cannot claim or finish. | Restore DB connectivity and inspect leases/events before retrying operational actions. |
| Counts cache | Counts can be up to five seconds old per API process; multiple processes have separate caches. | A displayed count is an observation, not a globally synchronized counter. |
| Local disk/database loss | Existing local setup has no synchronous Multi-AZ replica. | Restore from a known backup; RPO depends on backup cadence and RTO on measured restore time. No target is guaranteed before drills. |
| Sandbox startup or cancellation | Partial startup shields owned teardown, reaps registered children and drops the database it created. | Failure is actionable; do not use an incomplete run as invariant proof. |
| Cleanup fails or a previous gateway crashed | Unknown/orphan databases block new runs; they are never deleted solely by prefix. | Inspect ownership; reset only the disposable local lab or perform an explicitly scoped operator cleanup. |
| Rate/body abuse against the sandbox | 64 KiB cap, ten-second read deadline, 10 mutations/minute/address and bounded rate state. | 413/408/429 identify the limit. Valid-owner cleanup remains available; the gateway stays local. |
| Slow or lost snapshot response | Single-flight polling uses a real deadline; the UI labels last-good data stale and offers Retry. | Do not interpret the last snapshot as current; successful retry clears the stale state. |
| Unsafe manual SQL | `job_events` and related audit history are append-only by design. | Do not delete or rewrite queue/event rows to repair state. Use supported operations and preserve evidence. |

## Telemetry handling

The core emits JSON request logs with bounded correlation IDs, normalized route, status and duration. Authenticated `/metrics` exports HTTP counters/histograms and cached queue gauges. Its stale-completion HTTP counter excludes direct database worker completions; the sandbox's rejection metric instead reads its bounded database audit history. Tokens, request bodies, query strings and raw paths are omitted. A Prometheus percentile requires `histogram_quantile()` over actual bucket series and a stated time window.
