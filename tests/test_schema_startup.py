"""Applying the schema on start must never queue queue writes behind it.

`CREATE INDEX IF NOT EXISTS` asks for a SHARE lock on the table before it looks
at whether the index exists. With any write transaction open on `jobs`, that
request waits, and every later writer then waits behind the request: one API
start stalled an unrelated single-row UPDATE for 4.07 s at 520k jobs.
"""
import threading
import time

import psycopg

from leaseq import db

INDEXES = ("jobs_unfinished", "job_events_job", "effects_job")
TRIGGERS = ("job_events_no_update_delete", "job_events_no_truncate")


def _seed_two_jobs(conn):
    conn.execute("INSERT INTO jobs (kind, idempotency_key) VALUES ('a', 'k1'), ('b', 'k2')")


def test_start_does_not_stall_writers_behind_an_open_transaction(db_url, conn):
    _seed_two_jobs(conn)
    holder = psycopg.connect(db_url)                 # not autocommit: a transaction stays open
    holder.execute("UPDATE jobs SET updated_at = now() WHERE idempotency_key = 'k1'")
    done, errors = threading.Event(), []

    def start():
        try:
            with db.connect(db_url) as c:
                db.apply_schema(c)
        except Exception as exc:  # noqa: BLE001  reported below
            errors.append(exc)
        finally:
            done.set()

    t0 = time.monotonic()
    thread = threading.Thread(target=start, daemon=True)
    thread.start()
    try:
        time.sleep(0.3)                              # let apply_schema reach its DDL
        with db.connect(db_url) as other:
            other.execute("SET lock_timeout = '1s'")
            # An unrelated row. On the old schema this waits behind the queued
            # SHARE lock request and fails with "canceling statement due to lock timeout".
            other.execute("UPDATE jobs SET updated_at = now() WHERE idempotency_key = 'k2'")
        assert done.wait(1.5), "apply_schema waited on the open write transaction"
        assert not errors, errors
        assert time.monotonic() - t0 < 2.0
    finally:
        holder.rollback()
        holder.close()
        thread.join(10)


def test_two_concurrent_starts_on_a_fresh_database_both_succeed(db_url):
    with db.connect(db_url) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    barrier, errors = threading.Barrier(2), []

    def start():
        try:
            with db.connect(db_url) as c:
                barrier.wait(5)
                db.apply_schema(c)
        except Exception as exc:  # noqa: BLE001  collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=start) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert not errors, errors
    with db.connect(db_url) as c:
        for name in INDEXES:
            assert c.execute("SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' "
                             "AND indexname = %s", (name,)).fetchone()["n"] == 1, name
        for name in TRIGGERS:
            assert c.execute("SELECT count(*) AS n FROM pg_trigger WHERE tgname = %s",
                             (name,)).fetchone()["n"] == 1, name
        # Exactly the expected set: nothing created twice under another name.
        names = {r["indexname"] for r in c.execute(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
            "AND indexname NOT LIKE '%%_pkey' AND indexname NOT LIKE '%%_key'").fetchall()}
        assert names == set(INDEXES)


def test_ddl_that_must_wait_fails_start_with_a_clear_error(db_url, conn, monkeypatch):
    """Startup DDL that still needs a table lock (here: re-creating a missing
    trigger) gives up after the lock timeout instead of stalling every writer."""
    monkeypatch.setattr(db, "SCHEMA_LOCK_TIMEOUT", "300ms")
    conn.execute("DROP TRIGGER job_events_no_truncate ON job_events")
    _seed_two_jobs(conn)
    writer = psycopg.connect(db_url)                     # an open writer on job_events
    writer.execute("INSERT INTO job_events (job_id, event, attempt) "
                   "SELECT id, 'enqueued', 0 FROM jobs WHERE idempotency_key = 'k1'")
    outcome = []

    def start():
        try:
            with db.connect(db_url) as c:
                db.apply_schema(c)
            outcome.append(None)
        except Exception as exc:  # noqa: BLE001  collected and asserted below
            outcome.append(exc)

    thread = threading.Thread(target=start, daemon=True)
    try:
        thread.start()
        thread.join(3)                                   # without a lock_timeout it would wait forever
        stalled = thread.is_alive()
    finally:
        writer.rollback()
        writer.close()
        thread.join(10)
    assert not stalled, "apply_schema waited on the open transaction instead of timing out"
    assert isinstance(outcome[0], db.SchemaLockTimeout), outcome
    assert "lock_timeout=300ms" in str(outcome[0]) and "another transaction" in str(outcome[0])
    with db.connect(db_url) as c:                        # once the writer is gone it applies
        db.apply_schema(c)
        assert c.execute("SELECT count(*) AS n FROM pg_trigger "
                         "WHERE tgname = 'job_events_no_truncate'").fetchone()["n"] == 1
