from contextlib import contextmanager

import psycopg
import pytest
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


def test_database_outage_fails_readiness_without_failing_liveness(hosting_client, monkeypatch):
    class DisconnectedPool:
        @contextmanager
        def connection(self, **kwargs):
            raise psycopg.OperationalError("private database connection details")
            yield

    with monkeypatch.context() as patch:
        patch.setattr(app.state, "pool", DisconnectedPool())
        assert hosting_client.get("/livez").status_code == 200
        response = hosting_client.get("/readyz")
        assert response.status_code == 503
        assert response.json() == {"ok": False}
        assert "private" not in response.text
