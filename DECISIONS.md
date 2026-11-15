# Architecture decisions

| Decision | Rationale and boundary |
|---|---|
| PostgreSQL owns queue state and lease time. | `SKIP LOCKED` claim transactions support concurrent workers. Database time avoids comparing leases against worker clocks. |
| Ready claims order by priority descending, then ID ascending. | Default priority 0 preserves FIFO. `run_after` and optional kind filters constrain eligible queued work; absent kind filters preserve the existing all-kind API contract. |
| Keep separate partial indexes for runnable priority order and queued kind/due lookup. | Local measurements at 10k/100k/1M rows showed severe scans for sparse/absent kind-filtered matches; `(kind, run_after) WHERE state='queued'` improved those tested plans. The extra ~7.1 MB per million rows and read latency are local evidence, not a write-cost or cloud capacity guarantee. |
| Lease capabilities are random and checked atomically. | They reject stale completion/failure writes. Claim `attempts` is monotonic, including across requeue, but is not an external numeric fence. |
| Queue delivery is at least once. | A worker can finish an external action and die before recording completion. External consumers must tolerate duplicates. |
| A committed worker effect and fenced completion share one transaction. | This guarantee applies to effects in the same PostgreSQL database transaction only. |
| Counts may be five seconds old. | The per-process cache avoids repeating aggregate counts scans; job rows remain fresh. |
| Operator metrics and worker views report observations with explicit bounds. | Worker reports do not prove process health. Metrics cover a cached 15-minute sample capped at 5,000 events/first claims; truncation and unavailable wait percentiles are visible. |
| Bulk actions return per-item outcomes from bounded batches. | A 1,000-ID UI snapshot is sent as sequential 100-ID requests; a lost response is uncertain because it may have committed, so automatic retries could duplicate intent. |
| Durable schedules use persisted five-field UTC cron state. | A pinned cron parser, bounded polling and atomic occurrence/advance limit duplicate dispatch and outage catch-up. Execution still depends on an API poller and workers being up. |
| A repeated idempotency key identifies the original intent. | Replays return the existing job or schedule unchanged. A new schedule intent receives a fresh key; ambiguous retries reuse the original key. |
| Ship Python and Node SDK source locally, without claiming publication. | The checked-in clients and examples can run against a local API; PyPI/npm distribution has not been performed. |
| Keep token persistence opt-in. | The default is page memory; sessionStorage lasts for the tab and is readable by same-origin scripts. Forget and 401 clear sensitive state. |
| Keep the chaos lab local and isolated. | The one-run, four-worker, 128-job, three-extra-batch and 10-minute limits constrain resource use. Four original worker processes and the original queue/API run on an owned disposable database. |
| Require capability, same-origin/header checks, body cap and mutation rate control in the lab. | The 64 KiB cap and rate policy bound request cost. This does not make the lab suitable for public Internet access. |
| Reserve valid-owner cleanup after rate exhaustion. | Abuse controls must still let the owner stop/reap the active run; the exception grants no other action or database access. |
| Canonicalize connection strings before any allocation. | libpq query values can override URI path/authority. Parse and rebuild the exact administrator/run target, reject file/service indirection and bound connection/query time. |
| Keep one snapshot request in flight. | Aborting every two seconds can starve any slower response. A real deadline marks stale data; explicit retry recovers without claiming an old snapshot is connected. |
| Do not promise a free permanent worker tier or current prices. | Hosting offers and trial terms change; named Free/Pro/Team price points are packaging hypotheses only. |
| Treat $0 as local or temporary-demo cost only. | A durable API, PostgreSQL and running workers need a separately priced deployment; a static free tier is not the full stack. No revenue, cloud-cost or recovery guarantee is established. |
| Cloud services remain proposals. | SQS, EventBridge, Step Functions and RDS Multi-AZ require a designed adapter, account, cost review and operational drills. None is provisioned. |
