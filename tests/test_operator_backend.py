"""Contract coverage for the backend operator additions; all DB cases use PostgreSQL."""
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest

from leaseq import db, queue, scheduling, worker
from psycopg.types.json import Jsonb


def test_enqueue_priority_server_time_and_duplicate_key_stability(client, submit, claim, conn):
    low = submit("low", priority=-4)
    first = submit("high-a", priority=8)
    second = submit("high-b", priority=8)
    delayed = client.post("/jobs", headers={"Idempotency-Key": "later"},
                          json={"kind": "noop", "delay_seconds": 3600})
    assert delayed.status_code == 201
    due = delayed.json()["available_at"]
    again = client.post("/jobs", headers={"Idempotency-Key": "high-a"},
                        json={"kind": "other", "priority": -100})
    assert again.status_code == 200
    assert again.json()["id"] == first["id"]
    assert again.json()["priority"] == 8
    assert [claim()["id"] for _ in range(3)] == [first["id"], second["id"], low["id"]]
    assert claim() is None
    assert datetime.fromisoformat(due).replace(tzinfo=timezone.utc) > conn.execute(
        "SELECT now() AS n").fetchone()["n"]
    assert client.post("/jobs", headers={"Idempotency-Key": "bad-time"}, json={
        "kind": "noop", "run_after": "2026-01-01T00:00:00"}).status_code == 422
    assert client.post("/jobs", headers={"Idempotency-Key": "both"}, json={
        "kind": "noop", "run_after": "2026-01-01T00:00:00Z", "delay_seconds": 1}).status_code == 422
    assert client.post("/jobs", headers={"Idempotency-Key": "_leaseq_schedule/x"},
                       json={"kind": "noop"}).status_code == 422


def test_kind_filtered_claims_observe_empty_polls_and_worker_heartbeats(client, submit):
    a, b = submit("kind-a", kind="alpha"), submit("kind-b", kind="beta")
    empty = client.post("/jobs/claim", json={"worker_id": "alpha-worker", "kinds": ["alpha"]})
    assert empty.status_code == 200 and empty.json()["id"] == a["id"]
    empty_poll = client.post("/jobs/claim", json={"worker_id": "idle-worker", "kinds": ["beta"]})
    assert empty_poll.status_code == 200 and empty_poll.json()["id"] == b["id"]
    job = empty.json()
    assert client.post(f"/jobs/{job['id']}/heartbeat", json={"lease_token": job["lease_token"]}).status_code == 200
    listing = client.get("/workers?limit=100").json()["workers"]
    alpha = next(row for row in listing if row["worker_id"] == "alpha-worker")
    assert alpha["kinds"] == ["alpha"] and alpha["active_jobs"] == 1
    assert alpha["last_seen_at"] and alpha["last_heartbeat_at"]
    assert client.post("/jobs/claim", json={"worker_id": "w", "kinds": ["bad kind"]}).status_code == 422
    assert client.post("/jobs/claim", json={"worker_id": "empty-poller", "kinds": ["noop"]}).status_code == 204
    observed = client.get("/workers?limit=1").json()
    assert observed["truncated"] is True
    idle = client.get("/workers?limit=100").json()["workers"]
    idle = next(row for row in idle if row["worker_id"] == "empty-poller")
    assert idle["active_jobs"] == 0 and idle["last_heartbeat_at"] is None


def test_unknown_handler_fails_closed():
    with pytest.raises(worker.PermanentJobError, match="no handler"):
        worker.handle({"id": 1, "kind": "email", "payload": {}, "attempts": 1}, None, 30)


def test_bulk_actions_partial_conflict_and_auth(client, submit, conn):
    queued = submit("bulk-q")["id"]
    leased = submit("bulk-l")["id"]
    dead = submit("bulk-d")["id"]
    current = client.post("/jobs/claim", json={"worker_id": "w", "kinds": ["noop"]}).json()
    assert current["id"] == queued
    queue.cancel(conn, dead)
    assert client.post("/jobs/bulk", headers={"Authorization": ""},
                       json={"action": "cancel", "job_ids": [leased]}).status_code == 401
    response = client.post("/jobs/bulk", json={"action": "cancel", "job_ids": [current["id"], dead, 999999]})
    assert response.status_code == 200
    body = response.json()
    assert [item["status"] for item in body["results"]] == ["changed", "conflict", "not_found"]
    assert (body["processed"], body["remaining"]) == (3, 0)
    assert client.post("/jobs/bulk", json={"action": "cancel", "job_ids": [leased, leased]}).status_code == 422
    assert "error" not in response.text.lower()


def test_metrics_window_cache_and_wait_nulls(client, submit, claim):
    submit("metric")
    job = claim()
    assert client.post(f"/jobs/{job['id']}/complete", json={"lease_token": job["lease_token"]}).status_code == 200
    metrics = client.get("/operations/metrics").json()
    assert metrics["window_seconds"] == 900 and metrics["sample_limit"] == 5000
    assert len(metrics["buckets"]) == 15
    assert metrics["wait_ms"]["samples"] >= 1 and metrics["wait_ms"]["p50"] is not None
    assert client.get("/operations/metrics").json() == metrics


