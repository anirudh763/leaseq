# Real recovery console implementation plan

> For agentic workers: use the installed subagent-driven-development or executing-plans workflow for the assigned task. Root owns architecture, integration and release.

**Goal:** Let a developer observe real PostgreSQL leases and safely kill a lab worker, then inspect recovery, stale completion rejection and committed effects.

**Architecture:** Add a separate, loopback-only sandbox gateway with a disposable database, private original API and four original worker subprocesses. Serve an additive React/Tailwind console from `/console/`. Preserve the existing authenticated API, worker, queue algorithms and `/dashboard/` contracts. The sandbox is a local reference lab, not a hosted multi-tenant queue service.

**Tech stack:** Existing FastAPI/psycopg/PostgreSQL engine; Python process supervision; React, Tailwind, Vite and Lucide pinned to actual installed versions, with retained licence notices.

**Spec:** `AGENTS.md`, `.agents/skills/enterprise-ui-polish/SKILL.md`, `.agents/skills/distributed-chaos-qa/SKILL.md`, and the owner's three-phase LeaseQ request.

## Decisions and boundaries

- The five independent AI advisors and five fresh anonymous peer reviews selected an isolated local lab. They are simulated roles, not human interviews or independent model vendors. Detailed evidence is in the external task's `leaseq/council/` folder.
- Do not modify `queue.py`, `schema.sql` or worker execution semantics to implement a UI. Current random lease capabilities fence completion atomically; `attempts` is the monotonic claim epoch and is never reset on replay. This does not claim external numeric fencing at an unrelated side-effect service.
- Keep the original private Docker deployments, databases, tokens and public read-only temporary demo untouched. Sandbox processes must use a separate PostgreSQL instance/role, an explicit `leaseq_sandbox_admin` database and generated `leaseq_sandbox_<hex>` run databases. Never accept a database name, SQL, arbitrary payload, executable or PID from the browser.
- The gateway binds to loopback by default, allows one active run, expires it after ten minutes, caps each run at 128 jobs/four workers/three extra batches, reaps children, and drops only databases that this supervisor created and still owns. A restart must report orphan-cleanup instructions rather than deleting unknown databases.
- A random per-run bearer capability lives only in browser memory. Mutations require a same-origin check and `X-LeaseQ-Sandbox: 1`; do not trust forwarded client addresses. Per-IP mutation rate is 10/minute, bounded limiter state; all JSON bodies are capped at 64 KiB before parsing. Return actionable 401/403/409/410/413/429/503 states. The lab is not approved for public Internet mutation access.
- Only `/sandbox/runs` may create a run; no arbitrary core API proxy. All work uses the original API and original worker, with server-held token. Fixed synthetic jobs demonstrate sleep, word count, one transient failure, a poison job and a deliberately stalled first attempt.
- Render state from real rows/events/effects. Report `pass`, `fail` or `inconclusive`; a timeout, absent stale result or unexercised takeover is not a passed proof. Download evidence includes observed time, run/version, per-job attempts/state/effect count, rejection/takeover evidence and limits; never include tokens or DB URLs.
- Prices Free 50K/Pro $19/Team $79 are proposed packaging, not available subscriptions or proven throughput/revenue. No paid resources, fake email capture, checkout, analytics or cloud accounts. Permanent four-worker free hosting is not promised.

## Console contract

Gateway base: same origin. All `/sandbox/runs/{run_id}/...` requests need the run capability.

- `POST /sandbox/runs` -> `{run_id, capability, expires_at}` after starting a real run. Concurrent creation is 409; capacity/rate limit is 429.
- `GET /sandbox/runs/{id}` -> `{run_id, phase, observed_at, expires_at, workers, counts, metrics, jobs, events, evidence, limits}`. No lease capability, operator token, process environment or payload is returned.
- `POST /sandbox/runs/{id}/batch` -> a bounded fixed batch, at most three extra batches.
- `POST /sandbox/runs/{id}/kill` -> kill/reap one registered currently leased worker with actual SIGKILL, restart it, return `{worker_id, job_id}`. No eligible worker is 409.
- `POST /sandbox/runs/{id}/duplicate` -> repeat the original first job's idempotency key and report original/existing ID and whether created.
- `GET /sandbox/runs/{id}/jobs/{job_id}` -> safe synthetic detail, events and effect count for that run only.
- `DELETE /sandbox/runs/{id}` -> stop/reap all owned processes and drop only that run's owned database. Clear client memory immediately.
- `GET /healthz`, `/readyz`; `/console/` serves built assets with CSP and no third-party network scripts.

`workers`: `{id, generation, status, job_id, lease_expires_at}`. `jobs`: existing bounded queue summaries plus `effect_count`. `events`: bounded actual audit rows. `metrics`: actual `expired_retries`, `zombie_rejections`, `effects`. `evidence`: explicit observed/inconclusive invariant outcomes. State snapshots use a coherent database transaction; observation time is not completion time.

## Review focus

- Repeated clicks, concurrent starts and late async replies cannot mix runs or retain cleared capabilities.
- Disconnects, gateway shutdown, partial startup and expired runs clean up all registered children without touching the private services.
- Four distinct original worker processes and persisted takeover/rejected/effect events establish real chaos, not a browser animation.
- Malicious Origins, arbitrary run IDs/PIDs, oversized/chunked requests and rate-map exhaustion fail closed before expensive work.
- Production/private routes retain auth, response contracts and existing regression checks; no unsafe shared global reset.

## Tasks

- [ ] Backend worker: create `leaseq/sandbox.py`, `leaseq/sandbox_runtime.py`, `tests/test_sandbox.py`, `tests/test_sandbox_runtime.py`. Reproduce missing behavior before implementation. Verify real four-worker batch, SIGKILL/reclaim, stale result, duplicate key, DLQ, DB-time behavior, body/rate/security and cleanup. No edits to core files or frontend.
- [ ] Frontend worker: create `frontend/` React/Tailwind source and built `leaseq/console/`. Light cobalt dispatch identity; compact navigation with Lucide, Operations/Chaos/DLQ; real metrics and timeline; labelled controls; clear pending/empty/error/retry/expired states; plans modal and JSON evidence download. Use the API contract above, not simulated data. Preserve old dashboard and core. Add meaningful unit/browser checks with 320/768/1440, keyboard/axe/runtime monitoring.
- [ ] Root: integrate bounded production API rate limits, structured correlation logs and authenticated `/metrics` without exposing secrets; add regression tests. Preserve queue/worker semantics and old UI. Update Docker local-lab launch, CI, architecture/decisions/failure/FinOps/runbook, optional bounded local video tooling and reproducibility instructions.
- [ ] Run existing backend/browser/chaos negative control, new seven-case suite, source/history secret checks, dependency audit and bounded CLI review. Two independent critics, current-head CI, then release to original repository. Recheck the original public read-only demo separately. Record unconnected external services explicitly.
