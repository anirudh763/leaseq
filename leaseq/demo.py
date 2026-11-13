"""Enqueue sample jobs so the dashboard has something to show.

    python -m leaseq.demo --api http://127.0.0.1:8000            # one batch
    python -m leaseq.demo --api http://app:8000 --trickle-minutes 10

The jobs use the kinds the bundled worker understands (see worker.handle):
`sleep` works for `ms` milliseconds while heartbeating, `fail` always raises,
anything else finishes at once. With one worker a batch takes about a minute,
so jobs can be watched moving from queued to running to done, and the `fail`
jobs retry with backoff before ending up dead.
"""
import argparse
import os
import random
import sys
import time
import uuid

import httpx


def sample_jobs(batch: str | None = None) -> list[dict]:
    """One batch: 16 jobs. Idempotency keys are unique per batch."""
    batch = batch or uuid.uuid4().hex[:8]
    jobs = []
    for i, ms in enumerate([1800, 2500, 1200, 4000, 3000, 2200, 1500, 5000]):
        jobs.append({"kind": "sleep", "payload": {"ms": ms, "note": f"demo sleep {i + 1}"},
                     "max_attempts": 5})
    for name in ("thumbnail.resize", "report.render", "email.send", "index.rebuild"):
        jobs.append({"kind": name, "payload": {"demo": True, "batch": batch},
                     "max_attempts": 5})
    for error, attempts in (("upstream returned 503", 3), ("invalid input: missing 'to'", 2),
                            ("timeout after 30 s", 1)):
        jobs.append({"kind": "fail", "payload": {"error": error}, "max_attempts": attempts})
    # Untrusted text in a payload: the dashboard must show it as text, not markup.
    jobs.append({"kind": "sleep",
                 "payload": {"ms": 800, "note": "<b>payloads are shown as text</b>"},
                 "max_attempts": 5})
    for i, job in enumerate(jobs):
        job["key"] = f"demo-{batch}-{i:02d}"
    return jobs


def _headers(token: str | None) -> dict:
    return {"Authorization": f"Bearer {token}"} if token else {}


def wait_for_api(client: httpx.Client, seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            if client.get("/healthz").status_code == 200:
                return
        except httpx.HTTPError:
            pass
        if time.monotonic() > deadline:
            raise SystemExit(f"API at {client.base_url} did not answer within {seconds:.0f} s")
        time.sleep(1)


def enqueue(client: httpx.Client, jobs: list[dict]) -> int:
    created = 0
    for job in jobs:
        r = client.post("/jobs", headers={"Idempotency-Key": job["key"]},
                        json={k: job[k] for k in ("kind", "payload", "max_attempts")})
        if r.status_code == 401:
            raise SystemExit("the API needs a token: set LEASEQ_API_TOKEN or pass --token")
        r.raise_for_status()
        created += r.status_code == 201
    return created


def main() -> int:
    p = argparse.ArgumentParser(description="enqueue sample jobs for the leaseq dashboard")
    p.add_argument("--api", default="http://127.0.0.1:8000")
    p.add_argument("--token", default=os.environ.get("LEASEQ_API_TOKEN"),
                   help="bearer token (default: $LEASEQ_API_TOKEN)")
    p.add_argument("--trickle-minutes", type=float, default=0,
                   help="after the first batch, add 1-3 jobs every few seconds for this long")
    a = p.parse_args()
    with httpx.Client(base_url=a.api, headers=_headers(a.token), timeout=10) as client:
        wait_for_api(client)
        print(f"enqueued {enqueue(client, sample_jobs())} sample jobs", flush=True)
        rng = random.Random(1)      # demo pacing only; nothing here is security-relevant
        until = time.monotonic() + a.trickle_minutes * 60
        while time.monotonic() < until:
            time.sleep(rng.uniform(3, 8))
            batch = rng.sample(sample_jobs(), rng.randint(1, 3))
            enqueue(client, batch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
