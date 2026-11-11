"""HTTP API. A thin layer: validate input, call queue.py, map results to status codes."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db, queue


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = db.make_pool()
    with app.state.pool.connection() as conn:
        db.apply_schema(conn)
    yield
    app.state.pool.close()


app = FastAPI(title="leaseq", lifespan=lifespan)


class JobIn(BaseModel):
    kind: str = Field(min_length=1)
    payload: dict = {}
    max_attempts: int = Field(default=5, ge=1, le=100)


class ClaimIn(BaseModel):
    worker_id: str = Field(min_length=1)
    lease_seconds: float = Field(default=30, gt=0, le=3600)


class HeartbeatIn(BaseModel):
    lease_token: str
    lease_seconds: float = Field(default=30, gt=0, le=3600)


class CompleteIn(BaseModel):
    lease_token: str
    result: dict | None = None


class FailIn(BaseModel):
    lease_token: str
    error: str = ""


LEASE_LOST = HTTPException(409, "lease token is not the current lease for this job")


@app.exception_handler(queue.JobNotFound)
def not_found(request: Request, exc: queue.JobNotFound):
    return JSONResponse({"detail": "job not found"}, status_code=404)


# Handlers are plain `def`, so FastAPI runs them in its thread pool and the
# blocking psycopg calls do not stall the event loop.

@app.post("/jobs")
def submit(body: JobIn, request: Request, response: Response,
           idempotency_key: str = Header(min_length=1, max_length=200)):
    with request.app.state.pool.connection() as conn:
        job, created = queue.enqueue(conn, body.kind, body.payload, idempotency_key,
                                     body.max_attempts)
    response.status_code = 201 if created else 200
    return job


@app.post("/jobs/claim")
def claim(body: ClaimIn, request: Request):
    with request.app.state.pool.connection() as conn:
        job = queue.claim(conn, body.worker_id, body.lease_seconds)
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
        job = queue.fail(conn, job_id, body.lease_token, body.error)
    if job is None:
        raise LEASE_LOST
    return job


@app.get("/stats")
def stats(request: Request):
    with request.app.state.pool.connection() as conn:
        return queue.stats(conn)


@app.get("/jobs/{job_id}")
def get_job(job_id: int, request: Request):
    with request.app.state.pool.connection() as conn:
        return queue.get(conn, job_id)
