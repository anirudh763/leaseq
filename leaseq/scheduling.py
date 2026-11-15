"""UTC numeric five-field cron validation and durable dispatch."""
import re
from datetime import datetime, timezone

from croniter import CroniterBadDateError, croniter
from psycopg.types.json import Jsonb

from .queue import PUBLIC, _event

CRON_PATTERN = re.compile(r"^[0-9*/,-]+(?:\s+[0-9*/,-]+){4}$")
def next_run(expression, base):
    if not isinstance(expression, str) or len(expression) > 100 or not CRON_PATTERN.fullmatch(expression):
        raise ValueError("cron must be a numeric five-field expression")
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    base = base.astimezone(timezone.utc)
    if not croniter.is_valid(expression, strict=True):
        raise ValueError("invalid cron expression")
    try:
        result = croniter(expression, base, max_years_between_matches=5).get_next(datetime)
    except CroniterBadDateError as exc:
        raise ValueError("cron has no match within five years") from exc
    result = result.replace(tzinfo=timezone.utc)
    try:
        deadline = base.replace(year=base.year + 5)
    except ValueError:  # Feb 29 base on a non-leap year
        deadline = base.replace(year=base.year + 5, day=28)
    if result > deadline:
        raise ValueError("cron has no match within five years")
    return result


def create(conn, *, name, kind, payload, cron, priority, max_attempts, key):
    with conn.transaction():
        now = conn.execute("SELECT now() AS n").fetchone()["n"]
        due = next_run(cron, now)
        row = conn.execute(
            "INSERT INTO schedules(name,kind,payload,cron,priority,max_attempts,next_run_at,idempotency_key) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *",
            (name, kind, Jsonb(payload), cron, priority, max_attempts, due, key)).fetchone()
        if row:
            return row, True
        return conn.execute("SELECT * FROM schedules WHERE idempotency_key=%s", (key,)).fetchone(), False


def list_schedules(conn, limit=100):
    rows = conn.execute("SELECT * FROM schedules ORDER BY id DESC LIMIT %s", (limit + 1,)).fetchall()
    return {"schedules": rows[:limit], "limit": limit, "truncated": len(rows) > limit}


def set_enabled(conn, schedule_id, enabled):
    with conn.transaction():
        row = conn.execute("SELECT * FROM schedules WHERE id=%s FOR UPDATE", (schedule_id,)).fetchone()
        if row is None:
            return None
        if enabled and not row["enabled"]:
            now = conn.execute("SELECT now() AS n").fetchone()["n"]
            due = next_run(row["cron"], now)
            return conn.execute("UPDATE schedules SET enabled=true,next_run_at=%s WHERE id=%s RETURNING *",
                                (due, schedule_id)).fetchone()
        if not enabled and row["enabled"]:
            return conn.execute("UPDATE schedules SET enabled=false WHERE id=%s RETURNING *",
                                (schedule_id,)).fetchone()
        return row


def dispatch_due(conn, limit=10):
    dispatched = 0
    with conn.transaction():
        rows = conn.execute(
            "SELECT *, now() AS db_now FROM schedules WHERE enabled AND next_run_at <= now() "
            "ORDER BY next_run_at,id LIMIT %s FOR UPDATE SKIP LOCKED", (limit,)).fetchall()
        for schedule in rows:
            due = schedule["next_run_at"]
            key = f"_leaseq_schedule/{schedule['id']}/{due.astimezone(timezone.utc).isoformat()}"
            job = conn.execute(
                f"INSERT INTO jobs(kind,payload,idempotency_key,max_attempts,priority,run_after,available_at) "
                f"VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(idempotency_key) DO NOTHING RETURNING {PUBLIC}",
                (schedule["kind"], Jsonb(schedule["payload"]), key, schedule["max_attempts"],
                 schedule["priority"], due, due)).fetchone()
            if job:
                _event(conn, job["id"], "enqueued", 0, detail={"schedule_id": schedule["id"]})
                dispatched += 1
            next_due = next_run(schedule["cron"], schedule["db_now"])
            conn.execute("UPDATE schedules SET next_run_at=%s WHERE id=%s",
                         (next_due, schedule["id"]))
    return dispatched
