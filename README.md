# leaseq

Background jobs can be delayed, retried or left behind when a worker fails. LeaseQ lets operators inspect the queue, its current leases and recorded failures before confirming a recovery action. Its lease checks protect queue state from stale completion, while external effects still need their own idempotency controls.

## Direct operator routes

The existing vanilla dashboard supports these local routes without changing its API authorization:

| Route | Data and actions |
|---|---|
| `/` | Live Queue Overview with real state counts and URL filters |
| `/leases` | Observed workers, sampled operation metrics and up to 100 actual leased jobs |
| `/dead-letter` | Dead-job filter, failure details/audit timeline and protected requeue confirmation |
| `/system` | Actual `/livez`, `/readyz`, authenticated `/api/system` and Prometheus metrics |

The HTML shell is public; reading protected data and changing jobs require the existing in-memory
API token entered through Settings. Refresh forgets that token. New local routes open in Live API
mode; Browser Simulator remains an explicit, labeled alternative and does not represent PostgreSQL
activity. Local profiles do not grant API access. The separate recovery lab below owns its processes;
the ordinary API dashboard cannot kill arbitrary workers.

Assets stay under `/dashboard/assets/`; existing `/dashboard/#/jobs`, job detail, submit, operations,
settings and PWA links remain available. Direct paths support refresh and Back/Forward. Queue filters
live in the current tab's URL; the token is never put in a URL or browser storage. The system page
clears protected operational data when the token is forgotten or rejected.

The warm off-white and forest interface bundles Plus Jakarta Sans with its SIL OFL notice. There is
no frontend framework migration or new JavaScript dependency. Build the separate static Pages copy
with the existing `python scripts/build_static_site.py`; it disables the API and preserves explicit
simulator labeling. The static copy does not provide live operational health.

Frontend checks and screenshots are recorded in `artifacts/verification/post-restart/`. Run
`node --test tests/e2e/*test.cjs` for browser-model/profile/routing checks, and
`BASE_URL=http://127.0.0.1:3002 node tests/e2e/product_routes.e2e.js` against the running task-owned
API. The latter requires Playwright, axe-core, Chrome and an authorized token supplied through
`API_TOKEN` or the task-owned root launch environment; it never prints the token. It creates only
its own uniquely named fixture jobs and leaves their audit evidence in the task-owned queue.


