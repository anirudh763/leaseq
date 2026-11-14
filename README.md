# leaseq

[CI status](https://github.com/anirudh763/leaseq/actions)

leaseq is a reference implementation of a lease-and-fence job queue on
PostgreSQL, with a kill test. It is built and measured at demo scale (a few
thousand jobs on one 2-core machine) and is not a production queue; for real
workloads use a mature PostgreSQL-backed queue such as pgmq (a PostgreSQL
extension), River (Go) or Procrastinate (Python).

Status: public beta, maintained by one student on a best-effort basis. It has
no known users and has not been validated with any. Supported scope, and how
to report a security problem (GitHub private vulnerability reporting, no
personal email), are in [SECURITY.md](SECURITY.md).

Clients submit jobs over a small HTTP API; workers claim a job under a
time-limited lease, do the work, and report the result with the lease token
they were given. It exists to answer one question with evidence instead of a
claim: if worker processes are killed at random while they hold jobs, is any
job lost, and is any job's result recorded twice? The repository contains the
queue, its HTTP API with bearer-token authentication, an operations dashboard
served by the API (1,181 lines of Python, 100 of SQL, and 1,657 of
HTML/JavaScript/CSS written for the dashboard, counted with `wc -l`, not counting the shared
`ui.css` base stylesheet), a fault-injection test that kills workers with
SIGKILL and then checks the database, and the measured results below.

![The LeaseQ operations console: state lanes with counts (16 jobs: 13 done, 3 dead) above the job table](docs/screenshots/jobs-1440.png)

![Job 13: why it is not running, and its lease lifecycle timeline: enqueued, claimed, failed and retried twice, then dead](docs/screenshots/job-details-1440.png)

The screenshots were taken from local processes, not Docker: one `uvicorn` API,
two workers and the `leaseq.demo` sample jobs (enqueued through
`POST /demo/jobs`) against a local PostgreSQL, captured with
`tests/e2e/readme_screenshot.js` after entering the token on the Connection
screen. Narrow-screen versions are in `docs/screenshots/` (`jobs-320.png`,
`job-details-320.png`). The dashboard's tokens, layout and measured contrast are
in [DESIGN.md](DESIGN.md).

## Quick start

With Docker (Docker Compose v2):

```
scripts/up.sh
```

It writes a random `LEASEQ_API_TOKEN` to `.env` if there is none, or if the
line is blank (as after `cp .env.example .env`; the blank line is filled in
place). An existing token is never overwritten, `.env` is set to mode 600 and
is in `.gitignore`. If `LEASEQ_API_TOKEN` is exported in your shell, Compose
uses that value ahead of `.env`, so `scripts/up.sh` uses it too, leaves `.env`
alone and says so. It then runs `docker compose up -d --build`, waits for
`/healthz` (at most `LEASEQ_UP_TIMEOUT` seconds, default 120), and prints the
dashboard URL (http://127.0.0.1:8000/dashboard/), where the token is, and how
to stop. The stack is PostgreSQL, the API on 127.0.0.1:8000, one worker and a
`demo` service that enqueues sample jobs for 10 minutes
(`scripts/up.sh --scale demo=0` starts without it). The dashboard asks for
the token before it shows any jobs.

Run one job that does real work. `word_count` is a small demo handler in the
bundled worker (not a production feature): it counts the words and lines of
`payload.text`, up to 10,000 characters.

```
TOKEN=$(sed -n 's/^LEASEQ_API_TOKEN=//p' .env)
curl -s -X POST localhost:8000/jobs -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -H 'Idempotency-Key: wc-1' \
     -d '{"kind": "word_count", "payload": {"text": "to be or\nnot to be"}}'
# -> {"id": 17, "kind": "word_count", "state": "queued", ...}
curl -s localhost:8000/jobs/17 -H "Authorization: Bearer $TOKEN"
# -> {..., "state": "done", ..., "result": {"lines": 2, "words": 6}, ...}
```

Use the `id` the first call returns. Then check the whole stack end to end,
and stop it:

```
LEASEQ_API_TOKEN=$(sed -n 's/^LEASEQ_API_TOKEN=//p' .env) scripts/smoke.sh
docker compose down          # stop; keeps the data
```

There is no default token: a bare `docker compose up` with no `.env` and no
`LEASEQ_API_TOKEN` stops with a message saying so. `.env.example` lists the
variable if you prefer to write `.env` yourself.

Jobs, results and audit history are stored in the named `pgdata` volume.
`docker compose down` keeps that data; the next `docker compose up --build`
reuses it within the same Compose project. Changing the project name (or
moving to a differently named directory) selects a different volume.
`docker compose down -v` is a destructive reset: it deletes the database
volume, including every job, result and audit event. Use it only when that
data is disposable, such as cleaning up a CI test.

If upgrading from the earlier Compose file without a named volume, export
your existing database before changing the mount, then restore it into the
new volume. The old database used an anonymous volume; it is not migrated
automatically. Keep the old volume until the restored data is verified.

Without Docker: requires Python 3 and a PostgreSQL server (tested with Python
3.13 and PostgreSQL 16 only).

```
pip install -r requirements.txt

# The API will not start without a token (16+ characters). Workers and the
# demo script read it from the environment too.
export LEASEQ_API_TOKEN=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')

# Option A: a throwaway local PostgreSQL on port 54329 (uses initdb/pg_ctl)
scripts/dev_postgres.sh start
export LEASEQ_DATABASE_URL=postgresql://leaseq@127.0.0.1:54329/leaseq

# Option B: any PostgreSQL you already have
export LEASEQ_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME

uvicorn leaseq.api:app --port 8000 &                       # applies leaseq/schema.sql on start
python -m leaseq.worker --api http://127.0.0.1:8000 --worker-id w1 &

AUTH="Authorization: Bearer $LEASEQ_API_TOKEN"
curl -X POST localhost:8000/jobs -H "$AUTH" -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: demo-1' -d '{"kind": "sleep", "payload": {"ms": 100}}'
curl -H "$AUTH" localhost:8000/jobs/1
curl -H "$AUTH" localhost:8000/stats

python -m leaseq.demo --api http://127.0.0.1:8000     # 16 sample jobs for the dashboard
# then open http://127.0.0.1:8000/dashboard/ and enter the token
```

`GET /healthz` needs no token and returns `{"ok": true, "version": "0.1.0"}`;
the version is also in the dashboard footer and in `CHANGELOG.md`.

### API

Every request needs `Authorization: Bearer <token>` except `/healthz`, the
dashboard's static files and the API docs (`/docs`, `/openapi.json`). With
`LEASEQ_PUBLIC_READ=1` the GET endpoints under `/stats` and `/jobs` are open as
well. A missing or wrong token gets `401` with a JSON body and
`WWW-Authenticate: Bearer`.

| Request | Behaviour |
|---|---|
| `POST /jobs` + `Idempotency-Key` header, body `{kind, payload, max_attempts}` | 201 with the new job, or 200 with the existing job if the key was used before. Never a second row. |
| `POST /jobs/claim` `{worker_id, lease_seconds}` | 200 with the oldest runnable job and a fresh random `lease_token`, or 204 if nothing is runnable. |
| `POST /jobs/{id}/heartbeat` `{lease_token, lease_seconds}` | Extends the lease. 409 if the token is not the current one. |
| `POST /jobs/{id}/complete` `{lease_token, result}` | Marks the job done. 409 if the token is not the current one. |
| `POST /jobs/{id}/fail` `{lease_token, error, permanent}` | Requeues with exponential backoff (2 s, 4 s, 8 s ... capped at 300 s), or marks the job `dead` once `attempts` reaches `max_attempts`. With `"permanent": true` (optional, default false) the job is marked `dead` at once, whatever attempts are left, and its `dead` audit row records `permanent: true` and the error. 409 on a stale token. |
| `GET /jobs/{id}` | The job, without its lease token. |
| `GET /stats` | Counts by state. |
| `GET /jobs?state=&kind=&worker=&before_id=&limit=` | Newest first, at most 200 per page (default 50), without payloads; `next_before_id` pages back. Also returns counts, including `retrying` (queued jobs already attempted). The rows are read fresh on every call; the counts are taken at most once per `counts_max_age_seconds` (5 s, `LEASEQ_COUNTS_MAX_AGE`) per API process, and `counts_as_of` is when. |
| `GET /jobs/{id}/events?after_id=&limit=` | The job's audit rows, oldest first, at most 500 per page. |
| `POST /jobs/{id}/requeue` `{extra_attempts}` | Dead job back to `queued` with more attempts (default 3). `attempts` is kept; `max_attempts` is raised. 409 if the job is not dead. |
| `POST /jobs/{id}/cancel` `{reason}` | Queued or leased job to `dead` and its lease token cleared, so a worker still running it gets 409: its result is refused (logged as `rejected`) and no effect is written. 409 otherwise. |
| `GET /auth/check` | 200 if the token is right, 401 if not. |
| `POST /demo/jobs` | Enqueues the 16 sample jobs that `python -m leaseq.demo` sends. |

A job is runnable when it is `queued` and its `run_after` has passed, or when
it is `leased` and the lease has expired. Every state change inserts one row
into `job_events` in the same transaction.

## Dashboard

`/dashboard/` is an operations console for this local queue: plain HTML, CSS
and JavaScript inside the package, no build step, no CDN, no third-party code.
It is light by default (also when the operating system prefers dark); "Use dark
theme" switches it, and that choice is the only thing the page stores. Each
task is its own screen with its own URL (hash routes, so links can be shared
and Back/Forward work):

| Route | Screen | Old link that still works |
|---|---|---|
| `#/jobs` (default), `#/jobs?state=dead&kind=…&worker=…` | Jobs: state lanes and the job table | `?state=…&kind=…&worker=…` |
| `#/jobs/<id>` | Job details | `?job=<id>` |
| `#/submit` | Submit test job | |
| `#/connection` | Connection & API (token, status, API guide) | |

- **Jobs**: one lane per state (All, Queued, Running, Retrying, Done, Dead)
  with the server's counts; a lane is a toggle that filters the table. Kind
  and worker filters and "Open job" by id; the filters are in the URL. The
  counts are taken at most once per 5 seconds per API process, so the page
  shows "Counts as of hh:mm:ss"; the rows are read fresh on every refresh.
  It refreshes every 2 seconds while the browser tab is visible and not at
  all while it is hidden; "Pause updates" stops it too.
- **Job details**: why the job is waiting (ready for a worker, retry backoff
  until a time, running until its lease ends, lease expired, dead after N of
  M attempts), the lease lifecycle as a timeline built from the audit log
  (claims with worker and lease length, failures with the retry delay, fence
  rejections of stale lease tokens, completion, operator actions), the
  payload and the result. Heartbeats are not in the audit log, and the page
  says so.
- **Submit test job**: sends text (up to 10,000 characters, the handler's
  limit) as a `word_count` job through the real queue; a worker claims it,
  counts, and completes it, and the page shows the stored result. "Load
  sample text" fills in chapter 1 of Jane Austen's *Pride and Prejudice*
  (public domain; from Project Gutenberg eBook #1342, see
  `leaseq/dashboard/assets/sample/SOURCE.txt`). Its result, measured by a
  worker in the browser tests and in `scripts/smoke.sh`, is
  `{"words": 849, "lines": 114}`.
  Retrying an uncertain response keeps the same text and idempotency key;
  editing or clearing the text starts a new submission intent.
- **Connection & API**: the token form, the API address and version, the
  connection state, example `curl` calls, the endpoints and the error
  answers (401, 404, 409, 413, 422).

Without the token (and without `LEASEQ_PUBLIC_READ=1`) the data screens show
a "Not connected" state that links to Connection & API. The token is checked
with `GET /auth/check`, kept in the page's memory only (not in a cookie, local
or session storage, or the URL) and sent only in the `Authorization` header, so
another site cannot make the browser send it: there is no CSRF surface. With a
token, "Requeue job" and "Cancel job" appear; each asks for confirmation that
names the job and the effect, and Cancel uses the danger style with "Keep job"
focused. Job payloads are shown as text, never as HTML, and the page is served
with a `Content-Security-Policy` that allows only its own files. "Forget token"
and any 401 remove all job data at once: the list, every job opened before
(payload, result, events), the Submit draft/result and confirmation text. A test checks that going Back
to a job's URL after either one cannot show the old payload.

When the table contains jobs from `python -m leaseq.demo` (keys starting
`demo-`), the dashboard says so: those jobs do no real work.

Accessibility: passes automated axe-core checks (WCAG 2.2 A/AA and
best-practice rules) with 0 violations in 38 scanned states across the three
browser tests: every screen in light (default) and dark at 1280 and 320 px,
the Not connected state, dialogs, an API failure, and 375 px and 640 px widths
(640 px is a 1280 px window at 200% zoom). The tests also check that no screen
scrolls sideways at 320, 768 and 1440 px, that every route change moves focus
to the screen's H1, that the Menu sheet closes with Escape and returns focus to
the Menu button, and they drive the main flows with the keyboard only. A
manual screen-reader check has not been run.

## The demo worker, and writing your own handler

The bundled worker (`leaseq/worker.py`) is a test harness for the queue, not an
email sender or report renderer. It knows four kinds: `sleep` waits (and
heartbeats), `fail` raises, `fail_first_n` raises on its first n attempts, and
`word_count`, a small demo handler that does real, deterministic work on
bounded input: it returns `{"words": N, "lines": M}` for `payload.text`.
Text over 10,000 characters (or not a string) raises `PermanentJobError`: the
same input would fail again, so the job is `dead` after that one attempt, and
its audit log records the reason. Any other exception from a handler is a
normal failed attempt and is retried with backoff until `max_attempts`. Any other kind, including the demo's `email.send`, `report.render`,
`thumbnail.resize` and `index.rebuild`, is a no-op that is marked done at once:
no email is sent and nothing is rendered. What is real is the queue contract
around it: claim with a lease, heartbeat, complete or fail with the lease
token, retry with backoff, dead-lettering, and the audit log.

How a job is completed depends on who runs it:

- **The bundled worker** claims and heartbeats over HTTP, but completes a job
  through a direct database transaction (`finish()` in `leaseq/worker.py`,
  which needs `LEASEQ_DATABASE_URL`): the fenced `complete` and the job's
  side effect (a row in `effects`) commit together or not at all. That is how
  the chaos test can check "one effect per job".
- **An independent client** (any language, no database access) uses the HTTP
  API with the lease token from its claim. It gets the same fencing on the
  job's state and result, but a side effect it makes elsewhere is not part of
  that transaction (see below).

```
AUTH="Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8000/jobs/claim -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"worker_id": "my-client", "lease_seconds": 30}'
# -> {"id": 18, "kind": "word_count", "lease_token": "Xq...", "payload": {...}, ...}  (204 if nothing is runnable)
curl -s -X POST localhost:8000/jobs/18/complete -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"lease_token": "Xq...", "result": {"words": 6, "lines": 2}}'
# -> the job, now "done"; 409 if the lease was re-issued or the job was cancelled
```

Report a failure instead with `POST /jobs/{id}/fail` and
`{"lease_token": ..., "error": "..."}` (add `"permanent": true` if a retry
cannot succeed), and extend a long lease with
`POST /jobs/{id}/heartbeat`. Stop the bundled worker first if you try this
against the Docker stack, or it will claim the job before you do
(`docker compose stop worker`).

To add a kind to the bundled worker, add a branch to `handle()` that returns
the job's result, as `word_count` does. `run()` then passes that result to
`finish()`, which stores it with the fenced `complete` in one transaction.
Keep that path: it is what stops a worker whose lease was re-issued or
cancelled from recording a result. Work that can outlast the lease must
heartbeat, as the `sleep` branch does. Raising an exception reports a failed
attempt, which is retried with backoff. Raise `worker.PermanentJobError`
instead when retrying cannot help (invalid input, as in `word_count`): the
worker sends `"permanent": true` and the job goes to `dead` with the reason in
its audit log, keeping its remaining attempts unused; an operator can still
requeue it.

Side effects outside the database are different. If the handler sends an email
or calls another service and the worker then dies or loses its lease before
`complete`, the job is handed out again and the email is sent again. Only an
idempotent handler avoids that, for example by passing the job's
`idempotency_key` to a provider that de-duplicates on it, or by recording what
was sent in the same database transaction as the completion.

## Security

What was checked on this branch, and what was found:

- Scanners: `bandit` (10 medium B608 "SQL built from strings" hits, all f-strings
  that insert column-list constants or WHERE fragments from a fixed table in
  `queue.py`; every request value is a `%s` parameter), `pip-audit` (no known
  vulnerabilities), `semgrep` with a local rule set for SQL string building,
  `shell=True`, HTML sinks and token storage (0 findings; the semgrep registry
  was not reachable from the build machine, so `--config auto` was not run).
- Found by sending bad input to the API, and fixed, each with a test that
  fails without the fix: a NUL character in `kind` or in a payload string
  returned 500 (PostgreSQL rejects it); `"lease_seconds": NaN` returned 500
  because the 422 response tried to echo `NaN` back; a 1 MB payload and a
  10,000-character `kind` were accepted (no body or field limits).
- Found by a second, independent audit of the merged code, and fixed, each
  with a test that failed before the fix (`tests/test_audit_round2.py`):
  - A payload or result nested 1,000 levels deep (about 2 KB) was stored, and
    then every response containing it failed with a 500 (Python recursion
    limit), including the claim whose lease had already been committed. JSON
    nested deeper than 64 levels is now refused with 422 before any database
    work.
  - Every API start ran `DROP TRIGGER`/`CREATE TRIGGER` on `job_events`, which
    takes an exclusive lock: a start behind an open reader stalled every
    audit-log write until the reader finished. The triggers are now created
    only when missing, so a normal start takes no such lock.
  - The retry backoff raised `OverflowError` from about 1,025 attempts; the
    exponent is now capped.
- Added: required bearer token (compared with `hmac.compare_digest` on SHA-256
  digests), checked before the body is read and denied by default for any path
  not listed as open; a 64 KiB body limit (`LEASEQ_MAX_BODY_BYTES`) that also
  counts chunked bodies; allow-lists and lengths for kind, worker id, lease
  token and error text; paged, capped list endpoints; 422 bodies that do not
  echo input; the Docker image runs as a non-root user and compose publishes
  the API on 127.0.0.1 only.
- Lease tokens are compared inside PostgreSQL (`WHERE lease_token = %s`), not in
  Python. That was left as it is: a token is 128 random bits, every wrong guess
  writes a `rejected` audit row, and callers now need the API token first.

## Results

All numbers below were produced in a shared cloud container (2 CPU cores,
8 GB RAM, Python 3.13.18, PostgreSQL 16.15 with default settings, everything
on one machine). Timings will differ elsewhere and between runs. Each command
was run with `LEASEQ_DATABASE_URL` set as in the quick start.

### Fault injection

`python scripts/chaos.py` enqueues 2,000 jobs, starts 4 worker processes with
1-second leases, and sends SIGKILL to a randomly chosen worker every 0.1 to
0.5 s (restarting it each time) until 50 kills have been delivered. About 2%
of jobs also make their first worker stall for 1.5 s without heartbeating, so
it outlives its lease and tries to complete late (a "zombie"). When no job is
unfinished the script reads the database and checks the invariants.

| Command | Jobs (N) | SIGKILLs (K) | Jobs needing >1 attempt | Late completions rejected | Time | Result |
|---|---|---|---|---|---|---|
| `python scripts/chaos.py` (seed 1) | 2000 | 50 | 66 | 22 | 32.3 s | PASS |
| `python scripts/chaos.py --seed 2` | 2000 | 50 | 69 | 36 | 39.3 s | PASS |
| `python scripts/chaos.py --seed 3` | 2000 | 50 | 65 | 29 | 36.0 s | PASS |

PASS means all of these held at the end of the run: 2,000 jobs in state
`done` and none `dead`; 2,000 rows in `effects` covering 2,000 distinct jobs;
2,000 `completed` rows in `job_events` and no job with more than one; the
number of `claimed` audit rows equal to the sum of `jobs.attempts`; 50 kills
delivered. The time is from worker start to the last job finishing.

Negative control, to show the check can fail. Same harness, but the workers
skip the lease-token check and nothing is killed:

```
python scripts/chaos.py --jobs 60 --kills 0 --stall-fraction 0.25 --unfenced
```

Result: FAIL. 68 effect rows for 60 jobs; 8 jobs completed twice.

Rerun on this branch after the authentication and dashboard changes, on the
same kind of container (2 cores, shared with other jobs). The harness gives the
API and the workers a random token for the run.

| Command | Jobs | SIGKILLs | Jobs needing >1 attempt | Late completions rejected | Time | Result |
|---|---|---|---|---|---|---|
| `python scripts/chaos.py --seed 1` | 2000 | 50 | 61 | 30 | 44.2 s | PASS |
| negative control (`--unfenced`, 60 jobs) | 60 | 0 | | | | FAIL: 68 effect rows, 8 jobs completed twice |

The seed fixes the job payloads, the victim of each kill and the gaps between
kills. It does not fix operating-system scheduling, so the job a kill lands
on, and therefore the counts in the table, change from run to run. An earlier
run of seed 1 on the same machine gave 63 retried jobs in 29.7 s.

### Tests

```
python -m pytest -q
```

131 tests passed in 209 s, none skipped (on this branch, on the same kind of
2-core container as the results above). This includes a reduced chaos run (300
jobs, 12 kills), the negative control (40 jobs), the authentication and
input-limit tests in `tests/test_security.py`, `word_count` run by a real
worker process (`tests/test_word_count_flow.py`), `scripts/up.sh` with a stub
`docker` (`tests/test_usability.py`, including the unchanged `smoke.sh`
passing against a real API and worker with the token read from a copied
`.env.example`), and three Playwright browser tests
in `tests/test_dashboard_e2e.py`. The third, `tests/e2e/visual_gate.e2e.js`,
is the dashboard's layout and routing gate: 38 named checks (page width at
320/768/1440 px, Menu sheet, H1 focus, Back/Forward and deep links, old
links, axe light and dark, light default under an OS dark preference, CSP,
noscript, the state lanes against the API's counts, the lifecycle timeline,
the confirmation text, the Submit flow with a real worker, and that Back to a
job URL after "Forget token" or a 401 cannot show its old payload). Four
regressions also cover draft/dialog cleanup, responses received after Forget,
and safe submission retries. In the original 34-check rebuild comparison,
33 failed against the old dashboard (only noscript passed). The browser tests need Node, the `playwright`
package and axe-core (`AXE_PATH`); without them they are skipped. One of them
runs real worker processes: the dashboard enqueues jobs, a worker completes
them, a failing job retries with backoff until it is dead, one job is
cancelled and one requeued, an API failure and a 401 are simulated, and the
token and job data are checked to be gone after "Forget token" (no cookie,
localStorage or sessionStorage entries). One browser context runs with the
Content-Security-Policy enforced (the others bypass it only to inject axe): it
opens a job whose idempotency key, payload and error text are hostile markup
and checks that no script ran and no CSP violation was reported.

