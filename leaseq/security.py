"""Bearer-token access control, request size limit and response headers.

The token is compared with hmac.compare_digest on SHA-256 digests of both
sides, so the time taken depends neither on how many leading characters match
nor on the length of the supplied value.
"""
import hashlib
import hmac
import os
from dataclasses import dataclass


MIN_TOKEN_LENGTH = 16
DEFAULT_MAX_BODY_BYTES = 64 * 1024


@dataclass(frozen=True)
class Settings:
    api_token: str
    public_read: bool
    max_body_bytes: int


TOKEN_HELP = ("generate one with: python -c 'import secrets; print(secrets.token_urlsafe(32))'")


def load_settings() -> Settings:
    """Fail closed: the API does not start without a usable token."""
    token = (os.environ.get("LEASEQ_API_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("LEASEQ_API_TOKEN is not set or is blank. leaseq will not start "
                           "without it, because every write and worker call needs it; "
                           + TOKEN_HELP)
    if len(token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(f"LEASEQ_API_TOKEN must be at least {MIN_TOKEN_LENGTH} characters; "
                           + TOKEN_HELP)
    return Settings(
        api_token=token,
        public_read=os.environ.get("LEASEQ_PUBLIC_READ") == "1",
        max_body_bytes=int(os.environ.get("LEASEQ_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)),
    )


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).digest()


def token_matches(supplied: str, expected: str) -> bool:
    return hmac.compare_digest(_digest(supplied), _digest(expected))


def _bearer(headers: dict) -> str | None:
    raw = headers.get(b"authorization", b"").decode("latin-1")
    scheme, _, value = raw.partition(" ")
    value = value.strip()
    return value if scheme.lower() == "bearer" and value else None


# Paths that hold no job data and are served without a token. Everything else
# is denied by default, so a route added later is protected unless listed here.
OPEN_PATHS = {"/", "/healthz", "/livez", "/readyz", "/dashboard", "/docs", "/docs/oauth2-redirect", "/openapi.json"}
OPEN_PREFIXES = ("/dashboard",)
# GET endpoints that LEASEQ_PUBLIC_READ=1 opens. /auth/check is not among them.
PUBLIC_READ_PREFIXES = ("/stats", "/jobs")


def _under(path: str, prefixes: tuple[str, ...]) -> bool:
    """True for the prefix itself or a path below it: '/jobs' and '/jobs/1',
    but not '/jobsadmin'."""
    return any(path == p or path.startswith(p + "/") for p in prefixes)


def access(method: str, path: str, public_read: bool) -> str:
    """-> 'open' or 'token' for a request."""
    if path in OPEN_PATHS or _under(path, OPEN_PREFIXES):
        return "open"
    if public_read and method in ("GET", "HEAD") and _under(path, PUBLIC_READ_PREFIXES):
        return "open"
    return "token"


class Auth:
    """Bearer-token check for every request, before the body is read or parsed.

    Missing or wrong token: 401 with a JSON body and `WWW-Authenticate: Bearer`.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        settings = getattr(scope["app"].state, "settings", None)
        if settings is None:
            return await _reply(send, 503, b'{"detail":"starting up"}')
        if access(scope["method"], scope["path"], settings.public_read) == "token":
            supplied = _bearer(dict(scope["headers"]))
            if supplied is None or not token_matches(supplied, settings.api_token):
                return await _reply(send, 401, b'{"detail":"missing or invalid bearer token"}',
                                    [(b"www-authenticate", b"Bearer")])
        await self.app(scope, receive, send)


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


async def _reply(send, status: int, body: bytes, extra_headers=()) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()), *extra_headers]})
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
        dashboard = _under(scope["path"], ("/dashboard",))

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
