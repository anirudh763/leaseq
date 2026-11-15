"""Real PostgreSQL and original-process recovery checks for the disposable lab."""

import os
import time
import asyncio
from urllib.parse import urlsplit

import psycopg
from psycopg.conninfo import conninfo_to_dict
import pytest
from fastapi.testclient import TestClient

from leaseq.sandbox_runtime import SandboxManager
from leaseq.sandbox import create_app


class SecretDSN(str):
    def __repr__(self):
        return "<sandbox admin DSN redacted>"


@pytest.fixture
def admin_url():
    url = os.environ.get("LEASEQ_SANDBOX_ADMIN_URL") or os.environ.get(
        "LEASEQ_DATABASE_URL"
    )
    if not url:
        pytest.skip("real sandbox PostgreSQL URL not configured")
    if urlsplit(url).path.lstrip("/").split("?", 1)[0] != "leaseq_sandbox_admin":
        pytest.fail("sandbox tests require the isolated leaseq_sandbox_admin database")
    with psycopg.connect(url, autocommit=True) as conn:
        assert conn.execute("SELECT 1").fetchone()
    return SecretDSN(url)


def test_real_four_worker_batch_sigkill_idempotency_and_owned_cleanup(admin_url):
    manager = SandboxManager(admin_url)
    with TestClient(create_app(manager), base_url="http://127.0.0.1") as client:
        created = client.post(
            "/sandbox/runs",
            headers={"Origin": "http://127.0.0.1", "X-LeaseQ-Sandbox": "1"},
        )
        assert created.status_code == 200, created.text
        info = created.json()
        rid, cap = info["run_id"], info["capability"]
        headers = {
            "Authorization": f"Bearer {cap}",
            "Origin": "http://127.0.0.1",
            "X-LeaseQ-Sandbox": "1",
        }
        assert client.get(f"/sandbox/runs/{rid}").status_code == 401
        snapshot = client.get(f"/sandbox/runs/{rid}", headers=headers).json()
        assert len(snapshot["workers"]) == 4
        assert sum(snapshot["counts"].values()) == 15
        assert "capability" not in snapshot and "payload" not in str(snapshot)
        with manager._run_db(manager.current) as conn:
            assert (
                conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"]
                == "5s"
            )
        dup = client.post(f"/sandbox/runs/{rid}/duplicate", headers=headers)
        assert dup.status_code == 200, dup.text
        assert dup.json()["original_job_id"] == dup.json()["existing_job_id"]
        assert dup.json()["created"] is False
        batch = client.post(f"/sandbox/runs/{rid}/batch", headers=headers)
        assert batch.status_code == 200 and batch.json()["created"] == 32
        for _ in range(2):
            assert (
                client.post(f"/sandbox/runs/{rid}/batch", headers=headers).status_code
                == 200
            )
        assert (
            client.post(f"/sandbox/runs/{rid}/batch", headers=headers).status_code
            == 409
        )
        # The first stalled attempt outlives its PostgreSQL lease. A replacement
        # completes under the newer token; the original process then records a
        # rejected late completion. The poison fixture also reaches the real DLQ.
        proof_deadline = time.monotonic() + 25
        proof = None
        while time.monotonic() < proof_deadline:
            proof = client.get(f"/sandbox/runs/{rid}", headers=headers).json()
            if (
                proof["evidence"]["stale_completion"] == "pass"
                and proof["evidence"]["poison_dlq"] == "pass"
            ):
                break
            time.sleep(0.25)
        assert proof["evidence"]["lease_recovery"] == "pass"
        assert proof["evidence"]["stale_completion"] == "pass"
        assert proof["evidence"]["poison_dlq"] == "pass"
        assert len(proof["workers"]) == 4
        assert all(worker["status"] == "running" for worker in proof["workers"])
        with manager._run_db(manager.current) as conn:
            stalled = conn.execute(
                "SELECT state,attempts,(SELECT count(*) FROM effects WHERE job_id=jobs.id) effects FROM jobs WHERE idempotency_key=%s",
                (f"{rid}:stalled",),
            ).fetchone()
            stalled_events = conn.execute(
                "SELECT event,detail->>'op' op FROM job_events WHERE job_id=(SELECT id FROM jobs WHERE idempotency_key=%s) ORDER BY id",
                (f"{rid}:stalled",),
            ).fetchall()
            poison = conn.execute(
                "SELECT state,attempts,(SELECT count(*) FROM effects WHERE job_id=jobs.id) effects FROM jobs WHERE idempotency_key=%s",
                (f"{rid}:poison",),
            ).fetchone()
        assert stalled == {"state": "done", "attempts": 2, "effects": 1}
        assert (
            sum(
                e["event"] == "rejected" and e["op"] == "complete"
                for e in stalled_events
            )
            == 1
        )
        assert sum(e["event"] == "completed" for e in stalled_events) == 1
        assert poison == {"state": "dead", "attempts": 2, "effects": 0}
        # Wait until the deliberately un-heartbeated first lease is visible, then kill its registered owner.
        deadline = time.monotonic() + 10
        killed = None
        while time.monotonic() < deadline:
            response = client.post(f"/sandbox/runs/{rid}/kill", headers=headers)
            if response.status_code == 200:
                killed = response.json()
                break
            time.sleep(0.1)
        assert killed is not None, "no actual registered leased process was SIGKILLed"
        assert manager.current.killed_children[-1]["worker_id"] == killed["worker_id"]
        assert manager.current.killed_children[-1]["returncode"] == -9
        assert manager.current.workers[killed["worker_id"]].generation == 2
        assert manager.current.workers[killed["worker_id"]].process.poll() is None
        assert len(manager.current.workers) == 4
        # The exact job whose registered owner received SIGKILL is reclaimed by
        # PostgreSQL, completes through the original worker, and commits one effect.
        deadline = time.monotonic() + 20
        recovered = None
        while time.monotonic() < deadline:
            with manager._run_db(manager.current) as conn:
                recovered = conn.execute(
                    "SELECT state,attempts,(SELECT count(*) FROM effects WHERE job_id=jobs.id) effects FROM jobs WHERE id=%s",
                    (killed["job_id"],),
                ).fetchone()
            if recovered["state"] == "done" and recovered["attempts"] >= 2:
                break
            time.sleep(0.2)
        assert recovered == {"state": "done", "attempts": 2, "effects": 1}

        # Exercise lease expiry using PostgreSQL's own clock and the original
        # queue API. Freeze only this run's registered workers after their
        # recovery proof, then park other rows in this disposable DB so the
        # selected claim is deterministic. No client timestamp enters the claim.
        registered_processes = [
            child.process for child in manager.current.workers.values()
        ] + [manager.current.api_process]
        for child in manager.current.workers.values():
            manager._stop(child.process)
        with manager._run_db(manager.current) as conn:
            conn.execute(
                "UPDATE jobs SET run_after=now()+interval '1 day' WHERE state='queued'"
            )
            conn.execute(
                "UPDATE jobs SET lease_expires_at=now()+interval '1 day' WHERE state='leased'"
            )
        import httpx

        private_headers = {"Authorization": f"Bearer {manager.current.token}"}
        with httpx.Client(
            base_url=manager.current.api_url, headers=private_headers, timeout=5
        ) as core:
            submitted = core.post(
                "/jobs",
                json={
                    "kind": "word_count",
                    "payload": {"text": "database clock"},
                    "max_attempts": 3,
                },
                headers={"Idempotency-Key": f"{rid}:clock-check"},
            )
            assert submitted.status_code == 201
            clock_job = submitted.json()["id"]
            first = core.post(
                "/jobs/claim",
                json={"worker_id": f"{rid}-clock-skewed", "lease_seconds": 60},
            ).json()
            assert first["id"] == clock_job
            with manager._run_db(manager.current) as conn:
                conn.execute(
                    "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=%s",
                    (clock_job,),
                )
            second = core.post(
                "/jobs/claim",
                json={"worker_id": f"{rid}-database-clock", "lease_seconds": 60},
            ).json()
            assert second["id"] == clock_job and second["attempts"] == 2
            stale = core.post(
                f"/jobs/{clock_job}/complete",
                json={"lease_token": first["lease_token"], "result": {"ok": True}},
            )
            assert stale.status_code == 409
            with manager._run_db(manager.current) as conn:
                events = conn.execute(
                    "SELECT detail->>'op' op FROM job_events WHERE job_id=%s AND event='rejected'",
                    (clock_job,),
                ).fetchall()
            assert events == [{"op": "complete"}]
        dbname = manager.current.database
        # Real original queue state and audit rows are observable in a coherent read snapshot.
        snapshot = client.get(f"/sandbox/runs/{rid}", headers=headers).json()
        assert (
            snapshot["observed_at"] and snapshot["evidence"]["snapshot"] == "observed"
        )
        assert sum(snapshot["counts"].values()) <= 128
        child_processes = registered_processes
        assert len([p for p in child_processes if p.poll() is None]) == 1
        # Exhaust the mutation quota. A wrong capability remains throttled;
        # the exact current run owner retains the narrowly reserved cleanup.
        limited = None
        for _ in range(12):
            limited = client.post(f"/sandbox/runs/{rid}/batch", headers=headers)
            if limited.status_code == 429:
                break
        assert limited.status_code == 429
        assert 1 <= int(limited.headers["Retry-After"]) <= 60
        wrong_cap = {**headers, "Authorization": "Bearer wrong-capability"}
        assert (
            client.delete(f"/sandbox/runs/{rid}", headers=wrong_cap).status_code == 429
        )
        assert client.delete(f"/sandbox/runs/{rid}", headers=headers).status_code == 204
        assert manager.current is None
        assert all(p.poll() is not None for p in child_processes)
        with psycopg.connect(admin_url, autocommit=True) as conn:
            assert (
                conn.execute(
                    "SELECT 1 FROM pg_database WHERE datname=%s", (dbname,)
                ).fetchone()
                is None
            )


