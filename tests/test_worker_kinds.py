"""The job kinds the bundled worker understands (no HTTP needed for these)."""
import pytest

from leaseq import worker


def job(kind, attempts, **payload):
    return {"id": 1, "kind": kind, "attempts": attempts, "payload": payload,
            "leased_by": "w1", "lease_token": "t"}


def test_fail_first_n_fails_exactly_n_times_then_succeeds():
    for attempt in (1, 2):
        with pytest.raises(RuntimeError, match=f"attempt {attempt} fails on purpose"):
            worker.handle(job("fail_first_n", attempt, n=2), api=None, lease_seconds=30)
    assert worker.handle(job("fail_first_n", 3, n=2), api=None, lease_seconds=30) == {"worker": "w1"}


def test_fail_first_n_defaults_to_one_failure():
    with pytest.raises(RuntimeError):
        worker.handle(job("fail_first_n", 1), api=None, lease_seconds=30)
    assert worker.handle(job("fail_first_n", 2), api=None, lease_seconds=30) == {"worker": "w1"}
