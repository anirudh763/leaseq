# Failure modes and limits

| Failure | Existing or planned behavior | Operator consequence |
|---|---|---|
| Worker dies while holding a job | Lease expires; a later claimant can retry. `SKIP LOCKED` lets claimers pass locked rows. | Handler work can repeat. Use idempotent handlers, especially for external effects. |
| Stale worker reports completion | Current random lease capability check rejects the stale queue write. | It cannot reverse an external action the worker already performed. |
| External service accepted an action, worker died before completion | The database and remote service do not share a transaction. | Duplicate delivery/action is possible; downstream idempotency or an outbox pattern is needed. |
| PostgreSQL unavailable | API readiness/operations depending on DB fail; workers cannot claim or finish. | Restore DB connectivity and inspect leases/events before retrying operational actions. |
| Counts cache | Counts can be up to five seconds old per API process; multiple processes have separate caches. | A displayed count is an observation, not a globally synchronized counter. |
| High-priority jobs are scheduled for later | Claim eligibility checks `run_after` before ordering ready jobs by priority descending, then ID ascending. | A future high-priority row does not block a due lower-priority row. This behavior and the kind/due index were measured only on the documented local distributions. |
| Worker supports only some job kinds | Bundled and SDK workers send their registered kind list when claiming. | Unsupported jobs remain queued until a matching worker claims them; they are not silently acknowledged. The API compatibility path with no kind filter can still claim any kind. |
| Large sparse/absent kind-filtered backlog | A partial `(kind, run_after)` index targets queued filtered claims; the ordered priority index serves ready and mixed cases. | Local tests showed fewer reads and lower latency for sampled distributions. Write amplification, other data shapes and cloud capacity were not measured. |
| Bulk request exceeds its deadline | Each item reports a status; items after the bounded deadline can be `not_attempted`. | Inspect per-item outcomes before taking further action. This endpoint is bounded but not all-or-nothing. |
| Bulk response is lost or rejected | The client cannot tell whether some or all of that batch committed. | The dashboard marks that batch `uncertain`, later batches `not_attempted`, and does not retry automatically. Inspect the jobs before manually deciding on a new action. |
| Idempotency key is reused for a changed request | The API returns the original job or schedule unchanged. | Treat a repeated key as a retry of the same intent; generate a fresh key for a new submission or schedule. |
| Schedule poller is stopped | Persisted schedules remain in PostgreSQL; the API dispatch loop is not running. | No occurrence is enqueued while polling is stopped. On restart, missed slots coalesce into one occurrence, then the schedule advances past database time. Workers are also required to execute jobs. |
| Worker observation appears recent | Claim polls update last-seen, but only a valid lease heartbeat sets heartbeat time. | Observations and active leases are not process/host health checks. |
| Metrics sample reaches its cap | The 15-minute sample is limited to 5,000 events/first claims and reports truncation. | Percentiles and buckets may represent a partial sample; null wait percentiles mean no eligible samples. They do not estimate capacity or an SLO. |
| Local disk/database loss | Existing local setup has no synchronous Multi-AZ replica. | Restore from a known backup; RPO depends on backup cadence and RTO on measured restore time. No target is guaranteed before drills. |
| Sandbox startup or cancellation | Partial startup shields owned teardown, reaps registered children and drops the database it created. | Failure is actionable; do not use an incomplete run as invariant proof. |
| Cleanup fails or a previous gateway crashed | Unknown/orphan databases block new runs; they are never deleted solely by prefix. | Inspect ownership; reset only the disposable local lab or perform an explicitly scoped operator cleanup. |
| Rate/body abuse against the sandbox | 64 KiB cap, ten-second read deadline, 10 mutations/minute/address and bounded rate state. | 413/408/429 identify the limit. Valid-owner cleanup remains available; the gateway stays local. |
| Slow or lost snapshot response | Single-flight polling uses a real deadline; the UI labels last-good data stale and offers Retry. | Do not interpret the last snapshot as current; successful retry clears the stale state. |
| Unsafe manual SQL | `job_events` and related audit history are append-only by design. | Do not delete or rewrite queue/event rows to repair state. Use supported operations and preserve evidence. |

## Telemetry handling

The core emits JSON request logs with bounded correlation IDs, normalized route, status and duration. Authenticated `/metrics` exports HTTP counters/histograms and cached queue gauges. Its stale-completion HTTP counter excludes direct database worker completions; the sandbox's rejection metric instead reads its bounded database audit history. Tokens, request bodies, query strings and raw paths are omitted. A Prometheus percentile requires `histogram_quantile()` over actual bucket series and a stated time window.

The separate `/operations/metrics` response summarizes actual database events
over a 15-minute database-time window. It samples at most 5,000 events/first
claims, is cached for five seconds and reports truncation. First-claim wait
uses initial availability; legacy rows with unknown availability are excluded.
It is operational telemetry, not a capacity forecast or service-level promise.