`python tools/sabotage.py` breaks one protection at a time (auth, body limits,
input checks, paging caps, lease fencing on cancel and requeue, CSP, the
dashboard's text-only rendering and token handling, clearing of cached job data
on Forget and 401, the light default, H1 focus, the Menu sheet, old-link
redirects, the state lanes, the lifecycle timeline, the confirmation text, the
Submit bound and result, the `word_count` bounds, `scripts/up.sh` token handling
and health wait, the noscript message and the footer version), runs the tests
and restores the code. On this branch: 83 of 83 sabotages were caught by a
failing test, none skipped.

### Benchmark

```
python scripts/bench.py
```

Each client process loops `POST /jobs/claim` then `POST /jobs/{id}/complete`
with no work in between, against one uvicorn process. 2,000 jobs per run;
each figure is the median of 5 runs. Latency is the client-side round trip of
the claim request.

| Client processes | Throughput (jobs/s) | Claim p50 (ms) | Claim p99 (ms) |
|---|---|---|---|
| 1 | 143 | 3.66 | 8.70 |
| 4 | 270 | 7.08 | 16.92 |
| 8 | 277 | 13.36 | 34.28 |

These figures were measured before authentication and the body limit were
added and have not been re-measured under comparable conditions. One run on
this branch (3 runs per setting, while other jobs kept the 2-core machine at a
load average of 2.5 to 6.3) gave 106, 164 and 215 jobs/s for 1, 4 and 8
clients; the load makes it unsuitable for a before/after comparison.

