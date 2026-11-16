"""Real worker/API recovery from a lost completion connection, on owned databases."""
import json
import subprocess
import sys
import time
from contextlib import contextmanager
from uuid import uuid4

import httpx
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo

import harness
from leaseq import db


# Instrument only the child worker; handlers, transactions and fencing stay real.
CHILD = r'''
import json, os, sys
import psycopg
from leaseq import worker

api, worker_id, mode, unfenced, log_path = sys.argv[1:]
original_handle, original_finish = worker.handle, worker.finish
calls = 0
first = None

def record(**event):
    with open(log_path, "a") as log:
        log.write(json.dumps(event) + "\n")

def handle(*args):
    record(event="handle", job_id=args[0]["id"])
    return original_handle(*args)

def finish(conn, job, result, worker_id, unfenced=False):
    global calls, first
    calls += 1
    if first is None:
        first = (job, result, job["lease_token"])
    record(event="finish", call=calls, job_id=job["id"],
           same_job=job is first[0], same_result=result is first[1],
           same_token=job["lease_token"] == first[2])
    if mode == "retry_failure" and calls == 2:
        raise psycopg.OperationalError("injected second completion failure")
    outcome = original_finish(conn, job, result, worker_id, unfenced)
    record(event="outcome", call=calls, accepted=outcome)
    if mode == "commit_ack" and calls == 1:
        raise psycopg.OperationalError("injected lost acknowledgement after real commit")
    return outcome

worker.handle, worker.finish = handle, finish
worker.run(api, worker_id, 2.0, 0.02, unfenced == "true", os.environ["LEASEQ_API_TOKEN"])
'''


def wait_for(read, accept, message):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        value = read()
        if accept(value):
            return value
        time.sleep(0.02)
    raise AssertionError(message)


@contextmanager
def running_worker(tmp_path, mode, unfenced=False):
    name = "leaseq_worker_recovery_" + uuid4().hex
    url = harness.scratch_database(name)
    api_proc = proc = None
    try:
        api_proc, api = harness.start_api(url)
        tag = "recovery_" + uuid4().hex
        log_path = tmp_path / "worker.jsonl"
        proc = subprocess.Popen(
            [sys.executable, "-c", CHILD, api, tag, mode,
             str(unfenced).lower(), str(log_path)],
            env=harness.child_env(make_conninfo(url, application_name=tag)), cwd=harness.ROOT)
        with db.connect(url) as conn:
            pid = wait_for(
                lambda: conn.execute(
                    "SELECT pid FROM pg_stat_activity WHERE datname = %s "
                    "AND application_name = %s", (name, tag)).fetchone(),
                bool, "worker did not open its uniquely tagged completion connection")["pid"]
            if mode != "commit_ack":
                assert conn.execute(
                    "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity "
                    "WHERE pid = %s AND datname = %s AND application_name = %s",
                    (pid, name, tag)).fetchone()["terminated"]
            with httpx.Client(base_url=api, headers=harness.auth_headers()) as client:
                response = client.post("/jobs", headers={"Idempotency-Key": tag}, json={
                    "kind": "word_count", "payload": {"text": "one two\nthree"},
                    "max_attempts": 1})
                assert response.status_code == 201, response.text
                job_id = response.json()["id"]
                job = wait_for(
                    lambda: conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,)).fetchone(),
                    lambda row: row["state"] in ("done", "dead"),
                    "job never reached a terminal state")
                # A second finish must be observable even if the first committed.
                if mode == "commit_ack":
                    wait_for(lambda: read_events(log_path),
                             lambda events: any(e.get("call") == 2 for e in events),
                             "lost commit acknowledgement did not retry completion")
                    wait_for(lambda: conn.execute(
                        "SELECT count(*) AS n FROM job_events WHERE job_id = %s "
                        "AND event = 'rejected'", (job_id,)).fetchone()["n"],
                        lambda count: count == 1, "retry did not exercise real fencing")
                yield conn, job, read_events(log_path)
    finally:
        for child in (proc, api_proc):
            if child is not None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
        with db.connect() as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


def read_events(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def assert_run(conn, job, events, *, state, finish_calls, effects, completed):
    assert job["state"] == state
    assert job["attempts"] == job["max_attempts"] == 1
    assert sum(e["event"] == "handle" for e in events) == 1
    finishes = [e for e in events if e["event"] == "finish"]
    assert len(finishes) == finish_calls
    assert all(e["same_job"] and e["same_result"] and e["same_token"] for e in finishes)
    assert conn.execute("SELECT count(*) AS n FROM effects WHERE job_id = %s",
                        (job["id"],)).fetchone()["n"] == effects
    assert conn.execute("SELECT count(*) AS n FROM job_events WHERE job_id = %s "
                        "AND event = 'completed'", (job["id"],)).fetchone()["n"] == completed
    if state == "done":
        assert job["result"] == {"words": 3, "lines": 2}


def test_dead_completion_connection_recovers_without_another_attempt(tmp_path):
    with running_worker(tmp_path, "terminated") as (conn, job, events):
        assert_run(conn, job, events, state="done", finish_calls=2, effects=1, completed=1)


def test_lost_commit_acknowledgement_retries_same_completion_without_duplicate(tmp_path):
    with running_worker(tmp_path, "commit_ack") as (conn, job, events):
        assert_run(conn, job, events, state="done", finish_calls=2, effects=1, completed=1)
        assert [e["accepted"] for e in events if e["event"] == "outcome"] == [True, False]


@pytest.mark.parametrize("mode,unfenced,finish_calls", [
    ("terminated", True, 1),
    ("retry_failure", False, 2),
])
def test_completion_retry_is_fenced_and_bounded(tmp_path, mode, unfenced, finish_calls):
    with running_worker(tmp_path, mode, unfenced) as (conn, job, events):
        assert_run(conn, job, events, state="dead", finish_calls=finish_calls,
                   effects=0, completed=0)
