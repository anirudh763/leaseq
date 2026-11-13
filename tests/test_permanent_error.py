"""PermanentJobError: a handler's way to say "retrying cannot help".

The attempt is recorded as failed, with its reason, and the job goes straight
to 'dead' with a 'dead' audit row, however many attempts it had left. Every
other exception still retries with backoff, and nothing is dropped: the job
stays readable and an operator can requeue it.
"""
import json
import time

import httpx
import pytest

from leaseq import queue, worker


def job(kind, attempts=1, **payload):
    return {"id": 1, "kind": kind, "attempts": attempts, "payload": payload,
            "leased_by": "w1", "lease_token": "tok"}


# --- the handler contract -----------------------------------------------------

def test_word_count_rejects_bad_input_permanently():
    with pytest.raises(worker.PermanentJobError, match="10,000"):
        worker.handle(job("word_count", text="x" * 10_001), api=None, lease_seconds=30)
    with pytest.raises(worker.PermanentJobError, match="must be a string"):
        worker.handle(job("word_count", text=["not", "text"]), api=None, lease_seconds=30)
    # At the limit is fine.
    assert worker.handle(job("word_count", text="x" * 10_000), api=None,
                         lease_seconds=30) == {"words": 1, "lines": 1}


def test_other_handler_errors_are_not_permanent():
    with pytest.raises(RuntimeError) as info:
        worker.handle(job("fail"), api=None, lease_seconds=30)
    assert not isinstance(info.value, worker.PermanentJobError)


# --- what the worker sends ----------------------------------------------------

def _recording_client(sent):
    def reply(request):
        sent.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={})
    return httpx.Client(base_url="http://api", transport=httpx.MockTransport(reply))


def test_worker_marks_only_permanent_errors_permanent():
    sent = []
    api = _recording_client(sent)
    worker.report_failure(api, job("word_count"), worker.PermanentJobError("too long"))
    worker.report_failure(api, job("fail"), RuntimeError("flaky"))
    assert sent[0] == ("/jobs/1/fail", {"lease_token": "tok", "permanent": True,
                                         "error": "PermanentJobError('too long')"})
    # A generic failure sends exactly what it always sent.
    assert sent[1] == ("/jobs/1/fail", {"lease_token": "tok", "error": "RuntimeError('flaky')"})


# --- the queue and the API ----------------------------------------------------

def _events(conn, job_id):
    return conn.execute("SELECT event, attempt, detail FROM job_events WHERE job_id = %s "
                        "ORDER BY id", (job_id,)).fetchall()


def test_permanent_failure_ends_the_job_on_its_first_attempt(conn):
    job_id = queue.enqueue(conn, "word_count", {}, "p1", max_attempts=5)[0]["id"]
    leased = queue.claim(conn, "w1", 30)
    out = queue.fail(conn, job_id, leased["lease_token"], "too long", permanent=True)
    assert (out["state"], out["attempts"], out["max_attempts"]) == ("dead", 1, 5)
    ev = _events(conn, job_id)
    assert [e["event"] for e in ev] == ["enqueued", "claimed", "dead"]
    assert ev[-1]["attempt"] == 1
    assert ev[-1]["detail"] == {"error": "too long", "permanent": True,
                                "reason": "permanent error: not retried"}
    assert queue.claim(conn, "w2", 30) is None                  # nothing left to retry
    # Not dropped: it can be requeued like any dead job.
    assert queue.requeue(conn, job_id, 1)["state"] == "queued"


def test_generic_failure_still_retries_with_backoff(conn):
    job_id = queue.enqueue(conn, "fail", {}, "g1", max_attempts=5)[0]["id"]
    leased = queue.claim(conn, "w1", 30)
    out = queue.fail(conn, job_id, leased["lease_token"], "flaky")
    assert out["state"] == "queued"
    assert _events(conn, job_id)[-1]["event"] == "failed"
    assert _events(conn, job_id)[-1]["detail"]["retry_in_seconds"] > 0


def test_permanent_flag_over_http_is_still_fenced(client, submit, claim):
    a = submit("pa")
    first = claim(lease=0.2)
    time.sleep(0.3)
    second = claim()                                            # the lease was re-issued
    assert second["id"] == a["id"]
    stale = client.post(f"/jobs/{a['id']}/fail",
                        json={"lease_token": first["lease_token"], "error": "x", "permanent": True})
    assert stale.status_code == 409
    assert client.get(f"/jobs/{a['id']}").json()["state"] == "leased"
    ok = client.post(f"/jobs/{a['id']}/fail",
                     json={"lease_token": second["lease_token"], "error": "bad input",
                           "permanent": True})
    assert ok.status_code == 200 and ok.json()["state"] == "dead"
    for loose in ("yes", 1, "true"):                            # a strict boolean only
        assert client.post(f"/jobs/{a['id']}/fail", json={"lease_token": second["lease_token"],
                                                           "permanent": loose}).status_code == 422