Throughput stops rising between 4 and 8 clients. The container has 2 cores
shared by PostgreSQL, the API process and the benchmark clients themselves; I
did not profile which of them is the limit, so these numbers describe this
setup, not PostgreSQL's ceiling.

### Docker

Docker was not run on the machine this was built on (it has no Docker
daemon). The `compose` job in CI is where the real stack is tested. It first
checks that a bare `docker compose up` with no `.env` and no token fails and
leaves no containers, then starts PostgreSQL, the API and one worker with
`scripts/up.sh --scale demo=0` (no token set beforehand, so the script writes
a random one to `.env`), checks that `.env` is mode 600 and that the API
accepts its token and refuses a wrong one, re-runs `scripts/up.sh` and checks
that `.env` is byte-identical, and then runs:

1. `tests/e2e/live_flow.e2e.js` in Chromium against `http://127.0.0.1:8000`:
   reads refused without the token, token entered by keyboard, sample jobs
   enqueued from the dashboard, a job completed by the worker with its
   lifecycle timeline shown, a retry ending dead, cancel, requeue, Forget
   token, an API failure, a 401, the Submit test job screen with the
   public-domain sample, 375 px and 640 px layouts, and axe in light and dark.
2. `scripts/smoke.sh` with the token read from `.env`, which prints one
   `PASS` line per check: anonymous writes and reads get 401; the dashboard
   and its JS and CSS are served; idempotency; a finished job's events are
   `enqueued claimed completed`; a `word_count` job ends done with the exact
   result `{"lines": 2, "words": 6}`, and the public-domain sample text with
   `{"lines": 114, "words": 849}`; a `fail_first_n` job is retried and
   done (`enqueued claimed failed claimed completed`); a job cancelled while
   the worker runs it stays dead and the worker's late result is logged as
   `rejected`; the requeued job then runs to done.
