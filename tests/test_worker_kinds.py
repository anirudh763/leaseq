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


# --- word_count: the one bundled handler that does real work -------------------

def test_word_count_counts_words_and_lines():
    text = "one two  three\nfour\n\nfive six"
    assert worker.handle(job("word_count", 1, text=text), api=None, lease_seconds=30) == \
        {"words": 6, "lines": 4}
    assert worker.handle(job("word_count", 1, text=""), api=None, lease_seconds=30) == \
        {"words": 0, "lines": 0}


def test_word_count_rejects_oversize_or_missing_text():
    big = "a " * (worker.WORD_COUNT_MAX_CHARS // 2) + "x"
    assert len(big) > worker.WORD_COUNT_MAX_CHARS
    with pytest.raises(worker.PermanentJobError, match="10,000"):
        worker.handle(job("word_count", 1, text=big), api=None, lease_seconds=30)
    with pytest.raises(worker.PermanentJobError, match="payload.text must be a string"):
        worker.handle(job("word_count", 1), api=None, lease_seconds=30)
