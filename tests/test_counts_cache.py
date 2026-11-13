"""The per-state counts behind the dashboard tabs are a full scan of `jobs`
(96.8 ms at 520k jobs), and every open tab asks for them every 2 s. The API
computes them at most once per COUNTS_MAX_AGE seconds per process and says how
old they are; the job rows themselves are never cached."""
import threading
import time
from datetime import datetime

from leaseq import queue


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_cache_computes_at_most_once_per_max_age():
    clock, calls = FakeClock(), []
    cache = queue.CountsCache(max_age=5.0, clock=clock)

    def compute():
        calls.append(clock.t)
        return {"total": len(calls), "as_of": f"t{len(calls)}"}

    first = cache.get(compute)
    for dt in (0.0, 1.0, 4.99):
        clock.t = 1000.0 + dt
        assert cache.get(compute) == first
    assert len(calls) == 1
    clock.t = 1005.0                                  # exactly max_age old: stale
    assert cache.get(compute)["total"] == 2
    assert len(calls) == 2


def test_zero_max_age_disables_the_cache():
    calls = []
    cache = queue.CountsCache(max_age=0.0)
    for _ in range(3):
        cache.get(lambda: calls.append(1) or {"total": len(calls)})
    assert len(calls) == 3


def test_concurrent_requests_share_one_computation():
    cache, calls = queue.CountsCache(max_age=5.0), []
    barrier = threading.Barrier(8)

    def compute():
        calls.append(1)
        time.sleep(0.2)
        return {"total": 7}

    results = []

    def poll():
        barrier.wait(5)
        results.append(cache.get(compute))

    threads = [threading.Thread(target=poll) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert len(calls) == 1
    assert results == [{"total": 7}] * 8


def test_job_list_counts_are_bounded_stale_and_say_when(client, conn):
    cache = client.app.state.counts_cache
    clock = FakeClock()
    cache.clock = clock
    first = client.get("/jobs").json()
    assert first["counts"]["total"] == 0
    assert first["counts_max_age_seconds"] == queue.COUNTS_MAX_AGE == 5.0
    as_of = datetime.fromisoformat(first["counts_as_of"])
    assert as_of.tzinfo is not None

    new_id = queue.enqueue(conn, "noop", {}, "fresh-row")[0]["id"]
    clock.t += 4.9
    second = client.get("/jobs").json()
    assert [j["id"] for j in second["jobs"]] == [new_id]      # rows are never cached
    assert second["counts"]["total"] == 0                     # counts may lag, by < 5 s
    assert second["counts_as_of"] == first["counts_as_of"]

    clock.t += 0.1
    third = client.get("/jobs").json()
    assert third["counts"]["total"] == 1 and third["counts"]["queued"] == 1
    assert datetime.fromisoformat(third["counts_as_of"]) > as_of
