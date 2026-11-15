# Operator upgrade contract

Owner-approved 2026-11-14 council decision: extend the existing FastAPI/PostgreSQL engine and vanilla `/dashboard/` operator interface. `/console/` remains the isolated real-worker chaos lab. Preserve legacy API defaults, fencing, audit, counts cache, public-read behavior and private data. Keep MIT licensing; paid plans are proposals, not a hosted offering.

## Enqueue and claim

`POST /jobs` retains kind, object payload, max_attempts and Idempotency-Key. Add `priority` (integer -100..100, default 0), optional timezone-aware `run_after`, and optional `delay_seconds` (finite 0..31,536,000). Reject simultaneous absolute and relative schedules. Compute relative availability using PostgreSQL NOW(), never the client clock. A repeated key returns the original job without changing its payload, priority or schedule. Reserve the `_leaseq_schedule/` key prefix for scheduler occurrences.

Priority orders due/expired runnable jobs descending, then id ascending; default-priority jobs retain FIFO. Add an idempotent, lock-timeout-aware migration and partial priority index without rebuilding indexes on every startup. Preserve existing rows, results and append-only events. Record initial availability for accurate first-claim wait measurements; leave unknown historical availability explicitly unknown.

`POST /jobs/claim` adds optional `kinds` (1..64 validated names). Absence retains the existing all-kind API behavior. New default workers and SDK workers claim only their actual handler registry. Explicit `noop` retains the benchmark/demo behavior; an unrecognized handler never silently succeeds. Generic enqueueing remains valid even when its worker is offline; UI distinguishes observed worker kinds from a guarantee that a worker is online.

## Operator endpoints

- `POST /jobs/bulk`: authenticated `{action: "requeue"|"cancel", job_ids: [...]}` with 1..100 unique positive safe IDs. Use existing guarded queue operations and audit events; return `{action, results:[{id,status,job?}], processed, remaining}`. Per-item status is changed, conflict, not_found, error or not_attempted. Apply a bounded execution deadline and generic errors, never raw SQL/credentials. No all-or-nothing claim. UI snapshots at most 1,000 filtered IDs before confirmation and sends sequential batches; new matching jobs are excluded. Stop on auth loss and display partial results.
- `GET /workers?limit=100`: authenticated bounded listing `{workers:[{worker_id,last_seen_at,kinds,active_jobs,last_heartbeat_at?}], as_of, limit, truncated}`. Claims, including empty polls, establish server-time observations. Valid lease heartbeats establish actual heartbeat timestamps. Do not invent idle heartbeats, process death or host health. Use “seen recently” / “no recent report,” separate from active leases.
- `GET /operations/metrics`: authenticated 15-minute server-time window, at most 5,000 sampled events/first claims, cached for 5 seconds. Return `{as_of,window_seconds:900,sample_limit:5000,truncated,buckets:[{start,completed,failed}],wait_ms:{p50,p95,samples},definitions}`. Wait means first claim minus initial availability, nonnegative; exclude unknown history and report sample count. Use actual database events, null for unavailable percentiles, explicit truncation and bounded indexed queries. No fake graphs or universal capacity claim.

## Durable UTC cron

`GET /schedules?limit=100`, `POST /schedules` (Idempotency-Key), and `PATCH /schedules/{id}` for enabled state are authenticated. Schedule input is `{name,kind,payload,cron,priority,max_attempts}`. Support numeric five-field UTC cron with a pinned, audited croniter dependency; validate length, field count, deterministic syntax and bounded next-match search (5 years). No random/hash/year/seconds expressions.

Persist next_run_at and enable state in PostgreSQL. API worker polling dispatches at most 10 due schedules per tick with row locks/SKIP LOCKED; enqueue and next-run advancement commit atomically. Occurrence keys include schedule ID and stored due slot. Coalesce missed runs into one overdue occurrence, then advance beyond database NOW(); never backfill an unbounded outage. Execution requires real polling workers. Enabling resumes from the next future slot. Prove two dispatchers cannot duplicate an occurrence and restart preserves state. No new cloud service or claim of a continuously running scheduler when workers are stopped.

## Dashboard and SDKs

Keep existing paths and design. Accept `#/jobs/job-123` as an alias for numeric job 123; malformed IDs get a specific invalid-ID state, unknown valid IDs get Job not found, unrelated paths remain route-not-found. Keep safe numeric bounds.

The default API token remains memory-only. “Keep token until this tab closes” is explicit opt-in sessionStorage; disclose its shared-device/XSS persistence risk, handle storage rejection, and clear it and all sensitive state on Forget or 401. No localStorage/cookies/URL token. Preserve in-flight auth-generation guards.

The composer accepts a JSON object, editable kind, explicit/generated idempotency key, priority, optional UTC due time/delay and attempts. Keep word_count/sleep presets; validate 64KiB encoded request size with no silent truncation. Reuse the same key for ambiguous retries, not every button click. Show observed registry/unsupported-kind notices.

Provide a local-install Python task registry/client and thin Node client plus TypeScript declarations in this repository. No unperformed PyPI/npm publishing claim. Reuse existing HTTP dependencies/native fetch with bounded timeouts/response size, no credential-forwarding redirects, explicit auth errors, kind-filtered claims, heartbeat and graceful stop. Handler execution is at-least-once: fenced completion cannot roll back email or other external effects. Expose a stable job idempotency key/context and document external idempotency/outbox requirements. Real API examples/tests must work; do not add SDK placeholders.

## Release evidence

Test existing-database migration twice while preserving jobs/events/effects, due-time boundaries with database clock, priority/FIFO and concurrent claims, kind filtering, bulk auth/partial/conflict/snapshot semantics, metrics caps/plans and nulls, observed workers, cron idempotency/misfires/concurrent dispatch, and both SDK clients against actual PostgreSQL/API. Preserve legacy tests, adapt only deliberately changed UI/behavior contracts, and verify 320/768/1440 keyboard/focus/axe/loading/empty/error states. New claims require measured workloads. Two independent critics and green current-head CI precede merge; no paid hosting.
