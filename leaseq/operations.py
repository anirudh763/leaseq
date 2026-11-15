"""Bounded, authenticated operator reads and bulk actions."""
import threading
import time
from datetime import timedelta

import psycopg

from . import queue


class MetricsCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._value = None
        self._until = 0.0

    def get(self, compute):
        now = time.monotonic()
        if self._value is not None and now < self._until:
            return self._value
        with self._lock:
            if self._value is None or time.monotonic() >= self._until:
                self._value = compute()
                self._until = time.monotonic() + 5
            return self._value


def workers(conn, limit=100):
    rows = conn.execute(
        "SELECT w.worker_id, w.last_seen_at, w.kinds, w.last_heartbeat_at, "
        "(SELECT count(*) FROM jobs j WHERE j.state='leased' AND j.leased_by=w.worker_id "
        " AND j.lease_expires_at > now()) AS active_jobs "
        "FROM worker_observations w ORDER BY w.last_seen_at DESC, w.worker_id LIMIT %s",
        (limit + 1,)).fetchall()
    return {"workers": rows[:limit], "as_of": conn.execute("SELECT now() AS n").fetchone()["n"],
            "limit": limit, "truncated": len(rows) > limit}


def metrics(conn):
    with conn.transaction():
        conn.execute("SET LOCAL statement_timeout = '2s'")
        rows = conn.execute(
            "WITH sampled AS (SELECT id, job_id, event, attempt, created_at "
            " FROM job_events WHERE created_at >= now() - interval '15 minutes' "
            " AND event IN ('claimed','completed','failed') "
            " AND (event <> 'claimed' OR attempt = 1) "
            " ORDER BY created_at, id LIMIT 5001) "
            "SELECT s.*, j.available_at FROM sampled s LEFT JOIN jobs j ON j.id=s.job_id "
            "ORDER BY s.created_at, s.id").fetchall()
        as_of = conn.execute("SELECT now() AS n").fetchone()["n"]
    truncated = len(rows) > 5000
    rows = rows[:5000]
    starts = [as_of.replace(second=0, microsecond=0) - timedelta(minutes=i)
              for i in range(14, -1, -1)]
    buckets = {start: {"start": start, "completed": 0, "failed": 0} for start in starts}
    waits = []
    for row in rows:
        start = row["created_at"].replace(second=0, microsecond=0)
        if start in buckets and row["event"] in ("completed", "failed"):
            buckets[start][row["event"]] += 1
        if row["event"] == "claimed" and row["available_at"] is not None:
            waits.append(max(0.0, (row["created_at"] - row["available_at"]).total_seconds() * 1000))
    waits.sort()

    def percentile(p):
        if not waits:
            return None
        at = (len(waits) - 1) * p
        lo, hi = int(at), min(int(at) + 1, len(waits) - 1)
        return round(waits[lo] + (waits[hi] - waits[lo]) * (at - lo), 3)

    return {"as_of": as_of, "window_seconds": 900, "sample_limit": 5000,
            "truncated": truncated, "buckets": list(buckets.values()),
            "wait_ms": {"p50": percentile(.5), "p95": percentile(.95), "samples": len(waits)},
            "definitions": {"buckets": "completed and failed events per UTC minute",
                            "wait_ms": "first claim minus initial availability; negative values clamp to zero; historical unknown availability excluded"}}


def bulk(conn, action, ids, deadline_seconds=5):
    results = []
    deadline = time.monotonic() + deadline_seconds
    for i, job_id in enumerate(ids):
        if time.monotonic() >= deadline:
            results.extend({"id": rest, "status": "not_attempted"} for rest in ids[i:])
            break
        try:
            with conn.transaction():
                conn.execute("SET LOCAL statement_timeout = '500ms'")
                if action == "requeue":
                    job = queue.requeue(conn, job_id, 3)
                else:
                    job = queue.cancel(conn, job_id, "bulk operator action")
            results.append({"id": job_id, "status": "changed", "job": job} if job else
                           {"id": job_id, "status": "conflict"})
        except queue.JobNotFound:
            results.append({"id": job_id, "status": "not_found"})
        except (psycopg.Error, TimeoutError):
            results.append({"id": job_id, "status": "error"})
    processed = sum(r["status"] != "not_attempted" for r in results)
    return {"action": action, "results": results, "processed": processed,
            "remaining": len(ids) - processed}
