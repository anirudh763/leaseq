import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import harness  # noqa: E402

from leaseq import db, queue  # noqa: E402
from leaseq.api import app  # noqa: E402


@pytest.fixture
def db_url(monkeypatch):
    """A wiped scratch database ("leaseq_test") with the schema applied."""
    url = harness.scratch_database("leaseq_test")
    monkeypatch.setenv("LEASEQ_DATABASE_URL", url)
    monkeypatch.setattr(queue, "BACKOFF_BASE", 0.2)
    return url


@pytest.fixture
def conn(db_url):
    with db.connect(db_url) as c:
        yield c


@pytest.fixture
def client(db_url):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def submit(client):
    def _submit(key, kind="noop", **body):
        r = client.post("/jobs", headers={"Idempotency-Key": key}, json={"kind": kind, **body})
        assert r.status_code in (200, 201), r.text
        return r.json()
    return _submit


@pytest.fixture
def claim(client):
    def _claim(worker="w1", lease=30):
        r = client.post("/jobs/claim", json={"worker_id": worker, "lease_seconds": lease})
        assert r.status_code in (200, 204), r.text
        return r.json() if r.status_code == 200 else None
    return _claim
