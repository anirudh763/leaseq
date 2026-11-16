"""HTTP API. A thin layer: validate input, call queue.py, map results to status codes.

Access control (security.Auth, applied to every request before its body is read):
  * The API refuses to start unless LEASEQ_API_TOKEN is set (16+ characters).
  * Every request needs `Authorization: Bearer <token>`, except the paths in
    security.OPEN_PATHS (health check, dashboard files, API docs), which hold no
    job data. Anything not listed there is protected by default.
  * LEASEQ_PUBLIC_READ=1 opens the GET endpoints under /stats and /jobs. Writes,
    worker calls and operator actions always need the token.
"""
import logging
import asyncio
import math
import re
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime
from pathlib import Path
from typing import Literal

import psycopg
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, StrictBool, StrictInt, field_validator, model_validator

from . import __version__, db, demo, queue, security, observability, operations, scheduling

log = logging.getLogger("leaseq.api")

DASHBOARD = Path(__file__).with_name("dashboard")
BIGINT_MAX = 2**63 - 1

# Allow-lists for identifiers. Kinds and worker ids are names chosen by the
# operator, so a short printable set is enough and keeps them safe to display.
KIND_PATTERN = r"^[A-Za-z0-9_.:-]+$"
WORKER_PATTERN = r"^[A-Za-z0-9_.:@/-]+$"
TOKEN_PATTERN = r"^[A-Za-z0-9_-]+$"      # secrets.token_urlsafe alphabet


@asynccontextmanager
async def lifespan(app: FastAPI):
    observability.configure_logging()
    app.state.settings = security.load_settings()      # raises without a token
    app.state.rate_limiter = observability.RateBuckets(
        auth_limit=app.state.settings.rate_limit,
        public_limit=app.state.settings.public_rate_limit)
    app.state.probe_limiter = observability.RateBuckets(
        auth_limit=120, public_limit=120, max_clients=256)
    app.state.metrics = observability.Metrics()
    app.state.started_at = time.monotonic()
    pool = db.make_pool()
    app.state.pool = pool
    app.state.counts_cache = queue.CountsCache(queue.COUNTS_MAX_AGE)
    app.state.operations_metrics_cache = operations.MetricsCache()
    with pool.connection() as conn:
        db.apply_schema(conn)
    async def scheduler_loop():
        while True:
            try:
                await asyncio.to_thread(_dispatch_schedules, pool)
            except Exception:
                log.warning("schedule dispatch failed")
            await asyncio.sleep(1)
    scheduler_task = asyncio.create_task(scheduler_loop())
    yield
    scheduler_task.cancel()
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass
    pool.close()


def _dispatch_schedules(pool):
    with pool.connection() as conn:
        scheduling.dispatch_due(conn, 10)


app = FastAPI(title="leaseq", version=__version__, lifespan=lifespan)
# The last middleware added runs first: telemetry and headers wrap admission,
# auth and the body cap. Unauthorized bodies are never parsed.
app.add_middleware(security.BodyLimit)
app.add_middleware(security.Auth)
app.add_middleware(observability.RateLimit)
app.add_middleware(security.SecurityHeaders)
app.add_middleware(observability.RequestTelemetry)


# JSON nested deeper than this is refused with 422 before any database work.
# Without a limit, a ~2 KB body nested 1,000 deep was stored and then every
# response containing it failed with a RecursionError (500), including claim,
# whose lease had already been committed. 64 levels is far more than any
# real payload needs.
MAX_JSON_DEPTH = 64


def check_json_depth(value):
    """Walk dicts and lists without recursion; raise if nesting exceeds MAX_JSON_DEPTH."""
    stack = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, (dict, list)):
            if depth > MAX_JSON_DEPTH:
                raise ValueError(f"JSON is nested more than {MAX_JSON_DEPTH} levels deep")
            children = item.values() if isinstance(item, dict) else item
            stack.extend((child, depth + 1) for child in children)
    return value


