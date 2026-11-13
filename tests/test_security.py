"""Access control, input limits and operator actions. Each test fails if the
protection it names is removed. Runs against real PostgreSQL like test_api.py."""
import re
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import harness
from leaseq import api, db, queue, security, worker
from leaseq.api import app

TOKEN = "test-token-0123456789abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def make_client(db_url, monkeypatch):
    """TestClient whose app was started with the given env (settings load at startup)."""
    clients = []

    def _make(token=TOKEN, public_read=False, auth=True, **env):
        """auth=True: the client sends the right token on every request."""
        for k in ("LEASEQ_API_TOKEN", "LEASEQ_PUBLIC_READ", "LEASEQ_MAX_BODY_BYTES"):
            monkeypatch.delenv(k, raising=False)
        if token:
            monkeypatch.setenv("LEASEQ_API_TOKEN", token)
        if public_read:
            monkeypatch.setenv("LEASEQ_PUBLIC_READ", "1")
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        c = TestClient(app, headers=AUTH if auth else None)
        c.__enter__()
        clients.append(c)
        return c

    yield _make
    for c in clients:
        c.__exit__(None, None, None)


def rows(conn):
    return (conn.execute("SELECT count(*) AS n FROM jobs").fetchone()["n"],
            conn.execute("SELECT count(*) AS n FROM job_events").fetchone()["n"])


def seed(conn, n=1, **kw):
    return [queue.enqueue(conn, "noop", {}, f"seed-{i}", **kw)[0]["id"] for i in range(n)]


# --- bearer token ------------------------------------------------------------

WRITE_CALLS = [
    ("POST", "/jobs", {"kind": "noop"}),
    ("POST", "/jobs/claim", {"worker_id": "w1"}),
    ("POST", "/jobs/1/heartbeat", {"lease_token": "abc"}),
    ("POST", "/jobs/1/complete", {"lease_token": "abc"}),
    ("POST", "/jobs/1/fail", {"lease_token": "abc"}),
    ("POST", "/jobs/1/requeue", {}),
    ("POST", "/jobs/1/cancel", {}),
    ("POST", "/demo/jobs", None),
    ("GET", "/auth/check", None),
]
READ_CALLS = [("GET", "/stats", None), ("GET", "/jobs", None),
              ("GET", "/jobs/1", None), ("GET", "/jobs/1/events", None)]
BAD_HEADERS = [{}, {"Authorization": "Bearer wrong-token-0123456789"},
               {"Authorization": f"Basic {TOKEN}"}, {"Authorization": "Bearer "},
               {"Authorization": f"Bearer {TOKEN}x"}, {"Authorization": f"Bearer {TOKEN[:-1]}"}]


@pytest.mark.parametrize("method,path,body", WRITE_CALLS + READ_CALLS)
def test_every_endpoint_needs_the_token(make_client, conn, method, path, body):
    client = make_client(auth=False)
    seed(conn)
    queue.claim(conn, "w0", 30)
    before = rows(conn)
    for headers in BAD_HEADERS:
        r = client.request(method, path, json=body,
                           headers={"Idempotency-Key": "k", **headers})
        assert r.status_code == 401, (headers, r.text)
        assert r.headers["www-authenticate"] == "Bearer"
        assert r.json() == {"detail": "missing or invalid bearer token"}
    assert rows(conn) == before                       # nothing was written


def test_routes_are_protected_by_default(make_client):
    """A path nobody listed as open needs the token, even one that does not exist,
    so a route added later cannot be left open by forgetting a check."""
    client = make_client(auth=False)
    for method in ("GET", "POST", "DELETE"):
        assert client.request(method, "/not-a-route").status_code == 401
    assert client.get("/not-a-route", headers=AUTH).status_code == 404


