---
name: distributed-chaos-qa
description: Verify FastAPI/PostgreSQL queue recovery and abuse protections with reproducible real-engine edge cases and browser evidence.
---

# Domain acceptance

Use the exact repository engine, published fixtures and existing tests. Add reproducible cases for the following; record pass/fail/untested, versions and evidence for each.

1. Batch enqueue and lease acquisition on real PostgreSQL, including four isolated sandbox workers where configured.
2. Kill a sandbox worker process mid-job with actual SIGKILL; observe PostgreSQL lease expiry and safe retry. Never expose arbitrary PID/process killing.
3. Stale worker late completion: monotonic fencing token rejected and observed in event history.
4. Duplicate idempotency key: deterministic existing-job behavior and conflict handling, no duplicate execution claim without evidence.
5. Poison job repeat failures: bounded retries then real DLQ/quarantine, with safe inspection/replay authorization.
6. Worker wall-clock skew: lease decisions use PostgreSQL NOW()/database time; prove behavior against the real queue, not patched app clocks alone.
7. Request abuse: actual429, bounded Retry-After where supported, authorization checks and max64KiB request body enforced before expensive parsing/work.

Run the relevant native/Python/Node/browser checks and inspect 320/768/1440 UI states. Zero errors/leaks means none observed in the named finite run, not a universal guarantee. Preserve meaningful assertion strength; diagnose platform/toolchain differences rather than skipping failing cases. No secrets or user payloads in reports.