def test_metrics_sample_cap_and_unknown_historical_wait(client, conn):
    job_id = conn.execute("INSERT INTO jobs(kind,idempotency_key) VALUES ('old','metrics-old') RETURNING id").fetchone()["id"]
    conn.execute("INSERT INTO job_events(job_id,event,attempt,created_at) "
                 "SELECT %s,'completed',1,now() - make_interval(secs => i / 1000.0) "
                 "FROM generate_series(1,5001) i", (job_id,))
    result = client.get("/operations/metrics").json()
    assert result["truncated"] is True
    assert sum(row["completed"] for row in result["buckets"]) == 5000
    assert result["wait_ms"] == {"p50": None, "p95": None, "samples": 0}


def test_cron_is_numeric_utc_and_bounded():
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert scheduling.next_run("0 0 * * *", base) == datetime(2026, 1, 2, tzinfo=timezone.utc)
    for value in ("@daily", "0 0 * * * 2027", "H * * * *", "0 0 ? * *", "0 0 31 2 *"):
        with pytest.raises(ValueError):
            scheduling.next_run(value, base)


def test_schedule_idempotency_and_coalesced_dispatch(client, conn):
    body = {"name": "daily", "kind": "noop", "payload": {"x": 1}, "cron": "0 0 * * *",
            "priority": 5, "max_attempts": 2}
    a = client.post("/schedules", headers={"Idempotency-Key": "schedule-a"}, json=body)
    b = client.post("/schedules", headers={"Idempotency-Key": "schedule-a"}, json={**body, "priority": -5})
    assert (a.status_code, b.status_code) == (201, 200)
    assert a.json()["id"] == b.json()["id"] and b.json()["priority"] == 5
    sid = a.json()["id"]
    conn.execute("UPDATE schedules SET next_run_at=now()-interval '3 days' WHERE id=%s", (sid,))
    assert scheduling.dispatch_due(conn, 10) == 1
    assert scheduling.dispatch_due(conn, 10) == 0
    jobs = conn.execute("SELECT * FROM jobs WHERE idempotency_key LIKE '_leaseq_schedule/%'").fetchall()
    assert len(jobs) == 1 and jobs[0]["priority"] == 5
    assert conn.execute("SELECT next_run_at > now() AS future FROM schedules WHERE id=%s",
                        (sid,)).fetchone()["future"]
    assert client.patch(f"/schedules/{sid}", json={"enabled": False}).json()["enabled"] is False
    resumed = client.patch(f"/schedules/{sid}", json={"enabled": True}).json()
    assert resumed["enabled"] is True and resumed["next_run_at"] > datetime.now(timezone.utc).isoformat()


def test_two_dispatchers_cannot_duplicate_a_slot(client, conn):
    created = client.post("/schedules", headers={"Idempotency-Key": "schedule-race"}, json={
        "name": "race", "kind": "noop", "payload": {}, "cron": "* * * * *"}).json()
    conn.execute("UPDATE schedules SET next_run_at=now()-interval '1 minute' WHERE id=%s", (created["id"],))
    barrier = threading.Barrier(2)

    def dispatch(_):
        with db.connect() as other:
            barrier.wait()
            return scheduling.dispatch_due(other, 10)

    with ThreadPoolExecutor(2) as pool:
        list(pool.map(dispatch, range(2)))
    assert conn.execute("SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE '_leaseq_schedule/%'").fetchone()["n"] == 1


def test_scheduler_caps_each_tick_at_ten(conn):
    conn.cursor().executemany(
        "INSERT INTO schedules(name,kind,payload,cron,priority,max_attempts,next_run_at,idempotency_key) "
        "VALUES ('batch','noop',%s,'* * * * *',0,2,now()-interval '1 hour',%s)",
        [(Jsonb({}), f"batch-{i}") for i in range(11)])
    assert scheduling.dispatch_due(conn, 10) == 10
    assert conn.execute("SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE '_leaseq_schedule/%'").fetchone()["n"] == 10
    assert scheduling.dispatch_due(conn, 10) == 1


def test_schedule_state_survives_api_process_restart(db_url, monkeypatch):
    monkeypatch.setenv("LEASEQ_API_TOKEN", "restart-test-token-0123456789")
    import harness
    import httpx
    first, base = harness.start_api(db_url)
    try:
        created = httpx.post(base + "/schedules", headers={
            **harness.auth_headers(), "Idempotency-Key": "restart-schedule"}, json={
                "name": "restart", "kind": "noop", "payload": {"saved": True},
                "cron": "0 0 * * *", "priority": 7, "max_attempts": 3}, timeout=10)
        assert created.status_code == 201
        expected = created.json()
    finally:
        first.terminate()
        first.wait(timeout=10)
    second, base = harness.start_api(db_url)
    try:
        saved = httpx.get(base + "/schedules", headers=harness.auth_headers(), timeout=10).json()["schedules"]
        restored = next(row for row in saved if row["id"] == expected["id"])
        assert (restored["next_run_at"], restored["enabled"], restored["priority"]) == (
            expected["next_run_at"], True, 7)
    finally:
        second.terminate()
        second.wait(timeout=10)
