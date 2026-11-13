"""word_count through the real path: HTTP submit -> worker process claims ->
handler -> fenced completion in one transaction -> result readable over HTTP."""
import time

import httpx

import harness


def _wait(c, job_id, state, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        job = c.get(f"/jobs/{job_id}").json()
        if job["state"] == state:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} is {job['state']}, not {state}")


def test_word_count_result_is_stored_once_and_oversize_fails_clearly(monkeypatch):
    monkeypatch.setenv("LEASEQ_API_TOKEN", "wc-token-0123456789abcdef")
    monkeypatch.delenv("LEASEQ_PUBLIC_READ", raising=False)
    db_url = harness.scratch_database("leaseq_wc")
    api, base = harness.start_api(db_url)
    w = harness.start_worker(db_url, base, "wc-1", 30)
    try:
        c = httpx.Client(base_url=base, timeout=10,
                         headers={"Authorization": "Bearer wc-token-0123456789abcdef"})
        r = c.post("/jobs", headers={"Idempotency-Key": "wc-1"},
                   json={"kind": "word_count", "payload": {"text": "to be or\nnot to be"}})
        assert r.status_code == 201, r.text
        done = _wait(c, r.json()["id"], "done")
        assert done["result"] == {"words": 6, "lines": 2}
        events = [e["event"] for e in c.get(f"/jobs/{done['id']}/events").json()["events"]]
        assert events == ["enqueued", "claimed", "completed"]

        big = c.post("/jobs", headers={"Idempotency-Key": "wc-big"},
                     json={"kind": "word_count", "payload": {"text": "x" * 10_001},
                           "max_attempts": 1})
        dead = _wait(c, big.json()["id"], "dead")
        assert dead["result"] is None
        failed = [e for e in c.get(f"/jobs/{dead['id']}/events").json()["events"]
                  if e["event"] == "dead"]
        assert "10,000" in str(failed[0]["detail"]), failed

        import psycopg
        with psycopg.connect(db_url) as db:
            rows = db.execute("SELECT job_id FROM effects ORDER BY job_id").fetchall()
        assert rows == [(done["id"],)]          # one effect, for the finished job only
    finally:
        for p in (w, api):
            p.terminate()
            p.wait()
