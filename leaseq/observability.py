"""Bounded HTTP telemetry and per-process admission control."""

import json
import logging
import math
import re
import threading
import time
import uuid
from collections import defaultdict

from . import security

log = logging.getLogger("leaseq.requests")
_JOBS = re.compile(
    r"^/jobs/[0-9]+(?:/(events|heartbeat|complete|fail|requeue|cancel))?$"
)
_CORRELATION = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_ROUTES = {
    "/",
    "/jobs",
    "/jobs/claim",
    "/demo/jobs",
    "/stats",
    "/auth/check",
    "/metrics",
    "/healthz",
    "/livez",
    "/readyz",
    "/docs",
    "/openapi.json",
}
_HEALTH = {"/healthz", "/livez", "/readyz"}
_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10)


def configure_logging():
    """Emit JSON to stderr even when the host has not configured a root handler."""
    if not log.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        log.addHandler(handler)
    log.setLevel(logging.INFO)


def route_label(path):
    if path in _ROUTES:
        return path
    match = _JOBS.fullmatch(path)
    if match:
        return "/jobs/{job_id}" + ("/" + match[1] if match[1] else "")
    if security._under(path, ("/dashboard",)):
        return "/dashboard/*"
    return "/unmatched"


class RateBuckets:
    """Token buckets, with separate bounded maps for authenticated/public clients.

    A full active map rejects new clients rather than evicting an active bucket
    and granting another burst. Forwarded addresses are deliberately not used.
    This is one API process's budget, not a distributed global spending cap.
    """

    def __init__(
        self, auth_limit=60000, public_limit=120, max_clients=4096, clock=time.monotonic
    ):
        self.limits = {True: auth_limit, False: public_limit}
        self.max_clients, self.clock = max_clients, clock
        self.groups = {True: {}, False: {}}
        self.lock = threading.Lock()

    @property
    def size(self):
        with self.lock:
            return sum(len(group) for group in self.groups.values())

    def allow(self, client, authenticated):
        now = self.clock()
        limit = self.limits[authenticated]
        with self.lock:
            group = self.groups[authenticated]
            if client not in group:
                if len(group) >= self.max_clients:
                    for key in [
                        key for key, value in group.items() if now - value[1] >= 60
                    ]:
                        del group[key]
                    if len(group) >= self.max_clients:
                        return 60
                group[client] = (float(limit), now)
            tokens, previous = group[client]
            tokens = min(float(limit), tokens + max(0, now - previous) * limit / 60)
            if tokens < 1:
                group[client] = (tokens, now)
                return max(1, min(60, math.ceil((1 - tokens) * 60 / limit)))
            group[client] = (tokens - 1, now)
            return 0


class RateLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or security._under(scope["path"], ("/dashboard",)):
            return await self.app(scope, receive, send)
        state = scope["app"].state
        limiter = getattr(state, "rate_limiter", None)
        settings = getattr(state, "settings", None)
        if limiter and settings:
            client = (scope.get("client") or ("unknown",))[0]
            if scope["path"] in _HEALTH:
                limiter, accepted = state.probe_limiter, False
            else:
                accepted = security.authenticated(scope, settings)
            retry = limiter.allow(client, accepted)
            if retry:
                return await security._reply(
                    send,
                    429,
                    b'{"detail":"request rate exceeded; retry after the indicated delay"}',
                    [(b"retry-after", str(retry).encode())],
                )
        await self.app(scope, receive, send)


class Metrics:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = defaultdict(int)
        self.durations = {}

    def record(self, method, route, status, seconds):
        with self.lock:
            self.requests[method, route, status] += 1
            value = self.durations.setdefault(
                (method, route), [0, 0.0, [0] * len(_BUCKETS)]
            )
            value[0] += 1
            value[1] += seconds
            for i, bound in enumerate(_BUCKETS):
                value[2][i] += seconds <= bound

    def render(self, counts):
        lines = [
            "# HELP leaseq_http_requests_total HTTP responses observed in this API process.",
            "# TYPE leaseq_http_requests_total counter",
        ]
        with self.lock:
            for (method, route, status), count in sorted(self.requests.items()):
                lines.append(
                    f'leaseq_http_requests_total{{method="{method}",route="{route}",status="{status}"}} {count}'
                )
            lines += [
                "# HELP leaseq_http_request_duration_seconds HTTP duration including middleware, per API process.",
                "# TYPE leaseq_http_request_duration_seconds histogram",
            ]
            for (method, route), (count, total, buckets) in sorted(
                self.durations.items()
            ):
                labels = f'method="{method}",route="{route}"'
                for bound, value in zip(_BUCKETS, buckets):
                    lines.append(
                        f'leaseq_http_request_duration_seconds_bucket{{{labels},le="{bound}"}} {value}'
                    )
                lines += [
                    f'leaseq_http_request_duration_seconds_bucket{{{labels},le="+Inf"}} {count}',
                    f"leaseq_http_request_duration_seconds_count{{{labels}}} {count}",
                    f"leaseq_http_request_duration_seconds_sum{{{labels}}} {total:.9f}",
                ]
            rejected = self.requests.get(("POST", "/jobs/{job_id}/complete", 409), 0)
        lines += [
            "# HELP leaseq_stale_completions_rejected_total HTTP completion lease rejections since process start; direct DB callers excluded.",
            "# TYPE leaseq_stale_completions_rejected_total counter",
            f"leaseq_stale_completions_rejected_total {rejected}",
            "# HELP leaseq_queue_depth Database counts cached by this process; retrying is a subset of queued.",
            "# TYPE leaseq_queue_depth gauge",
        ]
        for name in ("queued", "leased", "retrying", "done", "dead"):
            lines.append(f'leaseq_queue_depth{{state="{name}"}} {counts[name]}')
        lines += [
            "# HELP leaseq_expired_leases Current expired leases in the cached database snapshot, not cumulative expirations.",
            "# TYPE leaseq_expired_leases gauge",
            f"leaseq_expired_leases {counts['expired_leases']}",
            "# TYPE leaseq_queue_snapshot_timestamp_seconds gauge",
            f"leaseq_queue_snapshot_timestamp_seconds {counts['as_of'].timestamp():.6f}",
        ]
        return "\n".join(lines) + "\n"


class RequestTelemetry:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        supplied = (
            dict(scope["headers"]).get(b"x-correlation-id", b"").decode("latin-1")
        )
        correlation = (
            supplied if _CORRELATION.fullmatch(supplied) else str(uuid.uuid4())
        )
        scope.setdefault("state", {})["correlation_id"] = correlation
        started, status = time.monotonic(), 500

        async def observed_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() != b"x-correlation-id"
                ]
                message = {
                    **message,
                    "headers": [*headers, (b"x-correlation-id", correlation.encode())],
                }
            await send(message)

        try:
            await self.app(scope, receive, observed_send)
        finally:
            seconds = max(0, time.monotonic() - started)
            method = (
                scope["method"]
                if scope["method"]
                in {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"}
                else "OTHER"
            )
            route = route_label(scope["path"])
            metrics = getattr(scope["app"].state, "metrics", None)
            if metrics:
                metrics.record(method, route, status, seconds)
            log.info(
                json.dumps(
                    {
                        "event": "http_request",
                        "correlation_id": correlation,
                        "method": method,
                        "route": route,
                        "status": status,
                        "duration_ms": round(seconds * 1000, 3),
                    },
                    separators=(",", ":"),
                )
            )
