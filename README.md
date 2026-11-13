# leaseq

[CI status](https://github.com/anirudh763/leaseq/actions)

leaseq is a background job queue stored in PostgreSQL behind a small HTTP API.
Clients submit jobs; workers claim a job under a time-limited lease, do the
work, and report the result with the lease token they were given. It exists to
answer one question with evidence instead of a claim: if worker processes are
killed at random while they hold jobs, is any job lost, and is any job's result
recorded twice? The repository contains the queue, its HTTP API with bearer-token
authentication, an operations dashboard served by the API (about 1,000 lines of
Python, 83 of SQL and 980 of HTML/JavaScript/CSS in total), a fault-injection
test that kills workers with SIGKILL and then checks the database, and the
measured results below.

![The leaseq dashboard: job table with state tabs, and the details of a job that failed twice, was retried with backoff and then went dead](docs/screenshots/dashboard.png)

The screenshot shows real jobs from `python -m leaseq.demo` processed by one
worker, taken with `tests/e2e/readme_screenshot.js`.

## Quick start

Requires Python 3 and a PostgreSQL server (tested with Python 3.13 and PostgreSQL 16 only).

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

With Docker:

```
export LEASEQ_API_TOKEN=$(openssl rand -hex 24)
docker compose up --build
```

starts PostgreSQL, the API on 127.0.0.1:8000, one worker and a `demo` service
that enqueues sample jobs for 10 minutes. There is no default token: without
`LEASEQ_API_TOKEN` set, `docker compose` stops with a message saying so. Open
http://127.0.0.1:8000/dashboard/; it asks for the token before it shows any
jobs. `scripts/smoke.sh` (with the same `LEASEQ_API_TOKEN` exported) then checks
the stack end to end.

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
| `POST /jobs/{id}/fail` `{lease_token, error}` | Requeues with exponential backoff (2 s, 4 s, 8 s ... capped at 300 s), or marks the job `dead` once `attempts` reaches `max_attempts`. 409 on a stale token. |
| `GET /jobs/{id}` | The job, without its lease token. |
| `GET /stats` | Counts by state. |
| `GET /jobs?state=&kind=&worker=&before_id=&limit=` | Newest first, at most 200 per page (default 50), without payloads; `next_before_id` pages back. Also returns counts, including `retrying` (queued jobs already attempted). |
| `GET /jobs/{id}/events?after_id=&limit=` | The job's audit rows, oldest first, at most 500 per page. |
| `POST /jobs/{id}/requeue` `{extra_attempts}` | Dead job back to `queued` with more attempts (default 3). `attempts` is kept; `max_attempts` is raised. 409 if the job is not dead. |
| `POST /jobs/{id}/cancel` `{reason}` | Queued or leased job to `dead` and its lease token cleared, so a worker still running it gets 409 and records nothing. 409 otherwise. |
| `GET /auth/check` | 200 if the token is right, 401 if not. |
| `POST /demo/jobs` | Enqueues the 16 sample jobs that `python -m leaseq.demo` sends. |

A job is runnable when it is `queued` and its `run_after` has passed, or when
it is `leased` and the lease has expired. Every state change inserts one row
into `job_events` in the same transaction.

## Dashboard

`/dashboard/` is plain HTML, CSS and JavaScript inside the package: no build
step, no CDN, no third-party code. It shows counts per state as tabs, a job
table filtered by state, kind and worker (the filters are in the URL, so a view
can be shared), and a side panel with a job's lease history (one row per
attempt: worker, lease length, outcome) and its audit events. It refreshes
every 2 seconds; "Pause updates" stops that.

It is read-only until you enter the API token. The token is checked with
`GET /auth/check`, kept in the page's memory only (not in a cookie, local or
session storage, or the URL) and sent only in the `Authorization` header, so
another site cannot make the browser send it: there is no CSRF surface. With a
token, "Requeue job" and "Cancel job" appear, and each asks for confirmation.
Job payloads are shown as text, never as HTML, and the page is served with a
`Content-Security-Policy` that allows only its own files.

Accessibility: passes automated axe-core checks (WCAG 2.2 A/AA and best-practice
rules) with 0 violations in 17 scanned states, light and dark, including dialogs,
an API failure, and 375 px and 640 px widths (640 px is a 1280 px window at 200%
zoom). The Playwright tests also drive the main flows with the keyboard only. A
manual screen-reader check has not been run.

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
| `python scripts/chaos.py` (seed 1) | 2000 | 50 | 46 | 33 | 46.9 s | PASS |
| negative control (`--unfenced`, 60 jobs) | 60 | 0 | | | | FAIL: 68 effect rows, 8 jobs completed twice |

The seed fixes the job payloads, the victim of each kill and the gaps between
kills. It does not fix operating-system scheduling, so the job a kill lands
on, and therefore the counts in the table, change from run to run. An earlier
run of seed 1 on the same machine gave 63 retried jobs in 29.7 s.

### Tests

```
python -m pytest -q
```

83 tests passed in 107 s (load average 3.5 to 4.9 from other jobs on the machine). This includes a reduced chaos run (300 jobs, 12
kills), the negative control (40 jobs), the authentication and input-limit
tests in `tests/test_security.py`, and two Playwright browser tests in
`tests/test_dashboard_e2e.py`. The browser tests need Node, the `playwright`
package and axe-core (`AXE_PATH`); without them they are skipped. One of them
runs real worker processes: the dashboard enqueues jobs, a worker completes
them, a failing job retries with backoff until it is dead, one job is
cancelled and one requeued, and an API failure is simulated.

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

`Dockerfile` and `docker-compose.yml`: not run here. The container this was
built in has the docker CLI but no Docker daemon (`docker info` fails to
connect to `/var/run/docker.sock`). The CI workflow builds the compose file
and runs `scripts/smoke.sh` against it, so GitHub Actions is where that gets
verified; until the first CI run it is untested. `scripts/smoke.sh` was run
here against the same setup started as local processes instead of containers
(API with a token and no public reads, one worker, the demo feeder) and passed:
an anonymous write and an anonymous read both got 401, the dashboard was served,
and the job finished.

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
- The dashboard shows at most the newest 200 jobs per filter; older jobs are
  reached with the filters or "Open job" by id.

## How this was built

Built with AI assistance (Claude). Every number above comes from the commands shown.

## License

MIT, see `LICENSE`. The dashboard's Atkinson Hyperlegible font files are under the
SIL Open Font License 1.1; the license text is in
`leaseq/dashboard/assets/OFL.txt`.