[CI status](https://github.com/anirudh763/leaseq/actions)

leaseq is a PostgreSQL job queue and recovery lab. Run four real worker
processes, kill one while it holds a job, and inspect lease recovery, stale
completion rejection and committed database effects in the browser.

## Try the recovery console

With Python 3.11 or newer and Docker Compose v2, run:

```sh
python3 scripts/sandbox_up.py
```

Open [the local console](http://127.0.0.1:8765/console/) and select **Start run**. In this isolated console, Jobs shows the sandbox’s workers and job rows; Recovery offers
batch enqueue, duplicate-key submission and a registered-worker SIGKILL;
Dead letters shows the poison fixture's failure history. Evidence JSON exports the
observed database snapshot. Stop run reaps its processes and removes only its
owned database. Stop the disposable Docker lab with
`python3 scripts/sandbox_up.py --stop`.

The lab is local and synthetic: one run, four original workers, 128 jobs,
three extra batches and a ten-minute maximum lifetime. It uses a separate
database and internal API; the existing authenticated operator dashboard
below retains its interface. Re-running the lab launch resets only the
`leaseq-local-lab` Compose project. Its data is disposable.

All available LeaseQ features are free. There are no subscriptions, paid
quotas, trials or upgrade gates. Hosting remains operator-controlled; local
availability does not imply a hosted service. [Architecture](ARCHITECTURE.md),
[failure modes](FAILURE_MODES.md), [operator runbook](RUNBOOK.md) and
[cost model](FINOPS_AND_PRICING.md) document the implemented boundaries.

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
served by the API, an isolated recovery console, a fault-injection test that kills workers with
SIGKILL and then checks the database, and the measured results below.

![LeaseQ Jobs with state filters and queue counts](docs/screenshots/jobs-1440.png)

![LeaseQ job detail with attempts, events and stored results](docs/screenshots/job-details-1440.png)

The desktop screenshots were captured on November 15 from the read-only demo,
backed by Docker Compose with PostgreSQL, one API and one worker. Its seeded
sample jobs use bundled handlers; no email or other external action is performed.
Browser checks cover 320, 768 and 1440 px. The dashboard's tokens, layout and
measured contrast are in [DESIGN.md](DESIGN.md).

For an operator-controlled deployment template, see [Hosting LeaseQ](docs/hosting.md).

## Quick start

This starts the authenticated operator API/dashboard and its persistent
database. The disposable recovery console above has a separate launch command.

With Docker (Docker Compose v2):

```
scripts/up.sh
```

It writes random `LEASEQ_API_TOKEN` and `LEASEQ_APP_PASSWORD` values to `.env`
if either is missing or blank (as after `cp .env.example .env`; blank lines are
filled in place). Existing valid values are preserved, `.env` is set to mode
600 and is in `.gitignore`. The app password is a distinct non-superuser
PostgreSQL login used by the API and worker. A short-lived Compose bootstrap
step prepares/updates that role before the API starts. If `LEASEQ_API_TOKEN` is exported in your shell, Compose
uses that value ahead of `.env`, so `scripts/up.sh` uses it too. The script may
still add a missing app-role password to `.env` unless that is also exported.
It then runs `docker compose up -d --build`, waits for
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
`LEASEQ_API_TOKEN` or `LEASEQ_APP_PASSWORD` stops with a message saying so.
`.env.example` lists the variables if you prefer to write `.env` yourself.

Jobs, results and audit history are stored in the named `pgdata` volume.
`docker compose down` keeps that data; the next `docker compose up --build`
reuses it within the same Compose project. Changing the project name (or
moving to a differently named directory) selects a different volume.
`docker compose down -v` is a destructive reset: it deletes the database
volume, including every job, result and audit event. Use it only when that
data is disposable, such as cleaning up a CI test.

The first startup with the non-superuser app role runs a local database
bootstrap step. For an existing Compose volume, first make and verify a backup,
then stop the API, worker and demo (`docker compose stop app worker demo`) and
run `scripts/up.sh`. The bootstrap step transfers ownership of existing LeaseQ
objects to the app role without dropping or recreating the volume. Keep the
existing `pgdata` volume and `.env`; do not use `down -v` for this upgrade.
The PostgreSQL bootstrap login remains local to the Compose network and is
used only by this setup step; it is not passed to API or worker containers.

If upgrading from the earlier Compose file without a named volume, export
your existing database before changing the mount, then restore it into the
new volume. The old database used an anonymous volume; it is not migrated
automatically. Keep the old volume until the restored data is verified.

Without Docker: requires Python 3.11 or newer and a PostgreSQL server. The current full
Python suite was verified with Python 3.13.1 and PostgreSQL 16.16; this is the
verified local matrix, not a claim about every version.

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
| `POST /jobs` + `Idempotency-Key` header, body `{kind, payload, max_attempts, priority?, run_after?, delay_seconds?}` | Priority is an integer from -100 to 100, default 0. `run_after` must include a timezone; `delay_seconds` is finite, 0 to 31,536,000, and cannot be combined with `run_after`. Relative time uses PostgreSQL time. Reusing a key returns the original job unchanged (201 new, 200 existing); changed bodies do not replace it. |
| `POST /jobs/claim` `{worker_id, lease_seconds, kinds?}` | 200 with a fresh random `lease_token`, or 204 if nothing matches. Runnable jobs order by priority descending, then id ascending; priority 0 remains FIFO. `kinds` is optional for API compatibility; when present it is 1–64 unique valid names. |
| `POST /jobs/{id}/heartbeat` `{lease_token, lease_seconds}` | Extends the lease. 409 if the token is not the current one. |
| `POST /jobs/{id}/complete` `{lease_token, result}` | Marks the job done. 409 if the token is not the current one. |
| `POST /jobs/{id}/fail` `{lease_token, error, permanent}` | Requeues with exponential backoff (2 s, 4 s, 8 s ... capped at 300 s), or marks the job `dead` once `attempts` reaches `max_attempts`. With `"permanent": true` (optional, default false) the job is marked `dead` at once, whatever attempts are left, and its `dead` audit row records `permanent: true` and the error. 409 on a stale token. |
| `GET /jobs/{id}` | The job, without its lease token. |
| `GET /stats` | Counts by state. |
| `GET /jobs?state=&kind=&worker=&before_id=&limit=` | Newest first, at most 200 per page (default 50), without payloads; `next_before_id` pages back. Also returns counts, including `retrying` (queued jobs already attempted). The rows are read fresh on every call; the counts are taken at most once per `counts_max_age_seconds` (5 s, `LEASEQ_COUNTS_MAX_AGE`) per API process, and `counts_as_of` is when. |
| `GET /jobs/{id}/events?after_id=&limit=` | The job's audit rows, oldest first, at most 500 per page. |
| `POST /jobs/{id}/requeue` `{extra_attempts}` | Dead job back to `queued` with more attempts (default 3). `attempts` is kept; `max_attempts` is raised. 409 if the job is not dead. |
| `POST /jobs/{id}/cancel` `{reason}` | Queued or leased job to `dead` and its lease token cleared, so a worker still running it gets 409: its result is refused (logged as `rejected`) and no effect is written. 409 otherwise. |
| `POST /jobs/bulk` `{action, job_ids}` | Authenticated `requeue` or `cancel` of 1–100 unique positive safe IDs per request; returns per-ID `changed`, `conflict`, `not_found`, `error` or `not_attempted` plus `processed` and `remaining`. This is bounded and can be partial. |
| `GET /workers?limit=100` | Up to 100 observed worker reports, including reported kinds, last-seen time, actual lease heartbeats and current active leases. This is not process-health detection. |
| `GET /operations/metrics` | Cached for 5 seconds; a 15-minute window sampled to at most 5,000 events/first claims, with truncation, UTC-minute completion/failure buckets and first-claim wait percentiles. |
| `GET /schedules?limit=100`, `POST /schedules`, `PATCH /schedules/{id}` | List, create idempotently, enable or disable durable schedules. Creation uses `Idempotency-Key`. |
| `GET /auth/check` | 200 if the token is right, 401 if not. |
| `POST /demo/jobs` | Enqueues the 16 sample jobs that `python -m leaseq.demo` sends. |

A job is runnable when it is `queued` and its `run_after` has passed, or when
it is `leased` and the lease has expired. Every state change inserts one row
into `job_events` in the same transaction.

The authenticated Workers screen records worker observations on every claim,
including empty polls. “Seen recently” reflects a recent report; `active_jobs`
counts current unexpired leases, and `last_heartbeat_at` is set only by an
actual valid heartbeat. None of these proves that a process or host is alive.
Queue measurements cover a 15-minute database-time window, sample at most 5,000
events/first claims, and are cached for 5 seconds. Wait time is first claim
minus initial availability; pre-migration jobs with unknown `available_at` do
not enter the percentile sample. Empty samples produce null percentiles. These
measurements do not estimate capacity or promise an SLO.

Bulk actions snapshot the current filters once, up to 1,000 job IDs, then ask
for confirmation and send sequential batches of at most 100. New matching jobs
are excluded. The server can return partial outcomes; `error` means the server
attempted that item and hit an error, while `not_attempted` means the deadline
left it untouched. If the response to a batch is lost or rejected, the UI marks
that batch `uncertain`, marks later batches `not_attempted`, and does not retry
automatically: some or all of the uncertain batch may already have changed.

Schedules accept strict numeric five-field UTC cron syntax using pinned
`croniter` 7.0.0. Names, seconds, random/hash syntax and year fields are not
accepted; the next-match search is bounded to five years. Schedule state and
the next run time live in PostgreSQL. The API process polls once per second and
dispatches at most ten due schedules per tick under row locks. Dispatch creates
one job and advances the schedule atomically; missed runs coalesce into one
overdue occurrence, then advance past database time rather than backfilling an
unbounded outage. A running API is required for polling and a worker is required
to execute the jobs. Occurrence keys use the reserved `_leaseq_schedule/`
prefix; ordinary `POST /jobs` rejects that prefix.

An idempotency key identifies one enqueue or schedule intent: a repeated key
returns the original object even if the new body differs. For an ambiguous
network result, retry with the same key. After schedule creation succeeds, the
dashboard prepares a fresh key only when the operator starts another schedule,
so a new intent cannot silently reuse the previous key.

## Dashboard

`/dashboard/` is an operations console for this local queue: plain HTML, CSS
and JavaScript inside the package, no build step, no CDN, no third-party code.
It is light by default (also when the operating system prefers dark); "Use dark
theme" switches it. The theme preference is stored locally; the API token is
page-memory-only; reloading forgets it. Each
task is its own screen with its own URL (hash routes, so links can be shared
and Back/Forward work):

| Route | Screen | Old link that still works |
|---|---|---|
| `#/jobs` (default), `#/jobs?state=dead&kind=…&worker=…` | Jobs: state lanes and the job table | `?state=…&kind=…&worker=…` |
| `#/jobs/<id>` | Job details | `?job=<id>` |
| `#/submit` | New job | |
| `#/connection` | Settings (token, status, API guide) | |
| `#/operations` | Workers: reports, sampled metrics, durable schedules | |

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
- **New job**: sends text (up to 10,000 characters, the handler's
  limit) as a `word_count` job through the real queue; a worker claims it,
  counts, and completes it, and the page shows the stored result. "Load
  sample text" fills in chapter 1 of Jane Austen's *Pride and Prejudice*
  (public domain; from Project Gutenberg eBook #1342, see
  `leaseq/dashboard/assets/sample/SOURCE.txt`). Its result, measured by a
  worker in the browser tests and in `scripts/smoke.sh`, is
  `{"words": 849, "lines": 114}`.
  Retrying an uncertain response keeps the same text and idempotency key;
  editing or clearing the text starts a new submission intent.
- **Settings**: the token form, the API address and version, the
  connection state, example `curl` calls, the endpoints and the error
  answers (401, 404, 409, 413, 422).
- **Workers**: recent worker reports, active lease counts, bounded sampled
  queue measurements, schedule creation and enable/disable controls. A schedule
  submit retries an ambiguous result with the same idempotency key; after a
  successful create, “Start new schedule” generates a new key for the next
  intent. Schedules run only while an API poller and workers are running.

Without the token (and without `LEASEQ_PUBLIC_READ=1`) the data screens show
a "Not connected" state that links to Settings. The token is checked
with `GET /auth/check`, kept only in page memory and sent only in the
`Authorization` header. Reloading forgets it. The token is never put in a
cookie, browser storage or the URL. Forget and 401
clear the token and sensitive job/schedule state. With a
token, "Requeue job" and "Cancel job" appear; each asks for confirmation that
names the job and the effect, and Cancel uses the danger style with "Keep job"
focused. Job payloads are shown as text, never as HTML, and the page is served
with a `Content-Security-Policy` that allows only its own files. "Forget token"
and any 401 remove all job data at once: the list, every job opened before
(payload, result, events), the Submit draft/result and confirmation text. A test checks that going Back
to a job's URL after either one cannot show the old payload.

When the table contains jobs from `python -m leaseq.demo` (keys starting
`demo-`), the dashboard says so: those jobs do no real work.

Earlier browser evidence reported zero axe-core violations across 38 scanned
states. The current dashboard browser gate is not green (see Tests below), so
that earlier result is not a current-head accessibility pass. A manual
screen-reader check has not been run.

## The demo worker, and writing your own handler

The bundled worker (`leaseq/worker.py`) is a test harness for the queue, not an
email sender or report renderer. It claims only its registered kinds:
`fail`, `fail_first_n`, `noop`, `sleep` and `word_count`. `sleep` waits (and
heartbeats), `fail` raises, `fail_first_n` raises on its first n attempts,
`noop` completes without application work, and `word_count` does real,
deterministic work on bounded input: it returns `{"words": N, "lines": M}` for
`payload.text`.
Text over 10,000 characters (or not a string) raises `PermanentJobError`: the
same input would fail again, so the job is `dead` after that one attempt, and
its audit log records the reason. Any other exception from a handler is a
normal failed attempt and is retried with backoff until `max_attempts`. The
default worker does not claim unregistered kinds; they remain queued until a
worker registers a matching handler. The API still accepts generic kinds when
their worker is offline. What is real is the queue contract around them: claim
with a lease, heartbeat, complete or fail with the lease token, retry with
backoff, dead-lettering and the audit log.

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

### Local Python and Node clients

The Python client and registry are in `leaseq.sdk`; the dependency-free Node
client and TypeScript declarations are in `sdks/node/`. Runnable worker
examples are `examples/python_task.py` and `examples/node_task.js`. These are
source-tree clients, not published PyPI or npm packages. Both claim only the
registered kinds (up to 64), heartbeat while handlers run, use bounded HTTP
timeouts and request/response sizes, reject credential-forwarding redirects,
and report a distinct 401 authentication error. The handler context exposes
the stable job idempotency key as `job_key` in Python and `jobKey` in Node; use
it for external idempotency or an outbox. Fenced completion protects LeaseQ's
database state, not an external action already performed.

Install the local Python project with `python -m pip install -e .`. For either
example, start the API, export its `LEASEQ_API_TOKEN`, and create a `greet` job
with an `Idempotency-Key`; then run the Python example or `node
examples/node_task.js`. The Node client is imported directly from the checked-in
`sdks/node` folder; no package publication is implied.

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
- Per-process token buckets default to 60,000 authenticated and 120 public
  requests per minute/address; health has a separate bounded 120/minute/address
  map. These are admission controls per API process, not global quotas.

## Results

The historical chaos and dashboard evidence below was collected on a shared
2-core cloud container (Python 3.13.18, PostgreSQL 16.15). The current full
Python-suite result and claim-index measurements use separate local
environments described in their sections. None of these results is a hosted
service SLA or capacity guarantee.

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

The latest full Python run collected 200 tests: 196 passed, 4 skipped, none
failed, using Python 3.13.1 and PostgreSQL 16.16. It included the operator
endpoints, migration/startup checks, Python and Node SDK clients against the
local API, and the sandbox runtime with real PostgreSQL and four worker
processes. The four browser skips in that backend run were tested separately:
all six dashboard cases (including the two new operator workflows) passed across
the final targeted runs. The visual gate checked 38 behaviors and 20 axe states.
The React sandbox passed its six unit tests, production build, real worker
recovery/browser flow at 320/768/1440 and four abuse-boundary checks, with no
unexpected console errors. These runs used private local task databases and do
not establish cloud capacity or a manual screen-reader result.

The 83/83 sabotage result in earlier branch evidence predates the current
operator and dashboard changes; it is historical, not current-head verification.

### Benchmark

The current priority and kind-filtered claim path was measured directly via
`queue.claim` (not HTTP) on local PostgreSQL 16.16, at 10k, 100k and 1M small
rows. The host was macOS 26.5.2 arm64, 8 logical CPUs and 16 GiB RAM; PostgreSQL
used 128 MiB shared buffers, 4 GiB effective cache, 4 MiB work memory and
`synchronous_commit=on`. The test used loopback, 15-second statement timeouts,
warm-ish analyzed data, and capped samples. These numbers are local
measurements, not cloud throughput or a capacity SLA.

| Rows | Ready noop p50/p95 | Future high / due low | Rare kind | Absent kind | Four-worker mix, max per-worker p50/p95 |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 3.108/9.745 ms | 4.840/6.092 ms | 4.804/8.133 ms | 3.239/4.907 ms | 3.947/10.161 ms |
| 100,000 | 2.873/3.370 ms | 21.889/22.876 ms | 18.902/20.920 ms | 13.095/14.686 ms | 3.896/6.521 ms |
| 1,000,000 baseline | 3.203/7.279 ms | 200.115/242.452 ms | 180.524/667.495 ms | 226.245/513.212 ms | 5.554/32.189 ms |
| 1,000,000 with kind/due index | 3.456/7.413 ms | 3.320/5.841 ms | 3.269/8.421 ms | 2.573/4.000 ms | existing ordered-index plan |

Ready workload: every row is due `noop`, priority 0, filter `['noop']`.
Future-priority workload: N−1 `noop` jobs at priority 100 due tomorrow and one
due priority-0 job at the final id. Rare-kind workload: N−1 due alternating
`legacy_a`/`legacy_b` rows and one final `word_count`; absent-kind workload has
no `word_count` match. Four-worker workload has equal due, priority-0 shares of
`word_count`, `sleep`, `noop`, and `custom`; each worker filters to one kind
and makes 50 claims. At 1M rows, baseline EXPLAIN plans for future, rare, and
absent filters scanned and sorted the table, filtering 999,999, 999,999, and
1,000,000 rows. A scratch-only partial index on `(kind, run_after)` for queued
rows changed those plans to bitmap heap scans with three shared blocks read;
the measured index used about 7.1 MB per million small rows. The query itself
was unchanged. Ready and mixed workloads continued to use the existing ordered
priority index. Measurements came from separate scratch runs, not paired
statistical trials. The index's sustained write cost was not measured. Full
plans, distributions, and limits are in the local task artifact `operator-load/report.md`;
that artifact path is outside this repository and may not exist in other copies.

### Docker

The 2026-11-14 isolated sandbox was also tested locally in Docker: the production
image runs as uid 999, the real PostgreSQL engine and four original workers run
the chaos flows, and browser and abuse checks cover its published loopback port.
This disposable lab has a private database network and a separate gateway network
for host publication. It is not a public hosted service or a durability test.

The original operator stack remains covered by the `compose` job in CI. It first
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
   token, an API failure, a 401, the New job screen with the
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
- The current Python full-suite run used PostgreSQL 16.16 and Python 3.13.1;
  historical chaos runs used PostgreSQL 16.15. Browser gates on the current
  head have 4 passes and 2 failures, so they are not currently green.
- Reusing an idempotency key with a different body returns the original job
  and ignores the new body. No error is raised.
- One shared token for everyone: no users, roles or audit of who requeued or
  cancelled a job, and changing the token means restarting the API and
  workers. Anyone with the token can submit, claim and cancel. Use TLS (a
  reverse proxy) if the API is reached over a network; leaseq itself serves
  plain HTTP.
- Rate limits are in-memory token buckets per API process, not global quotas.
  `LEASEQ_PUBLIC_READ=1` opens GET `/stats` and `/jobs`, including job-list
  fields, to anyone who can reach the port.
- The claim path orders due runnable jobs by priority descending then id
  ascending. The measured partial kind/due index improved the specified local
  sparse and absent-kind workloads; distributions, writes, cold cache and
  multi-host contention may differ.
- Finished jobs and events are never deleted, and the append-only trigger
  blocks deleting events. There is no retention or archiving.
- A database superuser or the table owner can disable the audit trigger. It
  protects against application bugs and mistakes, not against an administrator.
- `rejected` rows are written for every stale or wrong lease token, so a
  misbehaving client that has the API token can grow the audit log.
- A job whose worker is killed on every attempt ends up `dead` only when the
  next claim notices the expired lease; there is no background sweeper.
- The direct claim benchmark excludes HTTP/API overhead and handler time; it is
  not comparable to older HTTP throughput figures. No cloud capacity or
  unlimited-scale claim is supported by these local results.
- The dashboard is built for demo-scale queues. Its counts are still a
  `count(*)` over all jobs (95-145 ms at 520,010 jobs in four local EXPLAIN
  ANALYZE runs). The API runs it at most once per 5 seconds per API process
  however many tabs poll, but each run grows with history (a maintained
  counter would not). Filtered lists (`kind=`, `worker=`, `state=dead`) still
  scan the table; they are not indexed yet. With
  a job open, each refresh fetches up to 500 of that job's events. The job table shows at most the newest 200
  jobs per filter; older jobs are reached with the filters or "Open job" by id.
  The token is memory-only; reloading forgets it.

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

Local verification: [2026-11-15/16 checks and limits](docs/verification/release-2026-11-15.md).

### Isolated local PostgreSQL demonstration

The optional `LEASEQ_DEMO_DATABASE_URL` must name a **different database ending in `_demo`** owned by a dedicated demo role. Leave it unset in ordinary deployments. The local Compose setup provisions it separately; it never seeds the live queue. Run one API process for this local-only demonstration; it is not a public multi-tenant service.

Open `/`, `/leases`, or `/dead-letter` on the loopback host. The API advertises demo availability through `/healthz`. The demo starts with four idempotent sample jobs (queued, recoverable, completed, failed). **Run Interactive Demo** starts a task-owned Python worker. **Complete Active Lease** demonstrates the normal path. **Simulate Worker Crash** sends SIGKILL only to that process, waits for the real six-second PostgreSQL lease to expire, starts a replacement worker, and attempts the stale completion. Ownership history shows the real rejection; token fingerprints identify the old and replacement authority without exposing the tokens. No production timeout or ordinary worker is changed.

**Enqueue Sample Job** creates another recoverable sample (maximum 12 records; history is retained until an explicit reset). **Replay Dead-Letter Job** requeues the failed sample once per reset. **Reset demo** asks for confirmation, stops its owned worker, and recreates only the dedicated demo database’s sample schema with the original four jobs. It deletes demo history; live queue records and audit logs remain untouched. Refresh and other tabs read the same demo backend while navigation remains independent. The local endpoints require a loopback Host and same-origin POST, have a separate action limit, and inherit request-body limits. Browser Simulator remains a distinct synthetic option on static hosting.

Focused verification: `pytest -q tests/test_local_demo.py tests/test_security.py tests/test_api.py` passed 89 tests against PostgreSQL on 2026-11-16. This covers isolated seeding, actual worker kill/recovery, changed fencing-token fingerprints, stale completion rejection, normal completion, replay, host/origin denial, action validation and rate limiting. Browser and container results are recorded in the coordinator's product repair report.


### Canonical browser workspaces

The local app exposes `/overview`, `/workbench`, `/reports` and `/settings`; `/` opens Overview. Workbench retains the isolated PostgreSQL demo and authorized queue tools through contextual links. Reports exports actual selected job/event evidence as JSON or Markdown, without storing a run archive. Settings holds the existing API, profile, offline and diagnostics controls. Existing `/leases`, `/dead-letter`, `/system` and dashboard hash links remain supported.
