"""Small HTTP task SDK. Fencing cannot undo external effects: use ``job_key`` as
the downstream idempotency key or write an outbox entry in the same transaction.
"""
import json
import re
import threading
from dataclasses import dataclass

import httpx

MAX_REQUEST_BYTES = 65_536
MAX_RESPONSE_BYTES = 131_072
KIND_NAME = re.compile(r"[A-Za-z0-9_.:-]{1,100}")


class LeaseQError(RuntimeError):
    pass


class AuthenticationError(LeaseQError):
    pass


class PermanentTaskError(Exception):
    pass


@dataclass(frozen=True)
class TaskContext:
    job_id: int
    job_key: str
    worker_id: str
    stop: threading.Event


class TaskRegistry:
    def __init__(self):
        self.handlers = {}

    def task(self, kind):
        if not isinstance(kind, str) or not KIND_NAME.fullmatch(kind) or kind in self.handlers:
            raise ValueError("task kind must be a unique API-compatible name (1 to 100 characters)")

        def register(handler):
            if len(self.handlers) >= 64:
                raise ValueError("register at most 64 task kinds per worker")
            if not callable(handler) or kind in self.handlers:
                raise ValueError("task kind must have a unique callable handler")
            self.handlers[kind] = handler
            return handler
        return register


class LeaseQClient:
    def __init__(self, api_url, token, timeout=10):
        if not token:
            raise ValueError("token is required")
        self.http = httpx.Client(base_url=api_url.rstrip("/"), timeout=timeout,
                                 follow_redirects=False,
                                 headers={"Authorization": f"Bearer {token}"})

    def close(self):
        self.http.close()

    def request(self, method, path, *, body=None, headers=None, no_content=False):
        raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
        if raw is not None and len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("request exceeds 65536 bytes")
        with self.http.stream(method, path, content=raw,
                              headers={"Content-Type": "application/json", **(headers or {})}) as r:
            if r.status_code == 401:
                raise AuthenticationError("LeaseQ rejected the API token")
            data = bytearray()
            for chunk in r.iter_bytes():
                data.extend(chunk)
                if len(data) > MAX_RESPONSE_BYTES:
                    raise LeaseQError("LeaseQ response exceeds the 131072-byte limit")
            if no_content and r.status_code == 204:
                return None
            if not 200 <= r.status_code < 300:
                raise LeaseQError(f"LeaseQ request failed with HTTP {r.status_code}")
            return json.loads(data) if data else None

    def submit(self, kind, payload, *, idempotency_key, priority=0,
               max_attempts=5, run_after=None, delay_seconds=None):
        body = {"kind": kind, "payload": payload, "priority": priority,
                "max_attempts": max_attempts}
        if run_after is not None:
            body["run_after"] = run_after.isoformat() if hasattr(run_after, "isoformat") else run_after
        if delay_seconds is not None:
            body["delay_seconds"] = delay_seconds
        return self.request("POST", "/jobs", body=body,
                            headers={"Idempotency-Key": idempotency_key})

    def claim(self, worker_id, kinds, lease_seconds=30):
        return self.request("POST", "/jobs/claim", body={"worker_id": worker_id,
            "lease_seconds": lease_seconds, "kinds": kinds}, no_content=True)

    def heartbeat(self, job, lease_seconds=30):
        return self.request("POST", f"/jobs/{job['id']}/heartbeat", body={
            "lease_token": job["lease_token"], "lease_seconds": lease_seconds})

    def complete(self, job, result=None):
        return self.request("POST", f"/jobs/{job['id']}/complete", body={
            "lease_token": job["lease_token"], "result": result})

    def fail(self, job, error, permanent=False):
        return self.request("POST", f"/jobs/{job['id']}/fail", body={
            "lease_token": job["lease_token"], "error": error,
            "permanent": permanent})


def run_worker(client, registry, worker_id, stop, lease_seconds=30, poll_seconds=.2):
    """Poll only registered kinds, heartbeat during work, and stop between tasks."""
    kinds = sorted(registry.handlers)
    if not kinds:
        raise ValueError("register at least one task before starting a worker")
    if len(kinds) > 64 or any(not isinstance(kind, str) or not KIND_NAME.fullmatch(kind) or not callable(registry.handlers[kind]) for kind in kinds):
        raise ValueError("workers accept at most 64 API-compatible kinds with callable handlers")
    while not stop.is_set():
        job = client.request("POST", "/jobs/claim", body={"worker_id": worker_id,
            "lease_seconds": lease_seconds, "kinds": kinds}, no_content=True)
        if job is None:
            stop.wait(poll_seconds)
            continue
        lost = threading.Event()
        finished = threading.Event()

        def heartbeat_loop():
            while not finished.wait(max(.1, lease_seconds / 3)):
                try:
                    client.heartbeat(job, lease_seconds)
                except LeaseQError:
                    lost.set()
                    return

        heartbeat = threading.Thread(target=heartbeat_loop, daemon=True)
        heartbeat.start()
        context = TaskContext(job["id"], job["idempotency_key"], worker_id, stop)
        try:
            result = registry.handlers[job["kind"]](job, context)
            if lost.is_set():
                continue
            client.complete(job, result)
        except Exception as exc:
            if not lost.is_set():
                client.fail(job, type(exc).__name__, isinstance(exc, PermanentTaskError))
        finally:
            finished.set()
            lost.set()
            heartbeat.join(timeout=1)
