"""One section per rule of the API. Every test runs against real PostgreSQL."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import psycopg
import pytest

from leaseq import db, queue, worker


def events(conn, job_id):
    return [r["event"] for r in conn.execute(
        "SELECT event FROM job_events WHERE job_id = %s ORDER BY id", (job_id,))]


def count(conn, table):
    return conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]


# --- idempotent submission -------------------------------------------------

def test_same_idempotency_key_returns_same_job(client, conn):
    a = client.post("/jobs", headers={"Idempotency-Key": "k1"}, json={"kind": "email"})
    b = client.post("/jobs", headers={"Idempotency-Key": "k1"}, json={"kind": "email"})
    assert (a.status_code, b.status_code) == (201, 200)
    assert a.json()["id"] == b.json()["id"]
    assert count(conn, "jobs") == 1
    assert events(conn, a.json()["id"]) == ["enqueued"]


def test_idempotency_key_header_is_required(client):
    assert client.post("/jobs", json={"kind": "email"}).status_code == 422


def test_concurrent_duplicate_submissions_create_one_row(client, conn):
    start = threading.Barrier(16)

    def post(_):
        start.wait()
        r = client.post("/jobs", headers={"Idempotency-Key": "dup"}, json={"kind": "email"})
        return r.status_code, r.json()["id"]

    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(post, range(16)))
    assert sorted(code for code, _ in results) == [200] * 15 + [201]
    assert len({job_id for _, job_id in results}) == 1
    assert count(conn, "jobs") == 1
    assert count(conn, "job_events") == 1


def test_concurrent_duplicate_enqueue_on_separate_connections(db_url, conn):
    """Same race without HTTP in the way: 8 connections, one key, released together."""
    start = threading.Barrier(8)

    def enqueue(_):
        with db.connect(db_url) as c:
            start.wait()
            job, created = queue.enqueue(c, "email", {}, "dup")
            return job["id"], created

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(enqueue, range(8)))
    assert len({job_id for job_id, _ in results}) == 1
    assert sum(created for _, created in results) == 1
    assert count(conn, "jobs") == 1


# --- claiming ----------------------------------------------------------------

def test_claim_returns_oldest_first_then_nothing(submit, claim):
    ids = [submit(f"k{i}")["id"] for i in range(3)]
    claimed = [claim() for _ in range(3)]
    assert [j["id"] for j in claimed] == ids
    assert all(j["state"] == "leased" and j["attempts"] == 1 for j in claimed)
    assert len({j["lease_token"] for j in claimed}) == 3
    assert claim() is None


def test_claim_skips_a_row_locked_by_another_transaction(db_url, conn, submit):
    first, second = submit("a")["id"], submit("b")["id"]
    with db.connect(db_url) as other, other.transaction():
        other.execute("SELECT id FROM jobs WHERE id = %s FOR UPDATE", (first,))
        conn.execute("SET lock_timeout = '2s'")    # without SKIP LOCKED: error, not a hang
        job = queue.claim(conn, "w1", 30)          # must not wait for `other`
        assert job["id"] == second


def test_concurrent_claims_never_hand_out_the_same_job(db_url, conn, submit):
    for i in range(40):
        submit(f"k{i}")
    start = threading.Barrier(8)

    def drain(n):
        got = []
        with db.connect(db_url) as c:
            start.wait()
            while (job := queue.claim(c, f"w{n}", 30)) is not None:
                got.append(job["id"])
        return got

    with ThreadPoolExecutor(8) as pool:
        claimed = [job_id for got in pool.map(drain, range(8)) for job_id in got]
    assert len(claimed) == 40 and len(set(claimed)) == 40


def test_get_job_does_not_reveal_the_lease_token(client, submit, claim):
    job_id = submit("a")["id"]
    assert "lease_token" in claim()
    body = client.get(f"/jobs/{job_id}").json()
    assert body["state"] == "leased" and "lease_token" not in body


# --- lease expiry and heartbeat ---------------------------------------------

def test_expired_lease_makes_the_job_claimable_again(submit, claim, conn):
    job_id = submit("a")["id"]
    first = claim("w1", lease=0.2)
    assert claim("w2") is None                 # lease still held
    time.sleep(0.3)
    second = claim("w2")
    assert second["id"] == job_id and second["attempts"] == 2
    assert second["leased_by"] == "w2"
    assert second["lease_token"] != first["lease_token"]
    assert events(conn, job_id) == ["enqueued", "claimed", "claimed"]


def test_heartbeat_extends_the_lease(client, submit, claim):
    submit("a")
    job = claim("w1", lease=0.2)
    r = client.post(f"/jobs/{job['id']}/heartbeat",
                    json={"lease_token": job["lease_token"], "lease_seconds": 30})
    assert r.status_code == 200
    time.sleep(0.3)
    assert claim("w2") is None


def test_heartbeat_with_wrong_token_is_rejected(client, submit, claim):
    submit("a")
    job = claim()
    r = client.post(f"/jobs/{job['id']}/heartbeat", json={"lease_token": "not-the-token"})
    assert r.status_code == 409


# --- fencing -----------------------------------------------------------------

def test_zombie_worker_cannot_complete_fail_or_heartbeat(client, submit, claim, conn):
    """Worker A's lease expires and the job is re-issued to B. A then wakes up."""
    job_id = submit("a")["id"]
    zombie = claim("A", lease=0.2)
    time.sleep(0.3)
    current = claim("B", lease=30)
    assert current["id"] == job_id

    old = {"lease_token": zombie["lease_token"]}
    assert client.post(f"/jobs/{job_id}/complete", json=old).status_code == 409
    assert client.post(f"/jobs/{job_id}/fail", json=old).status_code == 409
    assert client.post(f"/jobs/{job_id}/heartbeat", json=old).status_code == 409
    still = client.get(f"/jobs/{job_id}").json()
    assert (still["state"], still["leased_by"], still["attempts"]) == ("leased", "B", 2)

    r = client.post(f"/jobs/{job_id}/complete",
                    json={"lease_token": current["lease_token"], "result": {"ok": True}})
    assert r.status_code == 200 and r.json()["state"] == "done"
    assert r.json()["result"] == {"ok": True}
    # Replaying either token after completion changes nothing.
    assert client.post(f"/jobs/{job_id}/complete", json=old).status_code == 409
    assert client.post(f"/jobs/{job_id}/complete",
                       json={"lease_token": current["lease_token"]}).status_code == 409
    assert events(conn, job_id).count("completed") == 1
    assert events(conn, job_id) == ["enqueued", "claimed", "claimed", "rejected", "rejected",
                                    "completed", "rejected", "rejected"]


