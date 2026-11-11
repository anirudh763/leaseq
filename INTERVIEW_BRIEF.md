# Interview brief: leaseq

## What it does, in three sentences

leaseq is a job queue stored in one PostgreSQL table and exposed over a small
HTTP API: clients submit jobs, workers claim them under a time-limited lease.
If a worker dies, its lease runs out and another worker gets the job; the dead
or slow worker's lease token no longer matches, so it cannot record a result.
A test kills workers with SIGKILL while they run and then checks in SQL that
every job finished and none finished twice.

## How the data flows, file by file

1. `leaseq/schema.sql` creates `jobs`, `job_events` (the audit log, with a
   trigger that rejects UPDATE, DELETE and TRUNCATE) and `effects` (the
   worker's side effect).
2. `leaseq/db.py` opens connections. They are in autocommit mode, so a
   transaction exists only where the code writes `with conn.transaction():`.
3. `leaseq/api.py` receives a request, validates it with pydantic, calls one
   function in `queue.py`, and turns the answer into a status code
   (201/200 for submit, 204 for "nothing to claim", 409 for "lease lost",
   404 for "no such job").
4. `leaseq/queue.py` is where the rules live. `enqueue` inserts with
   `ON CONFLICT DO NOTHING`. `claim` selects the oldest runnable row with
   `FOR UPDATE SKIP LOCKED`, writes a new random token and an expiry time, and
   bumps `attempts`. `complete`, `fail` and `heartbeat` all have
   `WHERE id = ... AND state = 'leased' AND lease_token = ...`; if that matches
   no row, nothing changes. Each state change calls `_event(...)` inside the
   same transaction.
5. `leaseq/worker.py` loops: claim over HTTP, run `handle(job)`, then call
   `finish`, which opens one transaction, calls `queue.complete` and inserts
   the `effects` row. Both commit or neither does.
6. `scripts/chaos.py` starts the API and the workers as real processes, kills
   workers, and `verify()` runs the SQL checks. `tests/test_chaos.py` calls the
   same function with smaller numbers.

## The three hardest questions

**1. "You say exactly once. That is impossible in a distributed system. What
do you actually guarantee?"**

Delivery is at-least-once: a job can be handed out several times (in the chaos
runs in the README, 65 to 69 of 2,000 jobs were attempted more than once). What happens once is
the *recorded completion*, because completing is a single UPDATE that only
matches while the caller's token is the current one, and the side effect is in
the same transaction. That only works because the side effect is a row in the
same database. If the effect were an email or a call to another service, a
worker could send it and then die before completing, and the next worker would
send it again. For that case the job would need to pass its own idempotency
key to the other service. The README says this under Limitations.

**2. "A worker's lease has expired but nobody else has claimed the job yet. It
calls complete. What happens, and is that right?"**

It succeeds. The check is on the token, not on the clock. That is safe
because the claim and the completion both lock the same row: either the
completion commits first and the claim query no longer sees a leased row, or
the claim commits first, the token changes, and the completion matches zero
rows. There is a test for this
(`test_expired_but_not_reissued_lease_can_still_complete`). Rejecting it would
also be correct but would throw away finished work for no safety gain.

**3. "Your effects table could just have a unique constraint on job_id. Why
doesn't it? And how do I know your chaos test can fail?"**

It is left out on purpose so the test measures the fencing rather than a
constraint. In production I would add the constraint as a second line of
defence. To show the test can fail, the worker has an `--unfenced` flag that
skips the token check; `tests/test_chaos.py` runs it and asserts that the
checker reports duplicates (8 of 60 jobs completed twice in the run in the
README). Honest weak point: the kills are seeded but OS scheduling is not, so
two runs do not kill at the same instruction. The test shows the invariants
held on the runs performed; it is not a proof.

Other things to know cold: the lease length is a trade-off (short lease =
fast recovery but more false takeovers of slow workers); all time comparisons
use the database's `now()`, so worker clocks do not matter; `GET /jobs/{id}`
never returns the lease token; a database superuser can still disable the
audit trigger.

## One small change to make yourself

Add a `priority` column. Steps: add `priority INT NOT NULL DEFAULT 0` to
`jobs` in `schema.sql`; accept it in `JobIn` (`api.py`) and pass it through
`queue.enqueue`; change the claim query's `ORDER BY id` to
`ORDER BY priority DESC, id`; write a test in `tests/test_api.py` that submits
a low-priority job first and a high-priority job second and asserts the second
is claimed first. Then think about what index the new ORDER BY needs, and
check with `EXPLAIN` in `psql`.
