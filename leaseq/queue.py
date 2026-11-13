"""Queue operations as plain SQL. Each function is one transaction.

Rules that hold everywhere in this file:
  * Time comes from the database clock (now()), never from a worker.
  * Every state change inserts exactly one job_events row in the same transaction.
  * complete/fail/heartbeat only act if the caller holds the current lease token.
"""
import os
import secrets

from psycopg import Connection
from psycopg.types.json import Jsonb

BACKOFF_BASE = float(os.environ.get("LEASEQ_BACKOFF_BASE", "2"))    # seconds
BACKOFF_CAP = float(os.environ.get("LEASEQ_BACKOFF_CAP", "300"))    # seconds

# Columns returned to clients. lease_token is left out on purpose: the token
# is only ever handed to the worker that claimed the job.
PUBLIC = ("id, kind, payload, state, attempts, max_attempts, run_after, "
          "lease_expires_at, leased_by, idempotency_key, result, created_at, updated_at")


class JobNotFound(Exception):
    pass


def backoff_seconds(attempts: int) -> float:
    """Delay before retry number `attempts`+1: base, 2*base, 4*base ... capped."""
    # The exponent is clamped: 2.0 ** 1024 overflows a float. 2 ** 30 is already
    # far beyond any cap, so the result is unchanged for every realistic value.
    return min(BACKOFF_CAP, BACKOFF_BASE * 2 ** min(attempts - 1, 30))


def _event(conn, job_id, event, attempt, worker_id=None, detail=None):
    conn.execute(
        "INSERT INTO job_events (job_id, event, attempt, worker_id, detail) "
        "VALUES (%s, %s, %s, %s, %s)",
        (job_id, event, attempt, worker_id, Jsonb(detail or {})))


def enqueue(conn: Connection, kind: str, payload: dict, idempotency_key: str,
            max_attempts: int = 5) -> tuple[dict, bool]:
    """Insert a job, or return the existing one with this key. -> (job, created)"""
    with conn.transaction():
        # ON CONFLICT DO NOTHING waits for a concurrent insert of the same key
        # to commit, then inserts nothing; the SELECT below then sees that row.
        job = conn.execute(
            f"INSERT INTO jobs (kind, payload, idempotency_key, max_attempts) "
            f"VALUES (%s, %s, %s, %s) ON CONFLICT (idempotency_key) DO NOTHING "
            f"RETURNING {PUBLIC}",
            (kind, Jsonb(payload), idempotency_key, max_attempts)).fetchone()
        if job is not None:
            _event(conn, job["id"], "enqueued", 0)
            return job, True
    job = conn.execute(f"SELECT {PUBLIC} FROM jobs WHERE idempotency_key = %s",
                       (idempotency_key,)).fetchone()
    return job, False


def claim(conn: Connection, worker_id: str, lease_seconds: float) -> dict | None:
    """Lease the oldest runnable job, or return None if there is none.

    Runnable means: queued and due, or leased with an expired lease (its worker
    is presumed dead). SKIP LOCKED makes concurrent claimers pass over a row
    another claimer is holding instead of waiting for it.
    """
    with conn.transaction():
        while True:
            job = conn.execute(
                "SELECT id, state, attempts, max_attempts, leased_by FROM jobs "
                "WHERE (state = 'queued' AND run_after <= now()) "
                "   OR (state = 'leased' AND lease_expires_at <= now()) "
                "ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED").fetchone()
            if job is None:
                return None
            if job["attempts"] >= job["max_attempts"]:
                # Its last allowed attempt held the lease until it expired.
                conn.execute(
                    "UPDATE jobs SET state = 'dead', lease_token = NULL, "
                    "lease_expires_at = NULL, updated_at = now() WHERE id = %s", (job["id"],))
                _event(conn, job["id"], "dead", job["attempts"], job["leased_by"],
                       {"reason": "lease expired on final attempt"})
                continue
            token = secrets.token_urlsafe(16)
            leased = conn.execute(
                f"UPDATE jobs SET state = 'leased', attempts = attempts + 1, "
                f"lease_token = %s, leased_by = %s, updated_at = now(), "
                f"lease_expires_at = now() + make_interval(secs => %s) "
                f"WHERE id = %s RETURNING {PUBLIC}",
                (token, worker_id, lease_seconds, job["id"])).fetchone()
            detail = {"lease_seconds": lease_seconds}
            if job["state"] == "leased":
                detail["took_over_expired_lease_of"] = job["leased_by"]
            _event(conn, job["id"], "claimed", leased["attempts"], worker_id, detail)
            leased["lease_token"] = token
            return leased