def test_expired_but_not_reissued_lease_can_still_complete(client, submit, claim):
    """The token is the fence, not the clock: nobody else took the job, so it is safe."""
    submit("a")
    job = claim("A", lease=0.1)
    time.sleep(0.2)
    r = client.post(f"/jobs/{job['id']}/complete", json={"lease_token": job["lease_token"]})
    assert r.status_code == 200


def test_worker_side_effect_is_written_only_with_the_current_token(conn, submit, claim):
    job_id = submit("a")["id"]
    zombie = claim("A", lease=0.2)
    time.sleep(0.3)
    current = claim("B")
    assert worker.finish(conn, zombie, {}, "A") is False
    assert count(conn, "effects") == 0
    assert worker.finish(conn, current, {}, "B") is True
    assert worker.finish(conn, current, {}, "B") is False      # replay
    rows = conn.execute("SELECT job_id, worker_id FROM effects").fetchall()
    assert rows == [{"job_id": job_id, "worker_id": "B"}]


def test_unknown_job_is_404(client):
    assert client.get("/jobs/999").status_code == 404
    assert client.post("/jobs/999/complete", json={"lease_token": "x"}).status_code == 404
    assert client.post("/jobs/999/fail", json={"lease_token": "x"}).status_code == 404
    assert client.post("/jobs/999/heartbeat", json={"lease_token": "x"}).status_code == 404


# --- retry, backoff, dead-letter ---------------------------------------------

