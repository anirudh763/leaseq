#!/usr/bin/env python3
"""Benchmark through the HTTP API: throughput and claim latency with 1, 4 and 8
client processes, each looping claim -> complete with no work in between.

    python scripts/bench.py                 # 2000 jobs per run, 5 runs per setting

Uses (and wipes) its own database "leaseq_bench". Throughput is jobs divided by
the wall time from the common start to the last completion. Latency is the
client-side round trip of POST /jobs/claim for claims that returned a job.
Each figure printed is the median over the repeated runs.
"""
import argparse
import statistics
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

import httpx

import harness


def client_loop(api: str, worker_id: str, start_at: float) -> tuple[list[float], float]:
    """Claim and complete until the queue is empty. -> (claim latencies in s, end time)"""
    latencies = []
    with httpx.Client(base_url=api, timeout=30, headers=harness.auth_headers()) as c:
        c.get("/stats")                                  # open the connection first
        time.sleep(max(0.0, start_at - time.time()))
        while True:
            t0 = time.perf_counter()
            r = c.post("/jobs/claim", json={"worker_id": worker_id, "lease_seconds": 30})
            dt = time.perf_counter() - t0
            if r.status_code == 204:
                return latencies, time.time()
            latencies.append(dt)
            job = r.json()
            done = c.post(f"/jobs/{job['id']}/complete", json={"lease_token": job["lease_token"]})
            assert done.status_code == 200, done.text


def one_run(api: str, workers: int, jobs: int, tag: str) -> dict:
    with httpx.Client(base_url=api, timeout=30, headers=harness.auth_headers()) as c, \
            ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda i: c.post("/jobs", headers={"Idempotency-Key": f"{tag}-{i}"},
                                       json={"kind": "noop"}).raise_for_status(), range(jobs)))
    start_at = time.time() + 1.5                         # time for the processes to spawn
    with ProcessPoolExecutor(workers) as pool:
        futures = [pool.submit(client_loop, api, f"b{i}", start_at) for i in range(workers)]
        results = [f.result() for f in futures]
    latencies = sorted(x for lat, _ in results for x in lat)
    assert len(latencies) == jobs, (len(latencies), jobs)
    wall = max(end for _, end in results) - start_at
    return {"jobs_per_s": jobs / wall,
            "p50_ms": 1000 * latencies[len(latencies) // 2],
            "p99_ms": 1000 * latencies[int(len(latencies) * 0.99)]}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--jobs", type=int, default=2000)
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--workers", type=int, nargs="+", default=[1, 4, 8])
    a = p.parse_args()
    api_proc, api = harness.start_api(harness.scratch_database("leaseq_bench"))
    try:
        one_run(api, 2, 200, "warmup")
        print(f"{a.jobs} jobs per run, median of {a.runs} runs")
        print("workers  jobs/s  claim p50 ms  claim p99 ms")
        for w in a.workers:
            runs = [one_run(api, w, a.jobs, f"w{w}-r{i}") for i in range(a.runs)]
            med = {k: statistics.median(r[k] for r in runs) for k in runs[0]}
            print(f"{w:7d}  {med['jobs_per_s']:6.0f}  {med['p50_ms']:12.2f}  {med['p99_ms']:12.2f}")
    finally:
        api_proc.terminate()
        api_proc.wait()


if __name__ == "__main__":
    main()
