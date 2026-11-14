"""Runs tests/e2e/dashboard.e2e.js (Playwright + axe-core) against a real API
process. Skipped when Node, Playwright or axe-core is not installed:

    AXE_PATH=/path/to/axe.min.js python -m pytest tests/test_dashboard_e2e.py -s
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

import harness

E2E = Path(__file__).with_name("e2e") / "dashboard.e2e.js"
TOKEN = "e2e-token-0123456789abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _axe_path() -> str | None:
    for candidate in (os.environ.get("AXE_PATH"),
                      "/home/claude/site/build/node_modules/axe-core/axe.min.js"):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def _has_playwright() -> bool:
    node = shutil.which("node")
    return bool(node) and subprocess.run(
        [node, "-e", "require.resolve('playwright')"], capture_output=True).returncode == 0


pytestmark = pytest.mark.skipif(not (_has_playwright() and _axe_path()),
                                reason="needs node, the playwright package and axe-core")


def seed(base: str) -> dict:
    """Jobs in every state, created through the API in an order that makes
    each claim pick the intended job (claims take the oldest runnable job)."""
    c = httpx.Client(base_url=base, headers=AUTH, timeout=10)
    n = iter(range(100))

    def submit(kind, payload=None, max_attempts=5, key=None):
        r = c.post("/jobs", headers={"Idempotency-Key": key or f"e2e-{next(n)}"},
                   json={"kind": kind, "payload": payload or {}, "max_attempts": max_attempts})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def claim(worker="w-e2e", lease=600):
        return c.post("/jobs/claim", json={"worker_id": worker, "lease_seconds": lease}).json()

    for _ in range(2):                                        # done
        submit("report.render")
        job = claim()
        assert c.post(f"/jobs/{job['id']}/complete", json={"lease_token": job["lease_token"]}).status_code == 200
    dead = submit("fail", {"error": "boom"}, max_attempts=1)   # dead
    job = claim()
    assert c.post(f"/jobs/{dead}/fail", json={"lease_token": job["lease_token"], "error": "boom"}).json()["state"] == "dead"
    retry = submit("fail", {"error": "flaky"}, max_attempts=3)  # retrying (backoff 300 s)
    job = claim()
    assert c.post(f"/jobs/{retry}/fail", json={"lease_token": job["lease_token"], "error": "flaky"}).json()["state"] == "queued"
    # Dead job whose key, payload and error text are all hostile markup.
    hostile = submit("fail", {"note": '<svg onload="window.__xss=5"></svg>'}, max_attempts=1,
                     key='<img src=x onerror="window.__xss=3">')
    job = claim()
    assert job["id"] == hostile
    assert c.post(f"/jobs/{hostile}/fail", json={
        "lease_token": job["lease_token"],
        "error": '<script>window.__xss=4</script><img src=x onerror="window.__xss=4">'}
    ).json()["state"] == "dead"
    running = submit("sleep", {"ms": 60000})                     # running
    assert claim()["id"] == running
    submit("email.send", {"to": "someone@example.com"})          # queued
    xss = submit("thumbnail.resize",
                 {"note": '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'})
    submit("index.rebuild")
    return {"dead": dead, "running": running, "xss": xss, "hostile": hostile,
            "counts": {"all": 9, "queued": 4, "leased": 1, "retrying": 1, "done": 2, "dead": 2}}


def test_dashboard_in_a_real_browser(monkeypatch):
    db_url = harness.scratch_database("leaseq_e2e")
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    monkeypatch.setenv("LEASEQ_PUBLIC_READ", "1")
    monkeypatch.setenv("LEASEQ_BACKOFF_BASE", "300")       # keep the retrying job queued
    proc, base = harness.start_api(db_url)
    try:
        expected = seed(base)
        r = subprocess.run(["node", str(E2E)], capture_output=True, text=True, timeout=240,
                           env={**os.environ, "BASE_URL": base, "API_TOKEN": TOKEN,
                                "AXE_PATH": _axe_path(), "EXPECTED": json.dumps(expected)})
        print(r.stdout)
        print(r.stderr)
        assert r.returncode == 0, r.stderr
        report = json.loads(r.stdout.strip().splitlines()[-1])
        assert report["axe_total"] == 0
        assert len(report["axe"]) == 10          # every view that was scanned
    finally:
        proc.terminate()
        proc.wait()


def test_live_flow_with_real_workers(monkeypatch):
    """Dashboard -> enqueue -> worker processes run the jobs -> events, retry,
    cancel, requeue, error states. Reads need the token (no LEASEQ_PUBLIC_READ)."""
    db_url = harness.scratch_database("leaseq_e2e_live")
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    monkeypatch.delenv("LEASEQ_PUBLIC_READ", raising=False)
    monkeypatch.setenv("LEASEQ_BACKOFF_BASE", "0.5")      # fast retries for the test
    proc, base = harness.start_api(db_url)
    workers = [harness.start_worker(db_url, base, f"live-{i}", 10) for i in range(2)]
    try:
        r = subprocess.run(["node", str(E2E.with_name("live_flow.e2e.js"))], capture_output=True,
                           text=True, timeout=300,
                           env={**os.environ, "BASE_URL": base, "API_TOKEN": TOKEN,
                                "AXE_PATH": _axe_path()})
        print(r.stdout)
        print(r.stderr)
        assert r.returncode == 0, r.stderr
        report = json.loads(r.stdout.strip().splitlines()[-1])
        assert report["axe_total"] == 0 and len(report["axe"]) == 8
        with httpx.Client(base_url=base, headers=AUTH) as c:     # the database agrees
            assert c.get("/jobs/16").json()["state"] == "dead"
            assert c.get("/jobs/1").json()["state"] == "done"
            assert c.get("/jobs/13").json()["max_attempts"] == 6
    finally:
        for p in workers + [proc]:
            p.terminate()
            p.wait()


def _wait_state(c, job_id, state, seconds=30):
    import time
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        job = c.get(f"/jobs/{job_id}").json()
        if job["state"] == state:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} is {job['state']}, not {state}")


def test_root_visual_gate(monkeypatch):
    """rebuild.md root visual gate: overflow at 320/768/1440, Menu sheet, H1 focus,
    Back/Forward and deep links, axe light+dark at 1280/320, light default under
    OS dark, CSP/console/noscript, Forget/401 clearing cached details, and the
    Submit test job flow through a real worker. Reads need the token."""
    db_url = harness.scratch_database("leaseq_e2e_gate")
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    monkeypatch.delenv("LEASEQ_PUBLIC_READ", raising=False)
    proc, base = harness.start_api(db_url)
    worker = harness.start_worker(db_url, base, "gate-1", 10)
    marker = "gate-payload-marker-7f3a91"
    try:
        c = httpx.Client(base_url=base, headers=AUTH, timeout=10)
        dead = c.post("/jobs", headers={"Idempotency-Key": "gate-dead"},
                      json={"kind": "fail", "payload": {"error": "boom", "note": marker},
                            "max_attempts": 1}).json()["id"]
        done = c.post("/jobs", headers={"Idempotency-Key": "gate-done"},
                      json={"kind": "word_count", "payload": {"text": "a b c"}}).json()["id"]
        _wait_state(c, dead, "dead")
        _wait_state(c, done, "done")
        r = subprocess.run(["node", str(E2E.with_name("visual_gate.e2e.js"))], capture_output=True,
                           text=True, timeout=600, check=False,
                           env={**os.environ, "BASE_URL": base, "API_TOKEN": TOKEN,
                                "AXE_PATH": _axe_path(),
                                "EXPECTED": json.dumps({"dead": dead, "done": done, "marker": marker})})
        print(r.stdout)
        print(r.stderr)
        report = json.loads(r.stdout.strip().splitlines()[-1])
        failed = [x for x in report["results"] if not x["ok"]]
        assert not failed, json.dumps(failed, indent=1)
        assert report["axe_scans"] == 20 and report["axe_total"] == 0
        assert r.returncode == 0
    finally:
        for p in (worker, proc):
            p.terminate()
            p.wait()


def test_dashboard_review_fixes(monkeypatch):
    db_url = harness.scratch_database("leaseq_e2e_review")
    monkeypatch.setenv("LEASEQ_API_TOKEN", TOKEN)
    monkeypatch.delenv("LEASEQ_PUBLIC_READ", raising=False)
    proc, base = harness.start_api(db_url)
    try:
        with httpx.Client(base_url=base, headers=AUTH, timeout=10) as client:
            def submit(key, kind="word_count", max_attempts=3):
                response = client.post("/jobs", headers={"Idempotency-Key": key},
                    json={"kind": kind, "payload": {"text": "review fixture"}, "max_attempts": max_attempts})
                assert response.status_code == 201, response.text
                return response.json()["id"]

            def claim():
                response = client.post("/jobs/claim", json={"worker_id": "review-fixture", "lease_seconds": 600})
                assert response.status_code == 200, response.text
                return response.json()

            dead = submit("review-dead", "fail", 1)
            lease = claim()
            response = client.post(f"/jobs/{dead}/fail", json={"lease_token": lease["lease_token"], "error": "fixture"})
            assert response.json()["state"] == "dead"
            leased = submit("review-leased")
            assert claim()["id"] == leased
            queued = submit("review-queued")
        result = subprocess.run(["node", str(E2E.with_name("review_fixes.e2e.js"))],
            capture_output=True, text=True, timeout=180,
            env={**os.environ, "BASE_URL": base, "API_TOKEN": TOKEN,
                 "EXPECTED": json.dumps({"dead": dead, "leased": leased, "queued": queued})})
        print(result.stdout)
        print(result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        assert len(report["results"]) == 14
        assert not [r for r in report["results"] if not r["ok"]], report
        assert result.returncode == 0
    finally:
        proc.terminate()
        proc.wait()
