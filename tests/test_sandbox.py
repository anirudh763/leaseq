"""HTTP boundary checks for the loopback sandbox gateway."""

import asyncio

from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

import leaseq.sandbox as sandbox
from leaseq.sandbox import MAX_BODY, SandboxManager, create_app

TEST_ADMIN_DSN = "postgresql://test:test@127.0.0.1:55444/leaseq_sandbox_admin"


def client_for(manager):
    return TestClient(create_app(manager), base_url="http://127.0.0.1")


def test_gateway_requires_same_origin_and_custom_header_before_mutation():
    manager = SandboxManager(TEST_ADMIN_DSN)
    with client_for(manager) as client:
        assert (
            client.post(
                "/sandbox/runs",
                headers={"Origin": "https://evil.invalid", "X-LeaseQ-Sandbox": "1"},
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/sandbox/runs",
                headers={"Origin": "http://127.0.0.1", "X-LeaseQ-Sandbox": "1"},
            ).status_code
            == 503
        )
        assert (
            client.post(
                "/sandbox/runs", headers={"Origin": "http://127.0.0.1"}
            ).status_code
            == 403
        )
        assert (
            client.post("/sandbox/runs", headers={"X-LeaseQ-Sandbox": "1"}).status_code
            == 403
        )
        assert (
            client.post(
                "/sandbox/runs",
                headers={
                    "Host": "attacker.invalid",
                    "Origin": "http://attacker.invalid",
                    "X-LeaseQ-Sandbox": "1",
                },
            ).status_code
            == 403
        )


def test_gateway_body_cap_rejects_before_json_parse():
    manager = SandboxManager(TEST_ADMIN_DSN)
    with client_for(manager) as client:
        response = client.post(
            "/sandbox/runs",
            content=b"{" + b" " * MAX_BODY,
            headers={
                "Origin": "http://127.0.0.1",
                "X-LeaseQ-Sandbox": "1",
                "Content-Type": "application/json",
            },
        )
        assert response.status_code == 413
        small = client.post(
            "/sandbox/runs",
            content=b'{"pid": 123}',
            headers={
                "Origin": "http://127.0.0.1",
                "X-LeaseQ-Sandbox": "1",
                "Content-Type": "application/json",
            },
        )
        assert small.status_code == 422


def test_chunked_request_body_has_total_read_deadline(monkeypatch):
    manager = SandboxManager(TEST_ADMIN_DSN)
    app = create_app(manager)
    monkeypatch.setattr(sandbox, "BODY_READ_TIMEOUT_SECONDS", 0.02)

    async def chunks():
        yield b"{"
        await asyncio.sleep(0.1)
        yield b"}"

    async def request():
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://127.0.0.1"
        ) as client:
            return await client.post(
                "/sandbox/runs",
                content=chunks(),
                headers={
                    "Origin": "http://127.0.0.1",
                    "X-LeaseQ-Sandbox": "1",
                    "Content-Type": "application/json",
                },
            )

    response = asyncio.run(request())
    assert response.status_code == 408
    assert "0.02 second limit" in response.json()["detail"]


def test_gateway_rejects_pid_query_and_returns_explicit_gone_without_leaking():
    manager = SandboxManager(TEST_ADMIN_DSN)
    with client_for(manager) as client:
        rejected = client.post(
            "/sandbox/runs/arbitrary/kill?pid=123",
            headers={
                "Origin": "http://127.0.0.1",
                "X-LeaseQ-Sandbox": "1",
                "Authorization": "Bearer fake-capability",
            },
        )
        assert rejected.status_code == 400
        gone = client.get(
            "/sandbox/runs/arbitrary",
            headers={"Authorization": "Bearer fake-capability"},
        )
        assert gone.status_code == 410
        assert gone.headers["cache-control"] == "no-store"
        assert gone.headers["content-security-policy"].endswith(
            "frame-ancestors 'none'"
        )
        assert "capability" not in gone.text


def test_ready_probe_fails_when_admin_database_is_unavailable():
    manager = SandboxManager(TEST_ADMIN_DSN)
    with client_for(manager) as client:
        response = client.get("/readyz")
        assert response.status_code == 503
        assert response.json()["ok"] is False


def test_mutation_rate_limit_is_ten_per_minute_and_bounded():
    manager = SandboxManager(TEST_ADMIN_DSN)
    for _ in range(10):
        assert manager.allow_mutation("127.0.0.1") is None
    retry = manager.allow_mutation("127.0.0.1")
    assert 1 <= retry <= 60
    assert len(manager._rates) == 1


def test_gateway_returns_real_429_and_retry_after():
    manager = SandboxManager(TEST_ADMIN_DSN)
    headers = {"Origin": "http://127.0.0.1", "X-LeaseQ-Sandbox": "1"}
    with client_for(manager) as client:
        for _ in range(10):
            assert client.post("/sandbox/runs", headers=headers).status_code == 503
        response = client.post("/sandbox/runs", headers=headers)
        assert response.status_code == 429
        assert 1 <= int(response.headers["Retry-After"]) <= 60


def test_mutation_rate_limiter_has_a_hard_address_map_bound():
    manager = SandboxManager(TEST_ADMIN_DSN)
    for i in range(2048):
        assert manager.allow_mutation(f"198.51.100.{i}") is None
    assert manager.allow_mutation("203.0.113.9") == 60
    assert len(manager._rates) == 2048


def test_capability_is_constant_run_scoped_and_expiry_aware():
    import time
    from types import SimpleNamespace

    manager = SandboxManager(TEST_ADMIN_DSN)
    manager.current = SimpleNamespace(
        run_id="run-a", capability="secret-capability", expires_at=time.time() + 10
    )
    assert manager.authorized("run-a", "secret-capability")
    assert not manager.authorized("run-b", "secret-capability")
    manager.current.expires_at = time.time() - 1
    assert not manager.authorized("run-a", "secret-capability")


def test_run_ttl_uses_monotonic_time_when_wall_clock_jumps():
    import time
    from types import SimpleNamespace

    manager = SandboxManager(TEST_ADMIN_DSN)
    cap = "secret-capability"
    # A forward wall-clock jump must not expire a run whose monotonic deadline remains.
    manager.current = SimpleNamespace(
        run_id="run-a",
        capability=cap,
        expires_at=time.time() - 100,
        deadline_monotonic=time.monotonic() + 10,
        closed=False,
    )
    assert manager.capability_status("run-a", cap) is None
    # A backward wall-clock jump must not extend a run after its monotonic deadline.
    manager.current.deadline_monotonic = time.monotonic() - 1
    manager.current.expires_at = time.time() + 600
    assert manager.capability_status("run-a", cap) == 410
