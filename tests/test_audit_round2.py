"""Defects from the second audit. Each test failed on main 5a63059."""
import threading
import time

import psycopg
import pytest

from leaseq import db, queue


def nested(depth: int) -> str:
    """A JSON object nested `depth` levels deep, as raw text: {"a":{"a":...1...}}"""
    return '{"a":' * (depth - 1) + '{"a":1}' + "}" * (depth - 1)


def jobs_count(conn) -> int:
    return conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"]


# --- 1. deeply nested JSON is refused before any database work ---------------

def test_deeply_nested_payload_is_a_422_and_writes_nothing(client, conn):
    body = '{"kind": "noop", "payload": ' + nested(1000) + "}"
    r = client.post("/jobs", content=body.encode(),
                    headers={"Idempotency-Key": "deep", "Content-Type": "application/json"})
    assert r.status_code == 422, r.text
    assert "nested" in r.text
    assert jobs_count(conn) == 0


def test_nested_payload_at_the_limit_is_accepted(client, conn):
    body = '{"kind": "noop", "payload": ' + nested(64) + "}"
    r = client.post("/jobs", content=body.encode(),
                    headers={"Idempotency-Key": "ok", "Content-Type": "application/json"})
    assert r.status_code == 201, r.text
    assert client.get(f"/jobs/{r.json()['id']}").status_code == 200
    too_deep = '{"kind": "noop", "payload": ' + nested(65) + "}"
    r = client.post("/jobs", content=too_deep.encode(),
                    headers={"Idempotency-Key": "no", "Content-Type": "application/json"})
    assert r.status_code == 422
    assert jobs_count(conn) == 1


def test_deeply_nested_lists_count_too(client, conn):
    body = '{"kind": "noop", "payload": {"x": ' + "[" * 1000 + "]" * 1000 + "}}"
    r = client.post("/jobs", content=body.encode(),
                    headers={"Idempotency-Key": "list", "Content-Type": "application/json"})
    assert r.status_code == 422
    assert jobs_count(conn) == 0


def test_deeply_nested_result_is_a_422_and_the_job_stays_leased(client, submit, claim, conn):
    job_id = submit("a")["id"]
    job = claim()
    body = '{"lease_token": "' + job["lease_token"] + '", "result": ' + nested(1000) + "}"
    r = client.post(f"/jobs/{job_id}/complete", content=body.encode(),
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 422, r.text
    row = conn.execute("SELECT state, result FROM jobs WHERE id = %s", (job_id,)).fetchone()
    assert (row["state"], row["result"]) == ("leased", None)
    assert client.get(f"/jobs/{job_id}").status_code == 200


# --- 2. applying the schema on start does not stall queue writes ----------------

def test_apply_schema_does_not_block_job_event_writes(db_url, conn):
    job_id = queue.enqueue(conn, "noop", {}, "lock")[0]["id"]
    done = threading.Event()
    errors = []

    def start_api():               # what every API start does
        try:
            with db.connect(db_url) as c:
                db.apply_schema(c)
        except Exception as exc:   # pragma: no cover - reported below
            errors.append(exc)
        finally:
            done.set()

    with db.connect(db_url) as reader, db.connect(db_url) as writer:
        with reader.transaction():                     # a dashboard read, still open
            reader.execute("SELECT count(*) FROM job_events").fetchone()
            t = threading.Thread(target=start_api)
            t.start()
            time.sleep(0.5)                            # let apply_schema queue its locks
            writer.execute("SET lock_timeout = '1s'")
            try:
                with writer.transaction():
                    queue._event(writer, job_id, "enqueued", 0)
            except psycopg.errors.LockNotAvailable:
                pytest.fail("a job_events INSERT waited on apply_schema's lock")
        t.join(timeout=10)
    assert done.is_set() and errors == []


def _triggers(conn):
    return sorted(r["tgname"] for r in conn.execute(
        "SELECT tgname FROM pg_trigger WHERE tgrelid = 'job_events'::regclass "
        "AND NOT tgisinternal"))


def test_fresh_database_gets_both_triggers_and_reapplying_is_a_no_op(db_url, conn):
    expected = ["job_events_no_truncate", "job_events_no_update_delete"]
    assert _triggers(conn) == expected                  # db_url applied the schema once
    oids = conn.execute("SELECT oid FROM pg_trigger WHERE tgrelid = 'job_events'::regclass "
                        "AND NOT tgisinternal ORDER BY tgname").fetchall()
    db.apply_schema(conn)
    db.apply_schema(conn)
    assert _triggers(conn) == expected
    again = conn.execute("SELECT oid FROM pg_trigger WHERE tgrelid = 'job_events'::regclass "
                         "AND NOT tgisinternal ORDER BY tgname").fetchall()
    assert again == oids                                # not dropped and recreated
    queue.enqueue(conn, "noop", {}, "t")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        conn.execute("DELETE FROM job_events")


# --- 3. backoff does not overflow -------------------------------------------------

def test_backoff_is_capped_for_any_attempt_count(monkeypatch):
    monkeypatch.setattr(queue, "BACKOFF_BASE", 2.0)
    monkeypatch.setattr(queue, "BACKOFF_CAP", 300.0)
    for attempts in (1025, 2000, 10**6):
        assert queue.backoff_seconds(attempts) == 300.0
    assert queue.backoff_seconds(1) == 2.0
    assert queue.backoff_seconds(8) == 256.0