3. A worker restart check: a `word_count` job finishes; the worker container
   is killed with SIGKILL while it runs a `sleep` job and started again; the
   `sleep` job is re-claimed and done, a second `word_count` job gets the same
   exact counts, the first job's result and audit events are unchanged, and
   each of the three jobs has exactly one `completed` event and one `effects`
   row.
4. A retention check: a finished job and its audit events are unchanged
   after `docker compose down` and `up`.

Before this branch, steps 1, 2 (without `word_count`) and 4 passed in CI on
commit f23f63f
([run 43372726090](https://github.com/anirudh763/leaseq/actions/runs/43372726090)):
12 browser steps with 0 axe violations, 7 `PASS` lines from the smoke script,
and the retention check.

The same browser flow and smoke script were also run here against the same
setup started as local processes (API, one worker, local PostgreSQL) and
passed.

## Design decisions

**1. At-least-once delivery with a fenced, idempotent completion, not
"exactly once".** A worker can die after doing the work but before reporting
it, and the queue cannot tell that apart from a worker that never started. So
the job has to be handed out again, which means it may run more than once.
What can be made to happen once is the recorded outcome: `complete` is a
single `UPDATE ... WHERE id = ? AND state = 'leased' AND lease_token = ?`, and
the worker's side effect is inserted in that same transaction. A worker whose
lease was re-issued holds an old token, matches zero rows, and its transaction
writes no effect. Rejected alternative: advertising exactly-once delivery.
It would be false for any side effect outside this database, and the README
would be claiming something the code cannot do.

**2. `SELECT ... FOR UPDATE SKIP LOCKED` to claim, not a lock or a separate
broker.** The claim query locks the row it picks; other claimers skip locked
rows and take the next one. Rejected: a table-level or advisory lock around
claiming, which is correct but makes every worker wait in a single line.
Rejected: a broker such as Redis or RabbitMQ next to the database. Then the
job's state lives in two systems, and "mark done" and "write the result"
cannot be one transaction; recovering from a crash between them is the problem
this project is trying not to have. One PostgreSQL also means one thing to run.

**3. The audit log is append-only and written in the same transaction as the
change.** Because the event row commits or rolls back together with the state
change, the log cannot say something happened that did not, or miss something
that did; the chaos check "claimed events = sum of attempts" depends on this.
A trigger rejects UPDATE, DELETE and TRUNCATE on `job_events`, so history
cannot be edited by application code or by accident. Rejected: logging events
to a file or in a second transaction, where a crash between the two leaves the
log and the table disagreeing.

**4. The token is the fence, not the clock.** A worker whose lease has expired
but has not been re-issued may still complete. Claim and complete lock the
same row, so one goes first: either the job is done before anyone re-claims
it, or the token has changed and the completion matches nothing. Rejected:
also requiring `lease_expires_at > now()` on completion. It adds no safety
and discards finished work. All expiry comparisons use the database's `now()`,
so worker clocks do not matter.

**5. No unique constraint on `effects.job_id`.** With one, the test's "one
effect per job" check would pass because of the constraint, not because of the
fencing. Leaving it out makes the chaos test measure the mechanism, and the
negative control shows duplicates do appear without it. Rejected for this
repository, recommended in real use: adding the constraint as a second guard.

## Limitations

- The exactly-once effect holds only for effects written to the same database
  in the completion transaction. An effect in another system (email, payment,
  another service) can still happen twice; the job would need to pass its own
  idempotency key to that system.
- The chaos test is evidence, not proof. It ran three seeds on one machine and
  kills only worker processes. It does not kill the API server or PostgreSQL,
  cut the network, or fill the disk.
- The tests and the chaos runs were only run on PostgreSQL 16.15 and
  Python 3.13, and the browser tests only in Chromium (Playwright 1.63).
- Reusing an idempotency key with a different body returns the original job
  and ignores the new body. No error is raised.
- One shared token for everyone: no users, roles or audit of who requeued or
  cancelled a job, and changing the token means restarting the API and
  workers. Anyone with the token can submit, claim and cancel. Use TLS (a
  reverse proxy) if the API is reached over a network; leaseq itself serves
  plain HTTP.
- No rate limiting. `LEASEQ_PUBLIC_READ=1` exposes job payloads to anyone who
  can reach the port.
- The claim query orders unfinished jobs by id. Jobs waiting on a long backoff
  are scanned and skipped on every claim, so a large backlog of delayed jobs
  would slow claiming. Not measured.
- Finished jobs and events are never deleted, and the append-only trigger
  blocks deleting events. There is no retention or archiving.
- A database superuser or the table owner can disable the audit trigger. It
  protects against application bugs and mistakes, not against an administrator.
- `rejected` rows are written for every stale or wrong lease token, so a
  misbehaving client that has the API token can grow the audit log.
- A job whose worker is killed on every attempt ends up `dead` only when the
  next claim notices the expired lease; there is no background sweeper.
- Benchmarks are from a 2-core shared container with client, API and database
  competing for the same cores.
- The dashboard is built for demo-scale queues. Its counts are still a
  `count(*)` over all jobs (95-145 ms at 520,010 jobs in four local EXPLAIN
  ANALYZE runs). The API runs it at most once per 5 seconds per API process
  however many tabs poll, but each run grows with history (a maintained
  counter would not). Filtered lists (`kind=`, `worker=`, `state=dead`) still
  scan the table; they are not indexed yet. With
  a job open, each refresh fetches up to 500 of that job's events. The job table shows at most the newest 200
  jobs per filter; older jobs are reached with the filters or "Open job" by id.
  The token is kept in page memory only, so reloading the page asks for it
  again.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and what a pull request
needs, and [SECURITY.md](SECURITY.md) for how to report a vulnerability and
what is in scope. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## How this was built

Built with AI assistance (Claude). Every number above comes from the commands shown.

## License

MIT, see `LICENSE`. The dashboard's Atkinson Hyperlegible font files are under the
SIL Open Font License 1.1; the license text is in
`leaseq/dashboard/assets/OFL.txt`.