def test_database_url_query_cannot_redirect_run_database_or_authority():
    # Reproduce libpq's precedence: URI query dbname overrides the URI path.
    malicious = "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?dbname=private_queue"
    manager = SandboxManager(malicious)
    assert conninfo_to_dict(manager.admin_url)["dbname"] == "leaseq_sandbox_admin"
    run_dsn = SandboxManager._bounded_url(
        SandboxManager._for_db(manager.admin_url, "leaseq_sandbox_deadbeefdeadbeef")
    )
    parsed = conninfo_to_dict(run_dsn)
    assert parsed["dbname"] == "leaseq_sandbox_deadbeefdeadbeef"
    assert parsed["host"] == "127.0.0.1" and parsed["port"] == "55444"
    assert parsed["connect_timeout"] == "3"
    assert parsed["options"] == "-c statement_timeout=5000"


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?host=203.0.113.9",
        "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?port=5432",
        "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?options=-c%20statement_timeout%3D0",
        "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?service=private",
        "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?passfile=/unread/passfile",
        "dbname=leaseq_sandbox_admin host=127.0.0.1 port=55444 user=test password=test service=private",
        "dbname=leaseq_sandbox_admin host=127.0.0.1 port=55444 user=test password=test passfile=/unread/passfile",
        "dbname=leaseq_sandbox_admin host=127.0.0.1 port=55444 user=test password=test options='-c statement_timeout=0'",
    ],
)
def test_admin_dsn_rejects_ambiguous_authority_service_and_timeout_overrides(dsn):
    with pytest.raises(ValueError):
        SandboxManager(dsn)


