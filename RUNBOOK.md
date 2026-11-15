# LeaseQ operator runbook

This runbook covers the authenticated reference queue and its separate disposable local recovery console.

## Observe

1. Check `/livez` for process liveness and `/readyz` for database readiness.
2. Use the authenticated dashboard or API to inspect job state and bounded event history. Core reads and writes require the API bearer token. Never put it in a URL, shell history, logs or screenshots.
3. Treat aggregate counts as up to five seconds old per API process. Rows are fresh on each list request. Lease expiry is based on PostgreSQL time.
4. Preserve `job_events` and effects. They are append-only evidence; do not issue direct `DELETE`/`UPDATE` statements against audit rows.

## Stuck or repeatedly failing jobs

1. Check the job's current state, `attempts`, `max_attempts`, lease expiry and lifecycle events.
2. For an expired lease, allow a worker claim to recover it, or verify worker/database connectivity. A stale completion is expected to receive a conflict/rejection.
3. For a dead job, inspect the failure reason and external system before using the supported requeue action. Requeue preserves `attempts` and history while increasing the permitted attempt ceiling.
4. Before retrying a job that may have performed an external action, check the downstream system or idempotency key. Queue fencing cannot undo an external side effect.

## Database recovery

1. Follow [`docs/backup-restore.md`](docs/backup-restore.md) for the repository's local archive and restore procedure. A prior successful restore verification is historical; repeat it against the current revision and record backup age, restore time and row/event/effect checks before relying on it.
2. Stop API and workers before restoring into a target database. Confirm the target name and backup contents. Keep the original backup immutable.
3. Compare job, effect and event counts, sequence state, triggers and representative records after restore. Never fix recovery by deleting append-only history.
4. Set RPO/RTO only from a documented backup cadence and measured drills. This single-local-disk setup has no synchronous Multi-AZ replica.

## Sandbox cleanup

Use **Stop run** to reap the registered workers/private API and remove the run's owned database. Valid-owner cleanup bypasses an exhausted mutation quota; it retains the origin/header/body guards. Stop the complete disposable lab with `python3 scripts/sandbox_up.py --stop`. This affects only the `leaseq-local-lab` Compose project. On restart, unknown/orphaned databases block new runs and require operator inspection; never infer ownership from a prefix alone. Do not run broad database-drop commands.

## Logs and metrics

Search JSON request logs by `correlation_id`; the same bounded ID appears in `X-Correlation-ID`. `/metrics` requires the core API token even when public reads are enabled. Counters/histograms reset per API process. Queue gauges use the declared-age counts cache. For HTTP latency, use `histogram_quantile(0.99, sum by (le) (rate(leaseq_http_request_duration_seconds_bucket[5m])))`; this is a bucket estimate over a chosen window, not a published measured SLA. Inspect completion rejection events separately for the original worker's direct database path.

Investigate sustained queue growth, DLQ growth or repeated stale rejections against the expected workload. A possible starting alert policy is DLQ depth greater than zero for five minutes, repeated readiness failures for one minute, or HTTP p99 above 250 ms for five minutes. These are operator tuning proposals, not validated fleet thresholds. Current finite benchmark evidence is described in the repository verification report.