class JobIn(BaseModel):
    kind: str = Field(min_length=1, max_length=100, pattern=KIND_PATTERN)
    payload: dict = {}

    _payload_depth = field_validator("payload")(check_json_depth)
    max_attempts: int = Field(default=5, ge=1, le=100)
    priority: int = Field(default=0, ge=-100, le=100, strict=True)
    run_after: datetime | None = None
    delay_seconds: float | None = Field(default=None, ge=0, le=31_536_000, allow_inf_nan=False)

    @field_validator("run_after")
    @classmethod
    def timezone_required(cls, value):
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("run_after must include a timezone")
        return value

    @field_validator("delay_seconds")
    @classmethod
    def delay_finite(cls, value):
        if value is not None and not math.isfinite(value):
            raise ValueError("delay_seconds must be finite")
        return value

    @model_validator(mode="after")
    def schedule_exclusive(self):
        if self.run_after is not None and self.delay_seconds is not None:
            raise ValueError("run_after and delay_seconds cannot be used together")
        return self


class ClaimIn(BaseModel):
    worker_id: str = Field(min_length=1, max_length=200, pattern=WORKER_PATTERN)
    lease_seconds: float = Field(default=30, gt=0, le=3600, allow_inf_nan=False)
    kinds: list[str] | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("kinds")
    @classmethod
    def valid_kinds(cls, value):
        if value is not None and (len(set(value)) != len(value) or any(
                not kind or len(kind) > 100 or not re.fullmatch(KIND_PATTERN, kind)
                for kind in value)):
            raise ValueError("kinds must be unique valid names")
        return value


class BulkIn(BaseModel):
    action: Literal["requeue", "cancel"]
    job_ids: list[StrictInt] = Field(min_length=1, max_length=100)

    @field_validator("job_ids")
    @classmethod
    def safe_ids(cls, value):
        if any(type(item) is not int or item < 1 or item > 2**53 - 1 for item in value) or len(set(value)) != len(value):
            raise ValueError("job_ids must be unique positive safe integers")
        return value


class ScheduleIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: str = Field(min_length=1, max_length=100, pattern=KIND_PATTERN)
    payload: dict
    cron: str = Field(min_length=1, max_length=100)
    priority: int = Field(default=0, ge=-100, le=100, strict=True)
    max_attempts: int = Field(default=5, ge=1, le=100)

    _payload_depth = field_validator("payload")(check_json_depth)


class ScheduleEnabledIn(BaseModel):
    enabled: bool


class HeartbeatIn(BaseModel):
    lease_token: str = Field(min_length=1, max_length=64, pattern=TOKEN_PATTERN)
    lease_seconds: float = Field(default=30, gt=0, le=3600, allow_inf_nan=False)


class CompleteIn(BaseModel):
    lease_token: str = Field(min_length=1, max_length=64, pattern=TOKEN_PATTERN)
    result: dict | None = None

    _result_depth = field_validator("result")(check_json_depth)


class FailIn(BaseModel):
    lease_token: str = Field(min_length=1, max_length=64, pattern=TOKEN_PATTERN)
    error: str = Field(default="", max_length=4000)
    # True: retrying cannot help (the handler raised PermanentJobError); the job
    # goes to 'dead' now. Optional, so existing workers are unaffected.
    permanent: StrictBool = False


class RequeueIn(BaseModel):
    extra_attempts: int = Field(default=3, ge=1, le=100)


class CancelIn(BaseModel):
    reason: str = Field(default="", max_length=500)


LEASE_LOST = HTTPException(409, "lease token is not the current lease for this job")



@app.exception_handler(queue.JobNotFound)
def not_found(request: Request, exc: queue.JobNotFound):
    return JSONResponse({"detail": "job not found"}, status_code=404)


@app.exception_handler(RequestValidationError)
def invalid_request(request: Request, exc: RequestValidationError):
    # FastAPI's default 422 body echoes each rejected input back. That fails
    # with a 500 when the input is NaN or Infinity (not valid JSON), and it
    # reflects up to the whole body limit back to the caller. Say where and why only.
    errors = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")}
              for e in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.exception_handler(psycopg.errors.DataError)
