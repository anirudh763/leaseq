# leaseq

[CI status](https://github.com/anirudh763/leaseq/actions)

leaseq is a background job queue stored in PostgreSQL behind a small HTTP API.
Clients submit jobs; workers claim a job under a time-limited lease, do the
work, and report the result with the lease token they were given. It exists to
answer one question with evidence instead of a claim: if worker processes are
killed at random while they hold jobs, is any job lost, and is any job's result
recorded twice? The repository contains the queue (about 450 lines of Python
and 65 of SQL), a fault-injection test that kills workers with SIGKILL and then
checks the database, and the measured results below.

## Quick start

Requires Python 3 and a PostgreSQL server (tested with Python 3.13 and PostgreSQL 16 only).

```
pip install -r requirements.txt

# Option A: a throwaway local PostgreSQL on port 54329 (uses initdb/pg_ctl)
scripts/dev_postgres.sh start
export LEASEQ_DATABASE_URL=postgresql://leaseq@127.0.0.1:54329/leaseq

# Option B: any PostgreSQL you already have
export LEASEQ_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME

uvicorn leaseq.api:app --port 8000 &                       # applies leaseq/schema.sql on start
python -m leaseq.worker --api http://127.0.0.1:8000 --worker-id w1 &

curl -X POST localhost:8000/jobs -H 'Content-Type: application/json' \
     -H 'Idempotency-Key: demo-1' -d '{"kind": "sleep", "payload": {"ms": 100}}'
curl localhost:8000/jobs/1
curl localhost:8000/stats
```

With Docker: `docker compose up --build` starts PostgreSQL, the API on port
8000 and one worker; `scripts/smoke.sh` then checks it end to end.

### API

| Request | Behaviour |
|---|---|
| `POST /jobs` + `Idempotency-Key` header, body `{kind, payload, max_attempts}` | 201 with the new job, or 200 with the existing job if the key was used before. Never a second row. |
| `POST /jobs/claim` `{worker_id, lease_seconds}` | 200 with the oldest runnable job and a fresh random `lease_token`, or 204 if nothing is runnable. |
| `POST /jobs/{id}/heartbeat` `{lease_token, lease_seconds}` | Extends the lease. 409 if the token is not the current one. |
| `POST /jobs/{id}/complete` `{lease_token, result}` | Marks the job done. 409 if the token is not the current one. |
| `POST /jobs/{id}/fail` `{lease_token, error}` | Requeues with exponential backoff (2 s, 4 s, 8 s ... capped at 300 s), or marks the job `dead` once `attempts` reaches `max_attempts`. 409 on a stale token. |
| `GET /jobs/{id}` | The job, without its lease token. |
| `GET /stats` | Counts by state. |

A job is runnable when it is `queued` and its `run_after` has passed, or when
it is `leased` and the lease has expired. Every state change inserts one row
into `job_events` in the same transaction.

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

The seed fixes the job payloads, the victim of each kill and the gaps between
kills. It does not fix operating-system scheduling, so the job a kill lands
on, and therefore the counts in the table, change from run to run. An earlier
run of seed 1 on the same machine gave 63 retried jobs in 29.7 s.

### Tests

```
python -m pytest -q
```

26 tests passed in about 23 s. This includes a reduced chaos run (300 jobs, 12
kills) and the negative control (40 jobs).

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

Throughput stops rising between 4 and 8 clients. The container has 2 cores
shared by PostgreSQL, the API process and the benchmark clients themselves; I
did not profile which of them is the limit, so these numbers describe this
setup, not PostgreSQL's ceiling.

### Docker

`Dockerfile` and `docker-compose.yml`: not run here. The container this was
built in has the docker CLI but no Docker daemon (`docker info` fails to
connect to `/var/run/docker.sock`). The CI workflow builds the compose file
and runs `scripts/smoke.sh` against it, so GitHub Actions is where that gets
verified; until the first CI run it is untested. `scripts/smoke.sh` itself was
run here against a locally started API and worker and passed.

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
- The 26-test suite and the chaos runs were only run on PostgreSQL 16.15 and
  Python 3.13.
- Reusing an idempotency key with a different body returns the original job
  and ignores the new body. No error is raised.
- No authentication. Anyone who can reach the API can submit and claim jobs.
  Lease tokens stop stale workers, not malicious ones.
- The claim query orders unfinished jobs by id. Jobs waiting on a long backoff
  are scanned and skipped on every claim, so a large backlog of delayed jobs
  would slow claiming. Not measured.
- Finished jobs and events are never deleted, and the append-only trigger
  blocks deleting events. There is no retention or archiving.
- A database superuser or the table owner can disable the audit trigger. It
  protects against application bugs and mistakes, not against an administrator.
- `rejected` rows are written for every stale or wrong token, so a
  misbehaving client can grow the audit log.
- A job whose worker is killed on every attempt ends up `dead` only when the
  next claim notices the expired lease; there is no background sweeper.
- Benchmarks are from a 2-core shared container with client, API and database
  competing for the same cores.

## How this was built

Built with AI assistance (Claude). Every number above comes from the commands shown.

## License

MIT, see `LICENSE`.
