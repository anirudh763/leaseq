"""Bearer-token access control, request size limit and response headers.

The token is compared with hmac.compare_digest on SHA-256 digests of both
sides, so the time taken depends neither on how many leading characters match
nor on the length of the supplied value.
"""
import hashlib
import hmac
import os
from dataclasses import dataclass

from fastapi import HTTPException, Request

MIN_TOKEN_LENGTH = 16
DEFAULT_MAX_BODY_BYTES = 64 * 1024


@dataclass(frozen=True)
class Settings:
    api_token: str | None
    public_read: bool
    max_body_bytes: int


def load_settings() -> Settings:
    token = os.environ.get("LEASEQ_API_TOKEN") or None
    if token is not None and len(token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(f"LEASEQ_API_TOKEN must be at least {MIN_TOKEN_LENGTH} characters")
    return Settings(
        api_token=token,
        public_read=os.environ.get("LEASEQ_PUBLIC_READ") == "1",
        max_body_bytes=int(os.environ.get("LEASEQ_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)),
    )


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).digest()


def token_matches(supplied: str, expected: str) -> bool:
    return hmac.compare_digest(_digest(supplied), _digest(expected))


def _bearer(request: Request) -> str | None:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    value = value.strip()
    return value if scheme.lower() == "bearer" and value else None


def _check(request: Request, expected: str) -> None:
    supplied = _bearer(request)
    if supplied is None or not token_matches(supplied, expected):
        raise HTTPException(401, "missing or invalid bearer token",
                            headers={"WWW-Authenticate": "Bearer"})


def require_write(request: Request) -> None:
    """Submit, claim, heartbeat, complete, fail: token required when one is configured."""
    expected = request.app.state.settings.api_token
    if expected is not None:
        _check(request, expected)


def require_read(request: Request) -> None:
    """GET endpoints: like writes, unless LEASEQ_PUBLIC_READ=1."""
    settings = request.app.state.settings
    if settings.api_token is not None and not settings.public_read:
        _check(request, settings.api_token)


def require_operator(request: Request) -> None:
    """Requeue/cancel: fail closed. Without a configured token they are disabled."""
    expected = request.app.state.settings.api_token
    if expected is None:
        raise HTTPException(403, "operator actions are disabled: "
                                 "start the API with LEASEQ_API_TOKEN set")
    _check(request, expected)


class BodyLimit:
    """Reject request bodies over LEASEQ_MAX_BODY_BYTES with 413 before the app
    parses anything. Checks Content-Length up front and also counts the bytes of
    chunked bodies as they arrive, so a missing or false header does not bypass it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        settings = getattr(scope["app"].state, "settings", None)
        limit = settings.max_body_bytes if settings else DEFAULT_MAX_BODY_BYTES
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None:
            if not declared.isdigit():
                return await _reply(send, 400, b'{"detail":"invalid Content-Length"}')
            if int(declared) > limit:
                return await _reply(send, 413, _too_large(limit))
        chunks, total, more = [], 0, True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            total += len(body)
            if total > limit:
                return await _reply(send, 413, _too_large(limit))
            chunks.append(body)
            more = message.get("more_body", False)
        buffered, replayed = b"".join(chunks), False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def _too_large(limit: int) -> bytes:
    return b'{"detail":"request body is larger than %d bytes"}' % limit


async def _reply(send, status: int, body: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


# The dashboard loads only its own files, never runs inline script, and may not
# be framed. The API docs page (/docs) loads Swagger UI from a CDN, so the
# policy is applied to the dashboard paths only.
DASHBOARD_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; "
                 "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; "
                 "frame-ancestors 'none'")


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        dashboard = scope["path"] == "/dashboard/" or scope["path"].startswith("/dashboard/")

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-content-type-options", b"nosniff"))
                headers.append((b"referrer-policy", b"no-referrer"))
                if dashboard:
                    headers.append((b"content-security-policy", DASHBOARD_CSP.encode()))
                    headers.append((b"x-frame-options", b"DENY"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