def data_error(request: Request, exc: psycopg.errors.DataError):
    # SQLSTATE class 22: the database refused a value it was sent, e.g. a NUL
    # character or a lone surrogate inside a JSON string. That is the client's
    # input, not a server fault. The database message stays in the server log.
    log.info("rejected input on %s: %s", request.url.path, exc)
    return JSONResponse({"detail": "a value in the request cannot be stored "
                                   "(for example a NUL character in a string)"},
                        status_code=422)


# Handlers are plain `def`, so FastAPI runs them in its thread pool and the
# blocking psycopg calls do not stall the event loop.

@app.post("/jobs")
def submit(body: JobIn, request: Request, response: Response,
           idempotency_key: str = Header(min_length=1, max_length=200)):
    if idempotency_key.startswith("_leaseq_schedule/"):
        raise HTTPException(422, "Idempotency-Key uses a reserved prefix")
    with request.app.state.pool.connection() as conn:
        job, created = queue.enqueue(conn, body.kind, body.payload, idempotency_key,
                                     body.max_attempts, body.priority, body.run_after,
                                     body.delay_seconds)
    response.status_code = 201 if created else 200
    return job


@app.post("/jobs/claim")
def claim(body: ClaimIn, request: Request):
    with request.app.state.pool.connection() as conn:
        job = queue.claim(conn, body.worker_id, body.lease_seconds, body.kinds)
    return job if job is not None else Response(status_code=204)


@app.post("/jobs/{job_id}/heartbeat")
def heartbeat(job_id: int, body: HeartbeatIn, request: Request):
    with request.app.state.pool.connection() as conn:
        job = queue.heartbeat(conn, job_id, body.lease_token, body.lease_seconds)
    if job is None:
        raise LEASE_LOST
    return job


@app.post("/jobs/{job_id}/complete")
def complete(job_id: int, body: CompleteIn, request: Request):
    with request.app.state.pool.connection() as conn:
        job = queue.complete(conn, job_id, body.lease_token, body.result)
    if job is None:
        raise LEASE_LOST
    return job


@app.post("/jobs/{job_id}/fail")
def fail(job_id: int, body: FailIn, request: Request):
    with request.app.state.pool.connection() as conn:
        job = queue.fail(conn, job_id, body.lease_token, body.error, permanent=body.permanent)
    if job is None:
        raise LEASE_LOST
    return job


# --- operator actions (dashboard) --------------------------------------------

@app.post("/jobs/{job_id}/requeue")
def requeue(job_id: int, request: Request, body: RequeueIn | None = None):
    body = body or RequeueIn()
    with request.app.state.pool.connection() as conn:
        job = queue.requeue(conn, job_id, body.extra_attempts)
    if job is None:
        raise HTTPException(409, "only dead jobs can be requeued")
    return job


@app.post("/jobs/{job_id}/cancel")
def cancel(job_id: int, request: Request, body: CancelIn | None = None):
    body = body or CancelIn()
    with request.app.state.pool.connection() as conn:
        job = queue.cancel(conn, job_id, body.reason)
    if job is None:
        raise HTTPException(409, "only queued or leased jobs can be cancelled")
    return job


@app.post("/jobs/bulk")
def bulk_jobs(body: BulkIn, request: Request):
    with request.app.state.pool.connection() as conn:
        return operations.bulk(conn, body.action, body.job_ids)


@app.get("/auth/check")
def auth_check():
    """200 if the bearer token is right, 401 if not (even with LEASEQ_PUBLIC_READ=1).
    The dashboard calls this before it shows any operator buttons."""
    return {"ok": True}


@app.post("/demo/jobs", status_code=201)
def sample_jobs(request: Request):
    """Enqueue the same sample jobs as `python -m leaseq.demo`, for an empty dashboard."""
    with request.app.state.pool.connection() as conn:
        created = [queue.enqueue(conn, j["kind"], j["payload"], j["key"], j["max_attempts"])[0]
                   for j in demo.sample_jobs()]
    return {"enqueued": len(created)}


