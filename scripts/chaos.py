#!/usr/bin/env python3
"""Fault-injection run: enqueue N jobs, run worker processes, SIGKILL a random
worker at random intervals (restarting it each time) until K kills have been
delivered, then check that nothing was lost and nothing was done twice.

    python scripts/chaos.py                      # full size: 2000 jobs, 50 kills
    python scripts/chaos.py --jobs 300 --kills 12
    python scripts/chaos.py --unfenced --kills 0 # negative control: must FAIL

Uses (and wipes) its own database "leaseq_chaos" on the server named by
LEASEQ_DATABASE_URL. The seed fixes the job payloads, which worker is killed
and the gaps between kills. It cannot fix OS scheduling, so which job a kill
lands on differs between runs; the invariants must hold on every run.
"""
import argparse
import json
import random
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

import harness
from leaseq import db


def run_chaos(jobs: int = 2000, kills: int = 50, workers: int = 4, seed: int = 1,
              lease_seconds: float = 1.0, kill_gap: tuple[float, float] = (0.1, 0.5),
              stall_fraction: float = 0.02, unfenced: bool = False,
              timeout: float = 600.0) -> dict:
    rng = random.Random(seed)
    stall_ms = int(lease_seconds * 1500)      # long enough to outlive the lease
    payloads = [{"ms": rng.randint(5, 40),
                 "stall_ms": stall_ms if rng.random() < stall_fraction else 0}
                for _ in range(jobs)]

    db_url = harness.scratch_database("leaseq_chaos")
    api_proc, api = harness.start_api(db_url)
    procs = []
    try:
        with httpx.Client(base_url=api, timeout=30, headers=harness.auth_headers()) as client:
            def submit(i):
                r = client.post("/jobs", headers={"Idempotency-Key": f"chaos-{seed}-{i}"},
                                json={"kind": "sleep", "payload": payloads[i],
                                      "max_attempts": 25})
                assert r.status_code == 201, r.text
            with ThreadPoolExecutor(8) as pool:
                list(pool.map(submit, range(jobs)))

        conn = db.connect(db_url)
        started = time.monotonic()
        procs = [harness.start_worker(db_url, api, f"w{i}", lease_seconds, unfenced)
                 for i in range(workers)]
        delivered = 0
        next_kill = started + rng.uniform(*kill_gap)
        while True:
            unfinished = conn.execute(
                "SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'leased')"
            ).fetchone()["n"]
            now = time.monotonic()
            if unfinished == 0:
                break
            if now - started > timeout:
                raise TimeoutError(f"{unfinished} jobs unfinished after {timeout}s")
            if delivered < kills and now >= next_kill:
                victim = rng.randrange(workers)
                procs[victim].send_signal(signal.SIGKILL)     # no cleanup, no goodbye
                procs[victim].wait()
                procs[victim] = harness.start_worker(db_url, api, f"w{victim}",
                                                     lease_seconds, unfenced)
                delivered += 1
                next_kill = time.monotonic() + rng.uniform(*kill_gap)
            time.sleep(0.02)
        elapsed = time.monotonic() - started
        # Stalled (zombie) workers may still be about to attempt a completion.
        # Give them time to try before judging; ending early would hide them.
        time.sleep(stall_ms / 1000 + 0.5)
        return {"jobs": jobs, "kills_requested": kills, "kills_delivered": delivered,
                "workers": workers, "seed": seed, "lease_seconds": lease_seconds,
                "elapsed_seconds": round(elapsed, 2), **verify(conn, jobs, kills, delivered)}
    finally:
        for p in procs + [api_proc]:
            p.terminate()
        for p in procs + [api_proc]:
            p.wait()


def verify(conn, jobs: int, kills: int, delivered: int) -> dict:
    """Read the final database state and list every broken invariant."""
    one = lambda q: conn.execute(q).fetchone()["n"]  # noqa: E731
    r = {
        "done": one("SELECT count(*) AS n FROM jobs WHERE state = 'done'"),
        "dead": one("SELECT count(*) AS n FROM jobs WHERE state = 'dead'"),
        "effect_rows": one("SELECT count(*) AS n FROM effects"),
        "jobs_with_effect": one("SELECT count(DISTINCT job_id) AS n FROM effects"),
        "completed_events": one("SELECT count(*) AS n FROM job_events WHERE event = 'completed'"),
        "jobs_completed_more_than_once": one(
            "SELECT count(*) AS n FROM (SELECT job_id FROM job_events WHERE event = 'completed' "
            "GROUP BY job_id HAVING count(*) > 1) t"),
        "jobs_needing_more_than_one_attempt": one(
            "SELECT count(*) AS n FROM jobs WHERE attempts > 1"),
        "max_attempts_used": one("SELECT coalesce(max(attempts), 0) AS n FROM jobs"),
        "expired_leases_taken_over": one(
            "SELECT count(*) AS n FROM job_events WHERE event = 'claimed' "
            "AND detail ? 'took_over_expired_lease_of'"),
        "stale_completions_rejected": one(
            "SELECT count(*) AS n FROM job_events WHERE event = 'rejected'"),
        "claims_in_audit_log": one("SELECT count(*) AS n FROM job_events WHERE event = 'claimed'"),
        "sum_of_attempts": one("SELECT coalesce(sum(attempts), 0) AS n FROM jobs"),
    }
    checks = {
        "every job is done": r["done"] == jobs,
        "exactly one effect row per job": r["effect_rows"] == jobs == r["jobs_with_effect"],
        "no job completed twice in job_events": r["jobs_completed_more_than_once"] == 0
                                                and r["completed_events"] == jobs,
        "audit log has one claim per attempt": r["claims_in_audit_log"] == r["sum_of_attempts"],
        "requested number of kills delivered": delivered >= kills,
    }
    r["violations"] = [name for name, ok in checks.items() if not ok]
    return r


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--jobs", type=int, default=2000)
    p.add_argument("--kills", type=int, default=50)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--lease-seconds", type=float, default=1.0)
    p.add_argument("--stall-fraction", type=float, default=0.02)
    p.add_argument("--unfenced", action="store_true",
                   help="negative control: workers skip the lease-token check")
    a = p.parse_args()
    report = run_chaos(a.jobs, a.kills, a.workers, a.seed, a.lease_seconds,
                       stall_fraction=a.stall_fraction, unfenced=a.unfenced)
    print(json.dumps(report, indent=2))
    print(f"\nN={report['jobs']} jobs, K={report['kills_delivered']} SIGKILLs, "
          f"{report['jobs_needing_more_than_one_attempt']} jobs needed more than one attempt, "
          f"{report['elapsed_seconds']} s")
    print("RESULT:", "FAIL " + "; ".join(report["violations"]) if report["violations"]
          else "PASS (no job lost, no job completed twice)")
    return 1 if report["violations"] else 0


if __name__ == "__main__":
    sys.exit(main())