def heartbeat(conn: Connection, job_id: int, token: str, lease_seconds: float) -> dict | None:
    """Extend the lease. Returns None if the token is not the current one."""
    job = conn.execute(
        f"UPDATE jobs SET lease_expires_at = now() + make_interval(secs => %s), "
        f"updated_at = now() WHERE id = %s AND state = 'leased' AND lease_token = %s "
        f"RETURNING {PUBLIC}", (lease_seconds, job_id, token)).fetchone()
    if job is None:
        _require_exists(conn, job_id)
    return job


def complete(conn: Connection, job_id: int, token: str, result: dict | None = None,
             worker_id: str | None = None) -> dict | None:
    """Mark the job done if `token` is its current lease token.

    Returns the job, or None if the lease was lost (expired and re-issued, or
    the job is already finished). The UPDATE takes the row lock, so it cannot
    interleave with a concurrent claim of the same row: one of them goes first
    and the other sees the result. Call this inside an outer transaction to
    make a side effect atomic with the completion (see worker.py).
    """
    with conn.transaction():
        job = conn.execute(
            f"UPDATE jobs SET state = 'done', result = %s, lease_token = NULL, "
            f"lease_expires_at = NULL, updated_at = now() "
            f"WHERE id = %s AND state = 'leased' AND lease_token = %s RETURNING {PUBLIC}",
            (Jsonb(result), job_id, token)).fetchone()
        if job is None:
            _rejected(conn, job_id, "complete", worker_id)
            return None
        _event(conn, job_id, "completed", job["attempts"], worker_id or job["leased_by"])
        return job


def fail(conn: Connection, job_id: int, token: str, error: str,
         worker_id: str | None = None) -> dict | None:
    """Report a failed attempt: requeue with backoff, or dead-letter when out of attempts."""
    with conn.transaction():
        cur = conn.execute(
            "SELECT attempts, max_attempts, leased_by FROM jobs "
            "WHERE id = %s AND state = 'leased' AND lease_token = %s FOR UPDATE",
            (job_id, token)).fetchone()
        if cur is None:
            _rejected(conn, job_id, "fail", worker_id)
            return None
        worker_id = worker_id or cur["leased_by"]
        if cur["attempts"] >= cur["max_attempts"]:
            state, delay = "dead", 0.0
            _event(conn, job_id, "dead", cur["attempts"], worker_id, {"error": error})
        else:
            state, delay = "queued", backoff_seconds(cur["attempts"])
            _event(conn, job_id, "failed", cur["attempts"], worker_id,
                   {"error": error, "retry_in_seconds": delay})
        return conn.execute(
            f"UPDATE jobs SET state = %s, lease_token = NULL, lease_expires_at = NULL, "
            f"run_after = now() + make_interval(secs => %s), updated_at = now() "
            f"WHERE id = %s RETURNING {PUBLIC}", (state, delay, job_id)).fetchone()


def get(conn: Connection, job_id: int) -> dict:
    job = conn.execute(f"SELECT {PUBLIC} FROM jobs WHERE id = %s", (job_id,)).fetchone()
    if job is None:
        raise JobNotFound(job_id)
    return job


def stats(conn: Connection) -> dict:
    row = conn.execute(
        "SELECT count(*) FILTER (WHERE state = 'queued') AS queued, "
        "count(*) FILTER (WHERE state = 'leased') AS leased, "
        "count(*) FILTER (WHERE state = 'done') AS done, "
        "count(*) FILTER (WHERE state = 'dead') AS dead, "
        "count(*) FILTER (WHERE state = 'leased' AND lease_expires_at <= now()) AS expired_leases, "
        "count(*) AS total FROM jobs").fetchone()
    return dict(row)


# --- reads for the dashboard ---------------------------------------------------
#
# Every list is bounded: the API caps `limit`, and paging is by id (keyset),
# so a page costs the same however much history there is. The WHERE clauses
# below are joined from the fixed strings in this file only; every value from
# a request goes in as a %s parameter.

MAX_PAGE = 200
MAX_EVENTS_PAGE = 500

# The list leaves out payload and result (each can be up to the body limit);
# GET /jobs/{id} returns them for one job.
SUMMARY = ("id, kind, state, attempts, max_attempts, run_after, lease_expires_at, "
           "leased_by, idempotency_key, created_at, updated_at")

STATE_FILTERS = {
    "queued": "state = 'queued'",
    "leased": "state = 'leased'",
    "retrying": "state = 'queued' AND attempts > 0",   # a subset of queued
    "done": "state = 'done'",
    "dead": "state = 'dead'",
}