@contextmanager
def read_connection(request: Request):
    """Bound connection acquisition and each query without changing pooled session defaults."""
    try:
        with request.app.state.pool.connection(timeout=2) as conn:
            with conn.transaction():
                conn.execute("SET LOCAL statement_timeout = '5s'")
                yield conn
    except psycopg.OperationalError:
        raise HTTPException(503, "Database read unavailable; retry later.") from None


# --- reads -------------------------------------------------------------------

@app.get("/livez")
def livez():
    """The HTTP process is running; does not access PostgreSQL."""
    return {"ok": True, "version": __version__}


@app.get("/readyz")
def readyz(request: Request):
    """Database readiness without disclosing connection details."""
    try:
        with request.app.state.pool.connection(timeout=2) as conn:
            with conn.transaction():
                conn.execute("SET LOCAL statement_timeout = '2s'")
                conn.execute("SELECT 1", prepare=False)
    except psycopg.Error:
        return JSONResponse({"ok": False}, status_code=503)
    return {"ok": True, "version": __version__}


@app.get("/healthz")
def healthz(request: Request):
    """Process liveness; dependency readiness belongs to /readyz."""
    return livez()


@app.get("/stats")
def stats(request: Request, response: Response):
    """Aggregate counts share /jobs' declared bounded-age database snapshot."""
    with read_connection(request) as conn:
        counts = request.app.state.counts_cache.get(lambda: queue.counts(conn))
    response.headers["X-LeaseQ-Counts-As-Of"] = counts["as_of"].isoformat()
    response.headers["X-LeaseQ-Counts-Max-Age-Seconds"] = str(request.app.state.counts_cache.max_age)
    return {key: counts[key] for key in ("queued", "leased", "done", "dead", "expired_leases", "total")}


@app.get("/metrics", response_class=PlainTextResponse)
def metrics(request: Request):
    """Authenticated Prometheus scrape. Queue gauges reuse the bounded-age cache."""
    try:
        with request.app.state.pool.connection(timeout=2) as conn:
            with conn.transaction():
                conn.execute("SET LOCAL statement_timeout = '2s'")
                counts = request.app.state.counts_cache.get(lambda: queue.counts(conn))
    except psycopg.Error:
        return PlainTextResponse("metrics dependency unavailable\n", status_code=503)
    return PlainTextResponse(request.app.state.metrics.render(counts),
                             media_type="text/plain; version=0.0.4")


@app.get("/api/system")
def system_status(request: Request):
    """Authenticated process measurements with bounded database readiness."""
    available = not isinstance(readyz(request), JSONResponse)
    metrics = request.app.state.metrics
    with metrics.lock:
        requests = sum(metrics.requests.values())
        errors = sum(value for (_, _, status), value in metrics.requests.items() if status >= 400)
    return {
        "service": "leaseq", "status": "ready" if available else "not_ready",
        "uptime_seconds": round(time.monotonic() - request.app.state.started_at, 3),
        "health": {"status": "ok"},
        "readiness": {"status": "ready" if available else "not_ready"},
        "http": {"requests_total": requests, "errors_total": errors},
        "scope": "HTTP API process and bounded database readiness; worker outcomes measured separately",
    }


@app.get("/workers")
def list_workers(request: Request, limit: int = Query(100, ge=1, le=100)):
    with read_connection(request) as conn:
        return operations.workers(conn, limit)


@app.get("/operations/metrics")
def operations_metrics(request: Request):
    with read_connection(request) as conn:
        return request.app.state.operations_metrics_cache.get(lambda: operations.metrics(conn))


@app.get("/schedules")
def list_schedules(request: Request, limit: int = Query(100, ge=1, le=100)):
    with read_connection(request) as conn:
        return scheduling.list_schedules(conn, limit)


