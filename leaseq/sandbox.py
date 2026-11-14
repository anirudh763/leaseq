"""Loopback-only disposable real-engine chaos lab gateway."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .sandbox_runtime import SandboxManager, SandboxError

MAX_BODY = 64 * 1024
BODY_READ_TIMEOUT_SECONDS = 10.0


class Guard:
    """Reject origin/header/body/rate abuse before parsing or allocating large bodies."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        manager = scope["app"].state.manager
        path, method = scope["path"], scope["method"]
        headers = dict(scope["headers"])
        origin = headers.get(b"origin")
        host = headers.get(b"host", b"")
        mutation = path.startswith("/sandbox/") and method not in (
            "GET",
            "HEAD",
            "OPTIONS",
        )
        host_name = host.split(b":", 1)[0].lower()
        if host.startswith(b"["):
            host_name = host.split(b"]", 1)[0].lower() + b"]"
        if host_name not in (b"127.0.0.1", b"localhost", b"[::1]"):
            return await self.reply(send, 403, {"detail": "loopback host required"})
        if mutation and not origin:
            return await self.reply(
                send, 403, {"detail": "same-origin request required"}
            )
        if origin:
            expected = (
                b"http://" if scope.get("scheme") == "http" else b"https://"
            ) + host
            if not hmac.compare_digest(origin.rstrip(b"/"), expected.rstrip(b"/")):
                return await self.reply(send, 403, {"detail": "origin rejected"})
        if mutation:
            if scope.get("query_string"):
                return await self.reply(
                    send, 400, {"detail": "query parameters are not accepted"}
                )
            if headers.get(b"x-leaseq-sandbox") != b"1":
                return await self.reply(
                    send, 403, {"detail": "sandbox header required"}
                )
            cleanup_reservation = False
            if manager is None:
                return await self.reply(
                    send, 503, {"detail": "sandbox gateway is not configured"}
                )
            # Reserve only the authenticated DELETE of the current exact run so
            # a full mutation budget can never strand owned processes/DB.
            if method == "DELETE":
                parts = path.split("/")
                scheme, _, capability = (
                    headers.get(b"authorization", b"").decode("latin-1").partition(" ")
                )
                run = manager.current
                cleanup_reservation = bool(
                    len(parts) == 4
                    and parts[:2] == ["", "sandbox"]
                    and parts[2] == "runs"
                    and run
                    and parts[3] == run.run_id
                    and scheme.lower() == "bearer"
                    and manager.capability_status(run.run_id, capability) is None
                )
            if not cleanup_reservation:
                peer = scope.get("client") or ("unknown", 0)
                retry = manager.allow_mutation(str(peer[0]))
                if retry:
                    return await self.reply(
                        send,
                        429,
                        {
                            "detail": "mutation rate limit exceeded",
                            "retry_after": retry,
                        },
                        [(b"retry-after", str(retry).encode())],
                    )
        if method not in ("GET", "HEAD", "OPTIONS"):
            declared = headers.get(b"content-length")
            if declared and (not declared.isdigit() or int(declared) > MAX_BODY):
                return await self.reply(
                    send, 413, {"detail": "request body exceeds 64 KiB"}
                )
            total, chunks, more = 0, [], True
            body_deadline = time.monotonic() + BODY_READ_TIMEOUT_SECONDS
            while more:
                remaining = body_deadline - time.monotonic()
                if remaining <= 0:
                    return await self.reply(
                        send,
                        408,
                        {
                            "detail": f"request body read exceeded the {BODY_READ_TIMEOUT_SECONDS:g} second limit"
                        },
                    )
                try:
                    msg = await asyncio.wait_for(receive(), timeout=remaining)
                except asyncio.TimeoutError:
                    return await self.reply(
                        send,
                        408,
                        {
                            "detail": f"request body read exceeded the {BODY_READ_TIMEOUT_SECONDS:g} second limit"
                        },
                    )
                if msg["type"] == "http.disconnect":
                    return
                chunk = msg.get("body", b"")
                total += len(chunk)
                if total > MAX_BODY:
                    return await self.reply(
                        send, 413, {"detail": "request body exceeds 64 KiB"}
                    )
                chunks.append(chunk)
                more = msg.get("more_body", False)
            body, replayed = b"".join(chunks), False
            if mutation and body:
                return await self.reply(
                    send, 422, {"detail": "sandbox mutations accept no client body"}
                )
            original_receive = receive

            async def replay():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await original_receive()

            receive = replay

        async def secure_send(message):
            if message["type"] == "http.response.start" and (
                path.startswith("/console") or path.startswith("/sandbox/")
            ):
                headers_out = list(message.get("headers", []))
                headers_out.extend(
                    [
                        (
                            b"content-security-policy",
                            b"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                        ),
                        (b"x-content-type-options", b"nosniff"),
                        (b"x-frame-options", b"DENY"),
                        (b"referrer-policy", b"no-referrer"),
                        (b"cache-control", b"no-store"),
                    ]
                )
                message = {**message, "headers": headers_out}
            await send(message)

        await self.app(scope, receive, secure_send)

    @staticmethod
    async def reply(send, status, data, extra=()):
        body = json.dumps(data).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    *extra,
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def create_app(manager: SandboxManager | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        if app.state.manager is None:
            app.state.manager = SandboxManager.from_env()
        app.state.manager.start_janitor()
        try:
            yield
        finally:
            if app.state.manager:
                await app.state.manager.shutdown()

    app = FastAPI(
        title="LeaseQ local sandbox", docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.state.manager = manager
    app.add_middleware(Guard)

    def current_manager():
        if app.state.manager is None:
            raise HTTPException(503, "sandbox gateway is not configured")
        return app.state.manager

    def auth(run_id: str, authorization: str | None):
        scheme, _, capability = (authorization or "").partition(" ")
        capability = capability if scheme.lower() == "bearer" else None
        manager = current_manager()
        status = manager.capability_status(run_id, capability)
        if status == 410:
            raise HTTPException(410, "sandbox run is expired or closed")
        if status == 401:
            raise HTTPException(401, "missing or invalid run capability")
        return manager.current

    @app.get("/healthz")
    def health():
        return {"ok": True}

    @app.get("/readyz")
    async def ready():
        manager = app.state.manager
        if manager and await manager.check_ready():
            return {"ok": True}
        return JSONResponse(
            {
                "ok": False,
                "detail": "sandbox database unavailable or manual cleanup required; inspect leaseq_sandbox_* ownership and active processes before dropping; no unknown database was deleted",
            },
            status_code=503,
        )

    console = Path(__file__).with_name("console")
    if console.is_dir():
        app.mount("/console", StaticFiles(directory=console, html=True), name="console")

    @app.post("/sandbox/runs")
    async def create_run():
        try:
            return await current_manager().create()
        except SandboxError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.get("/sandbox/runs/{run_id}")
    async def snapshot(run_id: str, authorization: str | None = Header(default=None)):
        run = auth(run_id, authorization)
        try:
            return await current_manager().snapshot(run)
        except SandboxError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.post("/sandbox/runs/{run_id}/batch")
    async def batch(run_id: str, authorization: str | None = Header(default=None)):
        run = auth(run_id, authorization)
        try:
            return await current_manager().batch(run)
        except SandboxError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.post("/sandbox/runs/{run_id}/kill")
    async def kill(run_id: str, authorization: str | None = Header(default=None)):
        run = auth(run_id, authorization)
        try:
            return await current_manager().kill_leased_worker(run)
        except SandboxError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.post("/sandbox/runs/{run_id}/duplicate")
    async def duplicate(run_id: str, authorization: str | None = Header(default=None)):
        run = auth(run_id, authorization)
        try:
            return await current_manager().duplicate_first(run)
        except SandboxError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.get("/sandbox/runs/{run_id}/jobs/{job_id}")
    async def detail(
        run_id: str, job_id: int, authorization: str | None = Header(default=None)
    ):
        run = auth(run_id, authorization)
        try:
            return await current_manager().job_detail(run, job_id)
        except SandboxError as exc:
            raise HTTPException(exc.status, str(exc))

    @app.delete("/sandbox/runs/{run_id}")
    async def delete(run_id: str, authorization: str | None = Header(default=None)):
        run = auth(run_id, authorization)
        await current_manager().destroy(run)
        return Response(status_code=204)

    return app


app = create_app()


def main():
    """Run the gateway on loopback only; workers/core API bind their own loopback ports."""
    import uvicorn

    uvicorn.run(
        "leaseq.sandbox:app",
        host="127.0.0.1",
        port=int(os.environ.get("LEASEQ_SANDBOX_PORT", "8765")),
        log_level="info",
    )


if __name__ == "__main__":
    main()