def test_admin_constructor_rejects_wrong_canonical_database_and_non_loopback_host():
    with pytest.raises(ValueError):
        SandboxManager("postgresql://user:pass@127.0.0.1:55444/private_queue")
    with pytest.raises(ValueError):
        SandboxManager(
            "postgresql://user:pass@example.invalid:55444/leaseq_sandbox_admin"
        )


def test_environment_loader_canonicalizes_query_database_and_rejects_libpq_file_selectors(
    monkeypatch,
):
    malicious = "postgresql://user:pass@127.0.0.1:55444/leaseq_sandbox_admin?dbname=private_queue"
    monkeypatch.setenv("LEASEQ_SANDBOX_ADMIN_URL", malicious)
    manager = SandboxManager.from_env()
    assert conninfo_to_dict(manager.admin_url)["dbname"] == "leaseq_sandbox_admin"
    monkeypatch.setenv("PGSERVICE", "never-read-this-service")
    with pytest.raises(RuntimeError):
        SandboxManager.from_env()


def test_fixed_docker_postgres_service_dsn_is_accepted():
    manager = SandboxManager(
        "postgresql://lab:secret@postgres:5432/leaseq_sandbox_admin"
    )
    canonical = conninfo_to_dict(manager.admin_url)
    assert canonical["dbname"] == "leaseq_sandbox_admin"
    assert canonical["host"] == "postgres" and canonical["port"] == "5432"


def test_startup_cancellation_reaps_only_created_run_resources(admin_url, monkeypatch):
    manager = SandboxManager(admin_url)
    started = asyncio.Event()
    run_box = {}

    async def pause_after_api_spawn(run):
        run_box["run"] = run
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(manager, "_wait_api", pause_after_api_spawn)

    async def cancel_creation():
        task = asyncio.create_task(manager.create())
        await started.wait()
        run = run_box["run"]
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        cleaned_by_create = (
            manager.current is None and run.api_process.poll() is not None
        )
        with psycopg.connect(admin_url, autocommit=True) as conn:
            db_dropped_by_create = (
                conn.execute(
                    "SELECT 1 FROM pg_database WHERE datname=%s", (run.database,)
                ).fetchone()
                is None
            )
        try:
            return run, cleaned_by_create, db_dropped_by_create
        finally:
            if manager.current:
                await manager.shutdown()

    run, cleaned_by_create, db_dropped_by_create = asyncio.run(cancel_creation())
    assert cleaned_by_create is True
    assert db_dropped_by_create is True
    assert run.closed is True
    assert manager.current is None
