"""HTTP limits and operational evidence against the real API/database."""

import asyncio
import json
import re

import pytest
import httpx
from fastapi.testclient import TestClient

from leaseq.api import app
from leaseq import security

TOKEN = "operational-test-token-0123456789"


@pytest.fixture
def operational_client(db_url, monkeypatch):
    clients = []

    def create(**settings):
        monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
        for name, value in settings.items():
            monkeypatch.setenv(name, str(value))
        client = TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"})
        client.__enter__()
        clients.append(client)
        return client

    yield create
    for client in reversed(clients):
        client.__exit__(None, None, None)


def test_authenticated_api_rate_limit_has_bounded_retry(operational_client):
    client = operational_client(LEASEQ_RATE_LIMIT=2)
    assert client.get("/auth/check").status_code == 200
    assert client.get("/auth/check").status_code == 200
    response = client.get("/auth/check")
    assert response.status_code == 429
    assert 1 <= int(response.headers["retry-after"]) <= 60
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-correlation-id"]


def test_public_read_and_auth_failure_have_separate_lower_limit(operational_client):
    client = operational_client(LEASEQ_PUBLIC_READ=1, LEASEQ_PUBLIC_RATE_LIMIT=2)
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer invalid"}).status_code
        == 200
    )
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer invalid"}).status_code
        == 200
    )
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer invalid"}).status_code
        == 429
    )
    assert client.get("/auth/check").status_code == 200


def test_liveness_is_not_denied_when_client_has_exhausted_rate(operational_client):
    client = operational_client(LEASEQ_RATE_LIMIT=1)
    assert client.get("/auth/check").status_code == 200
    assert client.get("/auth/check").status_code == 429
    assert client.get("/livez").status_code == 200
    assert client.get("/readyz").status_code == 200


def test_probes_have_reserved_capacity_outside_the_public_client_map(
    operational_client,
):
    client = operational_client(LEASEQ_PUBLIC_RATE_LIMIT=1, LEASEQ_PUBLIC_READ=1)
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer invalid"}).status_code
        == 200
    )
    assert (
        client.get("/jobs", headers={"Authorization": "Bearer invalid"}).status_code
        == 429
    )
    for i in range(app.state.rate_limiter.max_clients):
        app.state.rate_limiter.allow(f"synthetic-client-{i}", False)
    assert (
        client.get("/livez", headers={"Authorization": "Bearer invalid"}).status_code
        == 200
    )
    assert (
        client.get("/readyz", headers={"Authorization": "Bearer invalid"}).status_code
        == 200
    )


def test_metrics_require_operator_auth_and_report_real_counts(operational_client):
    client = operational_client(LEASEQ_PUBLIC_READ=1)
    assert (
        client.get("/metrics", headers={"Authorization": "Bearer invalid"}).status_code
        == 401
    )
    response = client.post(
        "/jobs", headers={"Idempotency-Key": "metric-job"}, json={"kind": "noop"}
    )
    assert response.status_code == 201
    metrics = client.get("/metrics")
    assert metrics.status_code == 200
    assert "text/plain" in metrics.headers["content-type"]
    assert 'leaseq_queue_depth{state="queued"} 1' in metrics.text
    assert (
        'leaseq_http_requests_total{method="POST",route="/jobs",status="201"} 1'
        in metrics.text
    )
    assert "leaseq_http_request_duration_seconds_bucket" in metrics.text
    assert TOKEN not in metrics.text and "metric-job" not in metrics.text


def test_request_logs_are_structured_bounded_and_do_not_include_secrets(
    operational_client, caplog
):
    client = operational_client()
    marker = "private-payload-do-not-log-71ed"
    with caplog.at_level("INFO", logger="leaseq.requests"):
        response = client.post(
            "/jobs?diagnostic=private-query",
            headers={
                "Idempotency-Key": "do-not-log-key",
                "X-Correlation-ID": "operator-check-17",
            },
            json={"kind": "noop", "payload": {"secret": marker}},
        )
    assert response.status_code == 201
    assert response.headers["x-correlation-id"] == "operator-check-17"
    records = [
        json.loads(x.message) for x in caplog.records if x.name == "leaseq.requests"
    ]
    assert records and records[-1]["correlation_id"] == "operator-check-17"
    assert records[-1]["route"] == "/jobs" and records[-1]["status"] == 201
    assert records[-1]["duration_ms"] >= 0
    encoded = json.dumps(records)
    assert all(
        value not in encoded
        for value in (TOKEN, marker, "private-query", "do-not-log-key")
    )


