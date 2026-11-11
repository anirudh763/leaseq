"""Worker: claim a job over HTTP, do the work, then record the side effect and
the completion in ONE database transaction guarded by the lease token.

    python -m leaseq.worker --api http://127.0.0.1:8000 --worker-id w1

The side effect here is a row in the `effects` table. Because it commits or
rolls back together with the fenced completion, a worker that is killed at any
point, or that finishes after its lease was re-issued, leaves no effect behind.
"""
import argparse
import time

import httpx
import psycopg

from . import db, queue


class LeaseLost(Exception):
    pass


def handle(job: dict, api: httpx.Client, lease_seconds: float) -> dict:
    """Do the job's work. Job kinds are deliberately trivial:

    sleep  payload {"ms": n, "stall_ms": m}: work for n ms, heartbeating so the
           lease stays alive. On the first attempt only, also stall for m ms
           WITHOUT heartbeating; this simulates a paused or partitioned worker
           and is how the chaos test produces zombie workers.
    fail   always raises (exercises retry and dead-lettering).
    other  no work.
    """
    payload = job["payload"]
    if job["kind"] == "fail":
        raise RuntimeError(payload.get("error", "job kind 'fail' always fails"))
    if job["kind"] == "sleep":
        if job["attempts"] == 1 and payload.get("stall_ms"):
            time.sleep(payload["stall_ms"] / 1000)
        remaining = payload.get("ms", 0) / 1000
        while remaining > 0:
            step = min(remaining, lease_seconds / 3)
            time.sleep(step)
            remaining -= step
            if remaining > 0:
                r = api.post(f"/jobs/{job['id']}/heartbeat", json={
                    "lease_token": job["lease_token"], "lease_seconds": lease_seconds})
                if r.status_code == 409:
                    raise LeaseLost()
    return {"worker": job["leased_by"]}


def finish(conn: psycopg.Connection, job: dict, result: dict, worker_id: str,
           unfenced: bool = False) -> bool:
    """Completion + side effect, atomically. Returns False if the lease was lost."""
    with conn.transaction():
        if unfenced:
            _complete_without_token_check(conn, job, worker_id)
        elif queue.complete(conn, job["id"], job["lease_token"], result, worker_id) is None:
            return False      # the 'rejected' audit row still commits; no effect is written
        conn.execute("INSERT INTO effects (job_id, worker_id) VALUES (%s, %s)",
                     (job["id"], worker_id))
        return True


def _complete_without_token_check(conn, job, worker_id):
    """NEGATIVE CONTROL for the chaos test only (--unfenced). This is the bug the
    lease token exists to prevent: it lets a zombie worker complete a job again."""
    conn.execute("UPDATE jobs SET state = 'done', lease_token = NULL, "
                 "lease_expires_at = NULL, updated_at = now() WHERE id = %s", (job["id"],))
    queue._event(conn, job["id"], "completed", job["attempts"], worker_id, {"unfenced": True})


def run(api_url: str, worker_id: str, lease_seconds: float, poll_seconds: float,
        unfenced: bool = False) -> None:
    api = httpx.Client(base_url=api_url, timeout=10)
    conn = db.connect()
    while True:
        try:
            r = api.post("/jobs/claim", json={"worker_id": worker_id,
                                              "lease_seconds": lease_seconds})
            if r.status_code == 204:
                time.sleep(poll_seconds)
                continue
            r.raise_for_status()
            job = r.json()
            try:
                result = handle(job, api, lease_seconds)
            except LeaseLost:
                continue
            except Exception as exc:    # the job failed, not the worker: report it
                api.post(f"/jobs/{job['id']}/fail",
                         json={"lease_token": job["lease_token"], "error": repr(exc)})
                continue
            finish(conn, job, result, worker_id, unfenced)
        except httpx.HTTPError:
            time.sleep(poll_seconds)    # API unreachable; whatever we held will expire
        except psycopg.OperationalError:
            time.sleep(poll_seconds)    # database connection dropped; reconnect
            try:
                conn = db.connect()
            except psycopg.OperationalError:
                pass


def main() -> None:
    p = argparse.ArgumentParser(description="leaseq worker")
    p.add_argument("--api", default="http://127.0.0.1:8000")
    p.add_argument("--worker-id", required=True)
    p.add_argument("--lease-seconds", type=float, default=30)
    p.add_argument("--poll-seconds", type=float, default=0.2)
    p.add_argument("--unfenced", action="store_true",
                   help="negative control for the chaos test: skip the lease-token check")
    a = p.parse_args()
    run(a.api, a.worker_id, a.lease_seconds, a.poll_seconds, a.unfenced)


if __name__ == "__main__":
    main()