def test_unauthenticated_body_is_not_parsed(make_client, conn):
    """Auth runs before validation: no token means 401 even for a malformed body."""
    client = make_client(auth=False)
    r = client.post("/jobs", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 401
    # ...and before the body limit: a stranger's body is never read at all.
    big = client.post("/jobs", content=b"x" * 70_000, headers={"Content-Type": "application/json"})
    assert big.status_code == 401


def test_correct_token_runs_the_whole_job_cycle(make_client):
    client = make_client(auth=False)
    r = client.post("/jobs", headers={"Idempotency-Key": "a", **AUTH}, json={"kind": "noop"})
    assert r.status_code == 201
    job = client.post("/jobs/claim", headers=AUTH, json={"worker_id": "w1"}).json()
    token = {"lease_token": job["lease_token"]}
    assert client.post(f"/jobs/{job['id']}/heartbeat", headers=AUTH, json=token).status_code == 200
    assert client.post(f"/jobs/{job['id']}/complete", headers=AUTH, json=token).status_code == 200
    assert client.get(f"/jobs/{job['id']}", headers=AUTH).json()["state"] == "done"
    assert client.get("/stats", headers={"authorization": f"bearer {TOKEN}"}).status_code == 200


def test_public_read_opens_gets_but_never_writes(make_client, conn):
    client = make_client(public_read=True, auth=False)
    job_id = seed(conn)[0]
    for _, path, _ in READ_CALLS:
        assert client.get(path.replace("/1", f"/{job_id}")).status_code == 200, path
    for method, path, body in WRITE_CALLS:
        r = client.request(method, path, json=body, headers={"Idempotency-Key": "k"})
        assert r.status_code == 401, path


def test_reads_need_the_token_unless_public_read_is_exactly_1(make_client, conn):
    seed(conn)
    for value in ("", "0", "true", "yes"):
        client = make_client(auth=False, LEASEQ_PUBLIC_READ=value)
        assert client.get("/jobs").status_code == 401, value


def test_token_is_compared_in_constant_time(make_client, monkeypatch):
    calls = []
    real = security.hmac.compare_digest

    def spy(a, b):
        calls.append((len(a), len(b)))
        return real(a, b)

    monkeypatch.setattr(security.hmac, "compare_digest", spy)
    client = make_client(auth=False)
    assert client.get("/stats", headers={"Authorization": "Bearer short"}).status_code == 401
    assert client.get("/stats", headers=AUTH).status_code == 200
    # Both sides are hashed first, so the comparison never sees the real lengths.
    assert calls == [(32, 32), (32, 32)]


def test_short_token_is_refused_at_startup(db_url, monkeypatch):
    monkeypatch.setenv("LEASEQ_API_TOKEN", "too-short")
    with pytest.raises(RuntimeError, match="at least 16"):
        with TestClient(app):
            pass


@pytest.mark.parametrize("value", [None, "", "   "])
def test_missing_or_blank_token_refuses_to_start(db_url, monkeypatch, value):
    """Fail closed: no token configured never means an open API."""
    if value is None:
        monkeypatch.delenv("LEASEQ_API_TOKEN", raising=False)
    else:
        monkeypatch.setenv("LEASEQ_API_TOKEN", value)
    with pytest.raises(RuntimeError, match="LEASEQ_API_TOKEN is not set or is blank"):
        with TestClient(app):
            pass


def test_healthz_and_dashboard_files_need_no_token(make_client):
    client = make_client(auth=False)
    assert client.get("/healthz").json() == {"ok": True}
    assert client.get("/dashboard/").status_code == 200
    assert client.get("/dashboard/assets/app.js").status_code == 200


# --- request size and input validation ----------------------------------------

def test_oversized_body_is_rejected_before_parsing(make_client, conn):
    client = make_client()
    big = {"kind": "noop", "payload": {"x": "y" * 70_000}}
    r = client.post("/jobs", headers={"Idempotency-Key": "big"}, json=big)
    assert r.status_code == 413
    assert rows(conn) == (0, 0)


def test_oversized_chunked_body_without_content_length_is_rejected(make_client, conn):
    client = make_client(LEASEQ_MAX_BODY_BYTES="1000")

    def chunks():
        yield b'{"kind": "noop", "payload": {"x": "'
        for _ in range(20):
            yield b"y" * 100
        yield b'"}}'

    r = client.post("/jobs", headers={"Idempotency-Key": "c", "Content-Type": "application/json"},
                    content=chunks())
    assert "content-length" not in {k.lower() for k in r.request.headers}
    assert r.status_code == 413
    assert rows(conn) == (0, 0)


def test_body_limit_is_configurable_and_small_bodies_pass(make_client):
    client = make_client(LEASEQ_MAX_BODY_BYTES="200")
    ok = client.post("/jobs", headers={"Idempotency-Key": "s"}, json={"kind": "noop"})
    assert ok.status_code == 201
    r = client.post("/jobs", headers={"Idempotency-Key": "t"},
                    json={"kind": "noop", "payload": {"x": "y" * 300}})
    assert r.status_code == 413


@pytest.mark.parametrize("path,body", [
    ("/jobs", {"kind": "k" * 101}),
    ("/jobs", {"kind": "<script>"}),
    ("/jobs", {"kind": "a b"}),
    ("/jobs", {"kind": "a\u0000b"}),
    ("/jobs", {"kind": "noop", "payload": {"x": "a\u0000b"}}),     # was a 500
    ("/jobs", {"kind": "noop", "payload": {"a\u0000": 1}}),
    ("/jobs", {"kind": "noop", "max_attempts": 101}),
    ("/jobs/claim", {"worker_id": "w" * 201}),
    ("/jobs/claim", {"worker_id": "w\nx"}),
])
def test_invalid_input_is_a_422_not_a_500(make_client, conn, path, body):
    client = make_client()       # TestClient re-raises server errors
    r = client.post(path, headers={"Idempotency-Key": "v"}, json=body)
    assert r.status_code == 422, r.text
    assert rows(conn) == (0, 0)


def test_nan_lease_length_is_a_422_not_a_500(make_client, conn):
    """Python's json accepts the non-standard literal NaN; it used to reach SQL."""
    client = make_client()
    seed(conn)
    for literal in (b"NaN", b"Infinity", b"-Infinity"):
        r = client.post("/jobs/claim",
                        content=b'{"worker_id": "w", "lease_seconds": %s}' % literal,
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 422, literal
        assert "input" not in r.json()["detail"][0]          # rejected input is not echoed
    assert client.get("/jobs/1").json()["state"] == "queued"


def test_idempotency_key_longer_than_200_is_rejected(make_client):
    client = make_client()
    r = client.post("/jobs", headers={"Idempotency-Key": "k" * 201}, json={"kind": "noop"})
    assert r.status_code == 422


@pytest.mark.parametrize("field,value", [
    ("lease_token", "t" * 65), ("lease_token", ""), ("lease_token", "a'b"),
])
def test_lease_token_shape_is_checked(make_client, conn, field, value):
    client = make_client()
    seed(conn)
    for op in ("heartbeat", "complete", "fail"):
        assert client.post(f"/jobs/1/{op}", json={field: value}).status_code == 422


def test_error_text_is_bounded_and_nul_is_a_422(make_client, conn):
    client = make_client()
    seed(conn)
    job = queue.claim(conn, "w1", 30)
    long = client.post("/jobs/1/fail", json={"lease_token": job["lease_token"], "error": "e" * 4001})
    assert long.status_code == 422
    nul = client.post("/jobs/1/fail", json={"lease_token": job["lease_token"], "error": "a\u0000"})
    assert nul.status_code == 422
    assert client.get("/jobs/1").json()["state"] == "leased"   # the failed write rolled back


def test_job_id_beyond_bigint_is_404_not_500(make_client):
    """Regression check, not a fix: psycopg sends such ids as numeric, which match no row."""
    client = make_client()
    assert client.get(f"/jobs/{2**63}").status_code == 404
    assert client.get(f"/jobs/{2**63}/events").status_code == 404
    assert client.post(f"/jobs/{2**64}/complete", json={"lease_token": "a"}).status_code == 404


# --- bounded reads ------------------------------------------------------------

def test_job_list_is_paged_and_capped(make_client, conn, monkeypatch):
    client = make_client()
    ids = seed(conn, 60)
    first = client.get("/jobs").json()
    assert [j["id"] for j in first["jobs"]] == ids[::-1][:50]
    assert first["next_before_id"] == ids[10]
    second = client.get("/jobs", params={"before_id": first["next_before_id"]}).json()
    assert [j["id"] for j in second["jobs"]] == ids[::-1][50:]
    assert second["next_before_id"] is None
    assert client.get("/jobs", params={"limit": queue.MAX_PAGE + 1}).status_code == 422
    assert client.get("/jobs", params={"limit": 0}).status_code == 422
    monkeypatch.setattr(queue, "MAX_PAGE", 25)                     # capped in queue.py too
    assert len(queue.list_jobs(conn, limit=10_000)[0]) == 25


def test_job_list_never_returns_payload_result_or_lease_token(make_client, conn):
    client = make_client()
    seed(conn, 2)
    queue.claim(conn, "w1", 30)
    body = client.get("/jobs").json()
    assert all({"payload", "result", "lease_token"}.isdisjoint(j) for j in body["jobs"])
    assert "lease_token" not in client.get("/jobs/1/events").text


def test_job_list_filters(make_client, conn):
    client = make_client()
    a = queue.enqueue(conn, "email", {}, "a")[0]["id"]
    queue.enqueue(conn, "sms", {}, "b")
    claimed = queue.claim(conn, "w9", 30)
    queue.fail(conn, claimed["id"], claimed["lease_token"], "boom")      # a -> retrying
    get = lambda **p: [j["id"] for j in client.get("/jobs", params=p).json()["jobs"]]  # noqa
    assert get(kind="email") == [a]
    assert get(state="retrying") == [a]
    assert get(state="queued") == [2, 1]
    assert get(worker="w9") == [a]
    assert client.get("/jobs", params={"state": "bogus"}).status_code == 422
    assert client.get("/jobs", params={"kind": "a'; DROP TABLE jobs; --"}).status_code == 422
    counts = client.get("/jobs").json()["counts"]
    assert (counts["queued"], counts["retrying"], counts["total"]) == (2, 1, 2)


def test_events_are_paged_and_capped(make_client, conn):
    client = make_client()
    job_id = seed(conn)[0]
    job = queue.claim(conn, "w1", 30)
    for _ in range(5):
        queue.complete(conn, job_id, "stale-token")                     # 5 rejected rows
    queue.complete(conn, job_id, job["lease_token"])
    page = client.get(f"/jobs/{job_id}/events", params={"limit": 3}).json()
    assert [e["event"] for e in page["events"]] == ["enqueued", "claimed", "rejected"]
    rest = client.get(f"/jobs/{job_id}/events",
                      params={"after_id": page["next_after_id"], "limit": 10}).json()
    assert [e["event"] for e in rest["events"]] == ["rejected"] * 4 + ["completed"]
    assert rest["next_after_id"] is None
    assert client.get(f"/jobs/{job_id}/events",
                      params={"limit": queue.MAX_EVENTS_PAGE + 1}).status_code == 422
    assert client.get("/jobs/999/events").status_code == 404


# --- operator actions -----------------------------------------------------------

def test_requeue_gives_a_dead_job_more_attempts(make_client, conn):
    client = make_client()
    job_id = seed(conn, max_attempts=1)[0]
    job = queue.claim(conn, "w1", 30)
    assert queue.fail(conn, job_id, job["lease_token"], "boom")["state"] == "dead"
    r = client.post(f"/jobs/{job_id}/requeue", headers=AUTH, json={"extra_attempts": 2})
    assert r.status_code == 200
    assert (r.json()["state"], r.json()["attempts"], r.json()["max_attempts"]) == ("queued", 1, 3)
    again = queue.claim(conn, "w2", 30)
    assert again["id"] == job_id and again["attempts"] == 2
    # The lease from the attempt that died is stale: its holder cannot report back.
    stale = {"lease_token": job["lease_token"]}
    assert client.post(f"/jobs/{job_id}/complete", headers=AUTH, json=stale).status_code == 409
    assert worker.finish(conn, job, {}, "w1") is False
    assert worker.finish(conn, again, {}, "w2") is True
    events = [e["event"] for e in client.get(f"/jobs/{job_id}/events", headers=AUTH)
              .json()["events"]]
    assert events == ["enqueued", "claimed", "dead", "requeued", "claimed", "rejected",
                      "rejected", "completed"]
    # The audit invariant the chaos test checks still holds: one claim row per attempt.
    claims = conn.execute("SELECT count(*) AS n FROM job_events WHERE event = 'claimed'"
                          ).fetchone()["n"]
    assert claims == again["attempts"]


def test_requeue_refuses_jobs_that_are_not_dead(make_client, conn):
    client = make_client()
    job_id = seed(conn)[0]
    assert client.post(f"/jobs/{job_id}/requeue", headers=AUTH).status_code == 409
    job = queue.claim(conn, "w1", 30)
    queue.complete(conn, job_id, job["lease_token"])
    assert client.post(f"/jobs/{job_id}/requeue", headers=AUTH).status_code == 409
    assert client.post("/jobs/999/requeue", headers=AUTH).status_code == 404


def test_cancel_fences_out_the_worker_holding_the_lease(make_client, conn):
    client = make_client()
    job_id = seed(conn)[0]
    held = queue.claim(conn, "w1", 30)
    r = client.post(f"/jobs/{job_id}/cancel", headers=AUTH, json={"reason": "operator test"})
    assert r.status_code == 200 and r.json()["state"] == "dead"
    token = {"lease_token": held["lease_token"]}
    assert client.post(f"/jobs/{job_id}/heartbeat", headers=AUTH, json=token).status_code == 409
    assert worker.finish(conn, held, {}, "w1") is False
    assert conn.execute("SELECT count(*) AS n FROM effects").fetchone()["n"] == 0
    assert queue.claim(conn, "w2", 30) is None
    last = client.get(f"/jobs/{job_id}/events", headers=AUTH).json()["events"]
    cancelled = [e for e in last if e["event"] == "cancelled"][0]
    assert cancelled["detail"] == {"from_state": "leased", "reason": "operator test"}
    assert client.post(f"/jobs/{job_id}/cancel", headers=AUTH).status_code == 409


def test_sample_jobs_endpoint_fills_an_empty_queue(make_client):
    client = make_client()
    r = client.post("/demo/jobs", headers=AUTH)
    assert r.status_code == 201 and r.json()["enqueued"] == 16
    assert client.get("/stats", headers=AUTH).json()["queued"] == 16


def test_old_event_check_is_widened_on_start(db_url):
    """A database created by the previous schema rejects 'requeued' until migrated."""
    with db.connect(db_url) as c:
        c.execute("ALTER TABLE job_events DROP CONSTRAINT job_events_event_check")
        c.execute("ALTER TABLE job_events ADD CONSTRAINT job_events_event_check CHECK "
                  "(event IN ('enqueued','claimed','completed','failed','dead','rejected'))")
        job_id = queue.enqueue(c, "noop", {}, "m")[0]["id"]
        with pytest.raises(Exception, match="job_events_event_check"):
            queue._event(c, job_id, "requeued", 0)
        db.apply_schema(c)
        queue._event(c, job_id, "requeued", 0)
        db.apply_schema(c)                          # second start: still fine
        assert [r["event"] for r in c.execute("SELECT event FROM job_events ORDER BY id")] == [
            "enqueued", "requeued"]


# --- dashboard ------------------------------------------------------------------

def test_dashboard_has_a_strict_csp_and_loads_nothing_external(make_client):
    client = make_client()
    r = client.get("/dashboard/")
    csp = r.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
    assert r.headers["x-content-type-options"] == "nosniff"
    files = [p for p in (Path(api.DASHBOARD)).rglob("*") if p.suffix in (".html", ".js", ".css")]
    assert files
    for p in files:
        text = p.read_text()
        text = text.replace("http://www.w3.org/2000/svg", "")      # SVG namespace name
        assert not re.search(r"https?://|//cdn", text), f"external URL in {p.name}"
        assert "innerHTML" not in text and "insertAdjacentHTML" not in text, p.name
        assert "<script>" not in text and " on" + "click=" not in text, p.name


# --- worker over HTTP with a token -------------------------------------------------

def test_worker_process_authenticates_with_the_token(db_url, monkeypatch, tmp_path):
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    proc, base = harness.start_api(db_url)
    w = None
    try:
        r = httpx.post(base + "/jobs", headers={"Idempotency-Key": "w", **AUTH},
                       json={"kind": "sleep", "payload": {"ms": 20}})
        assert r.status_code == 201
        assert httpx.post(base + "/jobs/claim", json={"worker_id": "x"}).status_code == 401
        w = harness.start_worker(db_url, base, "tw", 5)       # inherits LEASEQ_API_TOKEN
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if httpx.get(base + "/jobs/1", headers=AUTH).json()["state"] == "done":
                break
            time.sleep(0.1)
        assert httpx.get(base + "/jobs/1", headers=AUTH).json()["state"] == "done"
    finally:
        for p in (w, proc):
            if p is not None:
                p.terminate()
                p.wait()


def test_worker_without_the_token_stops_with_a_clear_message(db_url, monkeypatch):
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    proc, base = harness.start_api(db_url)
    try:
        with pytest.raises(SystemExit, match="rejected the token"):
            worker.run(base, "nw", 5, 0.05, token=None)
    finally:
        proc.terminate()
        proc.wait()
