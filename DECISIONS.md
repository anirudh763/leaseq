# Architecture decisions

| Decision | Rationale and boundary |
|---|---|
| PostgreSQL owns queue state and lease time. | `SKIP LOCKED` claim transactions support concurrent workers. Database time avoids comparing leases against worker clocks. |
| Lease capabilities are random and checked atomically. | They reject stale completion/failure writes. Claim `attempts` is monotonic, including across requeue, but is not an external numeric fence. |
| Queue delivery is at least once. | A worker can finish an external action and die before recording completion. External consumers must tolerate duplicates. |
| A committed worker effect and fenced completion share one transaction. | This guarantee applies to effects in the same PostgreSQL database transaction only. |
| Counts may be five seconds old. | The per-process cache avoids repeating aggregate counts scans; job rows remain fresh. |
| Keep the chaos lab local and isolated. | The one-run, four-worker, 128-job, three-extra-batch and 10-minute limits constrain resource use. Four original worker processes and the original queue/API run on an owned disposable database. |
| Require capability, same-origin/header checks, body cap and mutation rate control in the lab. | The 64 KiB cap and rate policy bound request cost. This does not make the lab suitable for public Internet access. |
| Reserve valid-owner cleanup after rate exhaustion. | Abuse controls must still let the owner stop/reap the active run; the exception grants no other action or database access. |
| Canonicalize connection strings before any allocation. | libpq query values can override URI path/authority. Parse and rebuild the exact administrator/run target, reject file/service indirection and bound connection/query time. |
| Keep one snapshot request in flight. | Aborting every two seconds can starve any slower response. A real deadline marks stale data; explicit retry recovers without claiming an old snapshot is connected. |
| Do not promise a free permanent worker tier or current prices. | Hosting offers and trial terms change; named Free/Pro/Team price points are packaging hypotheses only. |
| Cloud services remain proposals. | SQS, EventBridge, Step Functions and RDS Multi-AZ require a designed adapter, account, cost review and operational drills. None is provisioned. |