def test_invalid_correlation_header_is_replaced_on_auth_failure(operational_client):
    client = operational_client()
    response = client.get(
        "/jobs",
        headers={"Authorization": "Bearer invalid", "X-Correlation-ID": "<unsafe>"},
    )
    assert response.status_code == 401
    assert re.fullmatch(r"[0-9a-f-]{36}", response.headers["x-correlation-id"])


@pytest.mark.parametrize("value", ["0", "-1", "1000000", "invalid"])
def test_request_body_configuration_cannot_disable_the_64k_cap(monkeypatch, value):
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    monkeypatch.setenv("LEASEQ_MAX_BODY_BYTES", value)
    with pytest.raises((ValueError, RuntimeError)):
        security.load_settings()


def test_rate_bucket_has_bounded_state_and_refills_without_bypass():
    from leaseq.observability import RateBuckets

    now = [10.0]
    buckets = RateBuckets(
        auth_limit=2, public_limit=1, max_clients=2, clock=lambda: now[0]
    )
    assert buckets.allow("a", False) == 0
    assert 1 <= buckets.allow("a", False) <= 60
    assert buckets.allow("b", False) == 0
    assert buckets.allow("c", False) > 0
    assert buckets.size == 2
    now[0] += 61
    assert buckets.allow("c", False) == 0
    assert buckets.size <= 2


def test_histogram_path_cardinality_is_bounded():
    from leaseq.observability import route_label

    assert route_label("/jobs/123/complete") == "/jobs/{job_id}/complete"
    assert route_label("/jobs/999999/complete") == "/jobs/{job_id}/complete"
    assert route_label("/unknown/private-identifier") == "/unmatched"
    assert route_label("/dashboard/assets/app.js") == "/dashboard/*"


def test_secure_transport_headers_do_not_trust_forwarded_https(operational_client):
    client = operational_client()
    plain = client.get("/livez", headers={"X-Forwarded-Proto": "https"})
    assert "strict-transport-security" not in plain.headers
    assert (
        plain.headers["permissions-policy"]
        == "camera=(), microphone=(), geolocation=()"
    )
    secure = client.get("https://testserver/livez")
    assert secure.headers["strict-transport-security"] == "max-age=31536000"


def test_slow_chunked_body_times_out_before_job_creation(
    operational_client, monkeypatch
):
    client = operational_client()
    monkeypatch.setattr(security, "BODY_READ_TIMEOUT_SECONDS", 0.01, raising=False)

    async def exercise():
        async def body():
            yield b'{"kind":"noop"'
            await asyncio.sleep(1)
            yield b"}"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as async_client:
            return await async_client.post(
                "/jobs",
                content=body(),
                headers={
                    "Authorization": f"Bearer {TOKEN}",
                    "Idempotency-Key": "slow-body",
                },
            )

    response = asyncio.run(exercise())
    assert response.status_code == 408
    assert response.headers["x-correlation-id"]
    assert client.get("/jobs").json()["jobs"] == []


def test_stats_polls_share_the_declared_bounded_age_snapshot(operational_client):
    client = operational_client()
    first = client.get("/stats")
    assert first.status_code == 200 and first.json()["total"] == 0
    assert (
        client.post(
            "/jobs", headers={"Idempotency-Key": "stats-cache"}, json={"kind": "noop"}
        ).status_code
        == 201
    )
    second = client.get("/stats")
    assert second.json()["total"] == 0
    assert (
        first.headers["x-leaseq-counts-as-of"]
        == second.headers["x-leaseq-counts-as-of"]
    )
    assert float(second.headers["x-leaseq-counts-max-age-seconds"]) == 5
    assert second.headers["cache-control"] == "no-store"
    # Job rows remain fresh despite the explicit aggregate-cache contract.
    assert len(client.get("/jobs").json()["jobs"]) == 1