def test_backoff_doubles_and_is_capped(monkeypatch):
    monkeypatch.setattr(queue, "BACKOFF_BASE", 2.0)
    monkeypatch.setattr(queue, "BACKOFF_CAP", 300.0)
    assert [queue.backoff_seconds(n) for n in (1, 2, 3, 4)] == [2, 4, 8, 16]
    assert queue.backoff_seconds(30) == 300


def test_failed_job_retries_with_backoff_then_goes_dead(client, submit, claim, conn):
    job_id = submit("a", max_attempts=3)["id"]        # BACKOFF_BASE is 0.2 s in tests

    def fail_once():
        job = claim()
        r = client.post(f"/jobs/{job_id}/fail",
                        json={"lease_token": job["lease_token"], "error": "boom"})
        assert r.status_code == 200
        return r.json()

    assert fail_once()["state"] == "queued"
    assert claim() is None                     # not due yet: backoff 0.2 s
    time.sleep(0.25)
    assert fail_once()["state"] == "queued"
    time.sleep(0.25)
    assert claim() is None                     # second backoff is 0.4 s
    time.sleep(0.2)
    dead = fail_once()
    assert (dead["state"], dead["attempts"]) == ("dead", 3)
    time.sleep(0.1)
    assert claim() is None                     # dead jobs are never handed out
    assert events(conn, job_id) == ["enqueued", "claimed", "failed", "claimed", "failed",
                                    "claimed", "dead"]
    delays = [r["d"] for r in conn.execute(
        "SELECT (detail->>'retry_in_seconds')::float AS d FROM job_events "
        "WHERE event = 'failed' ORDER BY id")]
    assert delays == [0.2, 0.4]


def test_lease_expiring_on_the_final_attempt_goes_dead(client, submit, claim, conn):
    job_id = submit("a", max_attempts=1)["id"]
    claim("w1", lease=0.1)
    time.sleep(0.2)
    assert claim("w2") is None
    assert client.get(f"/jobs/{job_id}").json()["state"] == "dead"
    assert events(conn, job_id) == ["enqueued", "claimed", "dead"]


# --- audit log ---------------------------------------------------------------

@pytest.mark.parametrize("statement", [
    "UPDATE job_events SET event = 'completed'",
    "DELETE FROM job_events",
    "TRUNCATE job_events",
])
def test_audit_log_rejects_update_delete_truncate(conn, submit, statement):
    submit("a")
    before = conn.execute("SELECT * FROM job_events").fetchall()
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
        conn.execute(statement)
    assert conn.execute("SELECT * FROM job_events").fetchall() == before


def test_every_state_change_writes_exactly_one_event(client, submit, claim, conn):
    job_id = submit("a")["id"]
    job = claim()
    client.post(f"/jobs/{job_id}/heartbeat", json={"lease_token": job["lease_token"]})
    client.post(f"/jobs/{job_id}/fail", json={"lease_token": job["lease_token"]})
    time.sleep(0.25)
    job = claim()
    client.post(f"/jobs/{job_id}/complete", json={"lease_token": job["lease_token"]})
    rows = conn.execute("SELECT event, attempt FROM job_events ORDER BY id").fetchall()
    assert [(r["event"], r["attempt"]) for r in rows] == [
        ("enqueued", 0), ("claimed", 1), ("failed", 1), ("claimed", 2), ("completed", 2)]


def test_event_is_in_the_same_transaction_as_the_change(conn):
    """Roll back the surrounding transaction: the job and its event vanish together."""
    with pytest.raises(RuntimeError), conn.transaction():
        queue.enqueue(conn, "email", {}, "k")
        assert count(conn, "jobs") == 1 and count(conn, "job_events") == 1
        raise RuntimeError("simulated crash before commit")
    assert count(conn, "jobs") == 0 and count(conn, "job_events") == 0


# --- stats -------------------------------------------------------------------

def test_stats_counts_by_state(client, submit, claim):
    for i in range(3):
        submit(f"k{i}")
    job = claim()
    client.post(f"/jobs/{job['id']}/complete", json={"lease_token": job["lease_token"]})
    claim()
    assert client.get("/stats").json() == {
        "queued": 1, "leased": 1, "done": 1, "dead": 0, "expired_leases": 0, "total": 3}
