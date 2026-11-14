from contextlib import contextmanager

import psycopg
import pytest
from psycopg_pool import PoolTimeout
from fastapi.testclient import TestClient

import harness
from leaseq.api import app


@pytest.fixture
def hosting_client(monkeypatch):
    url = harness.scratch_database("leaseq_hosting_test")
    monkeypatch.setenv("LEASEQ_DATABASE_URL", url)
    monkeypatch.setenv("LEASEQ_API_TOKEN", "hosting-fixture-token-0123456789")
    monkeypatch.delenv("LEASEQ_PUBLIC_READ", raising=False)
    with TestClient(app) as client:
        yield client


def test_health_probes_are_public_but_jobs_remain_private(hosting_client):
    for path in ["/livez", "/readyz", "/healthz"]:
        assert hosting_client.get(path).status_code == 200
    assert hosting_client.get("/jobs").status_code == 401
    assert hosting_client.get("/auth/check").status_code == 401
    assert hosting_client.get("/readyz/jobs").status_code == 401


@pytest.mark.parametrize("failure", [psycopg.OperationalError, PoolTimeout])
def test_database_outage_fails_readiness_without_failing_liveness(hosting_client, monkeypatch, failure):
    class DisconnectedPool:
        @contextmanager
        def connection(self, **kwargs):
            raise failure("private database connection details")
            yield

    with monkeypatch.context() as patch:
        patch.setattr(app.state, "pool", DisconnectedPool())
        assert hosting_client.get("/livez").status_code == 200
        response = hosting_client.get("/readyz")
        assert response.status_code == 503
        assert response.json() == {"ok": False}
        assert "private" not in response.text


def test_readiness_timeout_applies_inside_probe_and_resets_afterward(hosting_client, monkeypatch):
    pool = app.state.pool
    observed = {}

    class ProbeConnection:
        def __init__(self, conn):
            self.conn = conn

        def transaction(self):
            return self.conn.transaction()

        def execute(self, query, **kwargs):
            if query == "SELECT 1":
                observed["during"] = self.conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"]
            return self.conn.execute(query, **kwargs)

    class ObservedPool:
        @contextmanager
        def connection(self, **kwargs):
            with pool.connection(**kwargs) as conn:
                observed["before"] = conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"]
                yield ProbeConnection(conn)
                observed["after"] = conn.execute("SHOW statement_timeout").fetchone()["statement_timeout"]

    with monkeypatch.context() as patch:
        patch.setattr(app.state, "pool", ObservedPool())
        assert hosting_client.get("/readyz").status_code == 200
    assert observed["during"] == "2s"
    assert observed["after"] == observed["before"]
