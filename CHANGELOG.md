# Changelog

## Unreleased

Dashboard only; no queue or API changes.

- The error banner is updated only when its text changes. Before, it was
  rebuilt on every 2-second poll, which moved keyboard focus from its
  "Enter API token" button to the page body and made screen readers announce
  the alert again on every poll.
- "Pause updates" changes its label only; it no longer also sets
  `aria-pressed` (which was announced as "Resume updates, pressed").
- The "Cancel job" confirm button is filled with the danger colour instead of
  the accent used by "Requeue job".
- An HTTP error banner says what to check and that the page retries.
- Without a token the job table says "Jobs appear here after you enter the
  API token." instead of showing an empty body.
- Header: the product name is the page's `h1`, and a "Source on GitHub" link
  was added. The state tabs stay on one row and scroll sideways on narrow
  screens. The job heading is no longer monospace; the notes lost their
  coloured left stripe.
- `ui.css` is the updated shared copy (root font size in %, so the browser's
  default size applies; hover and pressed states; a 120 ms button transition
  only when reduced motion is not requested).
- New `DESIGN.md` with the dashboard's tokens, light and dark values and
  measured contrast ratios.

## 0.1.0 - 2026-11-13

First numbered version. Queue semantics (claim, lease, heartbeat, fenced
complete, retry with backoff, cancel, requeue, the audit log) are unchanged
from the earlier commits on `main`; the one new job kind is `word_count`.

### Easier to try and install

- `scripts/up.sh` starts the Docker stack in one command. If `.env` has no
  `LEASEQ_API_TOKEN`, it adds a random one (an existing `.env` or token is
  never overwritten), sets `.env` to mode 600, runs
  `docker compose up -d --build`, waits for `/healthz` and prints the
  dashboard URL, where the token is stored and how to stop. `.env` is in
  `.gitignore`; `.env.example` documents the variable. A bare
  `docker compose up` with no `.env` and no token still refuses to start.
- CI's compose job gates the install path: a bare `docker compose up` with no
  `.env` and no token must fail and leave no containers; a fresh
  `scripts/up.sh` with no token must write a mode-600 `.env` whose token the
  API accepts; a re-run must leave `.env` byte-identical. `scripts/smoke.sh`
  then runs with the token from `.env`.
- Version 0.1.0 in `leaseq.__version__`, the OpenAPI document, `GET /healthz`
  (`{"ok": true, "version": "0.1.0"}`) and the dashboard footer; a test
  checks they match this file.
- `word_count`, a small demo handler in the bundled worker that does real,
  deterministic work: `{"words": N, "lines": M}` for `payload.text`, at most
  10,000 characters (longer text is a failed attempt with that reason). It
  completes through the same fenced `finish()` transaction as every kind.
  The quick start submits one with curl and reads the result; `smoke.sh`
  checks the exact result, and CI kills and restarts the worker container
  and checks the result survives and nothing completes twice.
- README: the bundled worker completes jobs through a direct database
  transaction; independent clients complete over HTTP with their lease token
  (curl example for claim and complete).
- `scripts/up.sh` fills a blank `LEASEQ_API_TOKEN=` line (as in a copy of
  `.env.example`) in place instead of appending a second one, refuses two
  token lines, uses a token exported in the shell as the only source (and
  says so), and caps each `/healthz` request so a stalled API cannot outlast
  `LEASEQ_UP_TIMEOUT`.
- Dashboard: a `<noscript>` message pointing to the README's curl steps and
  `/openapi.json` (the `/docs` page itself needs JavaScript), and an SVG
  favicon.
- `SECURITY.md` (maintenance status: public beta, one student, best effort;
  security contact; supported versions and scope), `CONTRIBUTING.md` and two
  issue templates (Problem, Queue guarantee).
- README: says first that this is a reference implementation of a
  lease-and-fence PostgreSQL queue with a kill test, at demo scale, not a
  production queue, and names mature alternatives. The quick start leads with
  `scripts/up.sh`.
