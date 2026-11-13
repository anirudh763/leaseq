# Changelog

## 0.1.0 - 2026-11-13

First numbered version. Queue semantics (claim, lease, heartbeat, fenced
complete, retry with backoff, cancel, requeue, the audit log) are unchanged
from the earlier commits on `main`.

### Easier to try and install

- `scripts/up.sh` starts the Docker stack in one command. If `.env` has no
  `LEASEQ_API_TOKEN`, it adds a random one (an existing `.env` or token is
  never overwritten), sets `.env` to mode 600, runs
  `docker compose up -d --build`, waits for `/healthz` and prints the
  dashboard URL, where the token is stored and how to stop. `.env` is in
  `.gitignore`; `.env.example` documents the variable. A bare
  `docker compose up` with no `.env` and no token still refuses to start.
- CI's compose job now starts the stack with `scripts/up.sh` (no token set
  beforehand) and runs `scripts/smoke.sh` with the token from `.env`, and
  checks that `docker compose config` fails without a token.
- Version 0.1.0 in `leaseq.__version__`, the OpenAPI document, `GET /healthz`
  (`{"ok": true, "version": "0.1.0"}`) and the dashboard footer; a test
  checks they match this file.
- Dashboard: a `<noscript>` message pointing to the API reference, and an SVG
  favicon.
- `SECURITY.md`, `CONTRIBUTING.md` and two issue templates (Problem, Queue guarantee).
- README: says first that this is a reference implementation of a
  lease-and-fence PostgreSQL queue with a kill test, at demo scale, not a
  production queue, and names mature alternatives. The quick start leads with
  `scripts/up.sh`.