@app.post("/schedules", status_code=201)
def create_schedule(body: ScheduleIn, request: Request, response: Response,
                    idempotency_key: str = Header(min_length=1, max_length=200)):
    try:
        with request.app.state.pool.connection() as conn:
            row, created = scheduling.create(conn, name=body.name, kind=body.kind,
                payload=body.payload, cron=body.cron, priority=body.priority,
                max_attempts=body.max_attempts, key=idempotency_key)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    response.status_code = 201 if created else 200
    return row


@app.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: int, body: ScheduleEnabledIn, request: Request):
    if schedule_id < 1 or schedule_id > BIGINT_MAX:
        raise HTTPException(422, "invalid schedule id")
    with request.app.state.pool.connection() as conn:
        row = scheduling.set_enabled(conn, schedule_id, body.enabled)
    if row is None:
        raise HTTPException(404, "schedule not found")
    return row


@app.get("/jobs")
def list_jobs(request: Request,
              state: Literal["queued", "leased", "retrying", "done", "dead"] | None = None,
              kind: str | None = Query(None, min_length=1, max_length=100, pattern=KIND_PATTERN),
              worker: str | None = Query(None, min_length=1, max_length=200,
                                         pattern=WORKER_PATTERN),
              before_id: int | None = Query(None, ge=1, le=BIGINT_MAX),
              limit: int = Query(50, ge=1, le=queue.MAX_PAGE)):
    """Newest first, `limit` at a time; pass `next_before_id` back to page.

    `jobs` is read fresh on every call. `counts` (a full scan) is taken at most
    once per `counts_max_age_seconds` per API process; `counts_as_of` is the
    database time it was taken."""
    cache = request.app.state.counts_cache
    with read_connection(request) as conn:
        jobs, next_before = queue.list_jobs(conn, state, kind, worker, before_id, limit)
        counts = dict(cache.get(lambda: queue.counts(conn)))
    as_of = counts.pop("as_of")
    return {"jobs": jobs, "next_before_id": next_before, "counts": counts,
            "counts_as_of": as_of, "counts_max_age_seconds": cache.max_age}


@app.get("/jobs/{job_id}/events")
def job_events(job_id: int, request: Request,
               after_id: int = Query(0, ge=0, le=BIGINT_MAX),
               limit: int = Query(200, ge=1, le=queue.MAX_EVENTS_PAGE)):
    """The job's audit trail, oldest first; pass `next_after_id` back to page."""
    with read_connection(request) as conn:
        events, next_after = queue.events(conn, job_id, after_id, limit)
    return {"events": events, "next_after_id": next_after}


@app.get("/jobs/{job_id}")
def get_job(job_id: int, request: Request):
    with read_connection(request) as conn:
        return queue.get(conn, job_id)


# --- dashboard (static files; no job data, so security.OPEN_PATHS lists them) --

@app.get("/", include_in_schema=False)
@app.get("/leases", include_in_schema=False)
@app.get("/dead-letter", include_in_schema=False)
@app.get("/system", include_in_schema=False)
def root():
    return FileResponse(DASHBOARD / "index.html", media_type="text/html",
                        headers={"Cache-Control": "no-cache"})


@app.get("/dashboard", include_in_schema=False)
def dashboard_redirect():
    return RedirectResponse("/dashboard/")


@app.get("/dashboard/", include_in_schema=False)
def dashboard():
    return FileResponse(DASHBOARD / "index.html")


@app.get("/dashboard/manifest.webmanifest", include_in_schema=False)
def dashboard_manifest():
    return FileResponse(DASHBOARD / "manifest.webmanifest", media_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@app.get("/dashboard/sw.js", include_in_schema=False)
def dashboard_service_worker():
    return FileResponse(DASHBOARD / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/dashboard/"})


app.mount("/dashboard/pages", StaticFiles(directory=DASHBOARD / "pages"), name="dashboard-pages")
app.mount("/dashboard/assets", StaticFiles(directory=DASHBOARD / "assets"), name="assets")