def list_jobs(conn: Connection, state: str | None = None, kind: str | None = None,
              worker: str | None = None, before_id: int | None = None,
              limit: int = 50) -> tuple[list[dict], int | None]:
    """Newest first. -> (jobs, id to pass as before_id for the next page, or None)"""
    limit = max(1, min(limit, MAX_PAGE))
    where, params = [], []
    if state is not None:
        where.append(STATE_FILTERS[state])           # KeyError for anything else
    if kind is not None:
        where.append("kind = %s")
        params.append(kind)
    if worker is not None:
        where.append("leased_by = %s")
        params.append(worker)
    if before_id is not None:
        where.append("id < %s")
        params.append(before_id)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    rows = conn.execute(f"SELECT {SUMMARY} FROM jobs{clause} ORDER BY id DESC LIMIT %s",
                        (*params, limit + 1)).fetchall()
    next_before = rows[limit - 1]["id"] if len(rows) > limit else None
    return rows[:limit], next_before


def counts(conn: Connection) -> dict:
    """Like stats(), plus `retrying`: queued jobs that have already been attempted."""
    row = conn.execute(
        "SELECT count(*) FILTER (WHERE state = 'queued') AS queued, "
        "count(*) FILTER (WHERE state = 'queued' AND attempts > 0) AS retrying, "
        "count(*) FILTER (WHERE state = 'leased') AS leased, "
        "count(*) FILTER (WHERE state = 'done') AS done, "
        "count(*) FILTER (WHERE state = 'dead') AS dead, "
        "count(*) FILTER (WHERE state = 'leased' AND lease_expires_at <= now()) AS expired_leases, "
        "count(*) AS total FROM jobs").fetchone()
    return dict(row)


def events(conn: Connection, job_id: int, after_id: int = 0,
           limit: int = 200) -> tuple[list[dict], int | None]:
    """The job's audit rows, oldest first. -> (events, after_id for the next page, or None)"""
    _require_exists(conn, job_id)
    limit = max(1, min(limit, MAX_EVENTS_PAGE))
    rows = conn.execute(
        "SELECT id, event, attempt, worker_id, detail, created_at FROM job_events "
        "WHERE job_id = %s AND id > %s ORDER BY id LIMIT %s",
        (job_id, after_id, limit + 1)).fetchall()
    next_after = rows[limit - 1]["id"] if len(rows) > limit else None
    return rows[:limit], next_after


# --- operator actions ---------------------------------------------------------
#
# Neither touches the fencing rule. cancel() clears the lease token exactly as
# complete() and fail() do, so a worker still running a cancelled job gets a
# 409 from heartbeat/complete and its transaction writes no effect.

def requeue(conn: Connection, job_id: int, extra_attempts: int) -> dict | None:
    """Put a dead job back in the queue with `extra_attempts` more tries.

    `attempts` is not reset (it counts claims, and the audit log has one claim
    row per attempt); max_attempts is raised instead. Returns None if the job
    is not dead.
    """
    with conn.transaction():
        cur = conn.execute("SELECT state, attempts, max_attempts FROM jobs "
                           "WHERE id = %s FOR UPDATE", (job_id,)).fetchone()
        if cur is None:
            raise JobNotFound(job_id)
        if cur["state"] != "dead":
            return None
        job = conn.execute(
            f"UPDATE jobs SET state = 'queued', run_after = now(), updated_at = now(), "
            f"max_attempts = attempts + %s WHERE id = %s RETURNING {PUBLIC}",
            (extra_attempts, job_id)).fetchone()
        _event(conn, job_id, "requeued", cur["attempts"], None,
               {"extra_attempts": extra_attempts,
                "previous_max_attempts": cur["max_attempts"]})
        return job


def cancel(conn: Connection, job_id: int, reason: str = "") -> dict | None:
    """Stop a queued or leased job: it becomes dead. Returns None otherwise."""
    with conn.transaction():
        cur = conn.execute("SELECT state, attempts, leased_by FROM jobs "
                           "WHERE id = %s FOR UPDATE", (job_id,)).fetchone()
        if cur is None:
            raise JobNotFound(job_id)
        if cur["state"] not in ("queued", "leased"):
            return None
        job = conn.execute(
            f"UPDATE jobs SET state = 'dead', lease_token = NULL, lease_expires_at = NULL, "
            f"updated_at = now() WHERE id = %s RETURNING {PUBLIC}", (job_id,)).fetchone()
        _event(conn, job_id, "cancelled", cur["attempts"],
               cur["leased_by"] if cur["state"] == "leased" else None,
               {"from_state": cur["state"], "reason": reason})
        return job


def _require_exists(conn, job_id):
    row = conn.execute("SELECT attempts FROM jobs WHERE id = %s", (job_id,)).fetchone()
    if row is None:
        raise JobNotFound(job_id)
    return row


def _rejected(conn, job_id, op, worker_id):
    """A stale or wrong token changed nothing; record that it was turned away."""
    row = _require_exists(conn, job_id)
    _event(conn, job_id, "rejected", row["attempts"], worker_id, {"op": op})
