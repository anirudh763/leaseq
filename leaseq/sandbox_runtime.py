"""Supervise one disposable PostgreSQL run and its original API/worker processes."""

from __future__ import annotations

import asyncio
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row


class SandboxError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


ADMIN_DATABASE = "leaseq_sandbox_admin"
TRUSTED_DATABASE_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres"}
FORBIDDEN_PG_ENV = {
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGPASSFILE",
    "PGOPTIONS",
    "PGDATABASE",
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGSSLMODE",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGSSLROOTCERT",
    "PGSSLCRL",
    "PGSSLCRLDIR",
    "PGTARGETSESSIONATTRS",
    "PGGSSENCMODE",
    "PGCONNECT_TIMEOUT",
}


def normalize_admin_conninfo(raw: str) -> str:
    """Return an unambiguous loopback admin DSN with bounded libpq options.

    psycopg/libpq URI query values override URI authority/path values. Parse
    them first, reject routing/behavior overrides, then rebuild a keyword DSN
    with the one permitted database name and explicit connection bounds.
    """
    if not raw or not raw.strip():
        raise ValueError("sandbox admin connection is empty")
    if FORBIDDEN_PG_ENV.intersection(os.environ):
        raise ValueError(
            "ambient PostgreSQL service, passfile, routing, or options settings are not allowed"
        )
    try:
        parsed = conninfo_to_dict(raw)
        uri = raw.startswith(("postgresql://", "postgres://"))
        sslmode = parsed.get("sslmode")
        if uri:
            parts = urlsplit(raw)
            if parts.path != f"/{ADMIN_DATABASE}":
                raise ValueError(
                    "sandbox admin URI path must name leaseq_sandbox_admin"
                )
            pairs = parse_qsl(parts.query, keep_blank_values=True)
            names = [key.lower() for key, _ in pairs]
            if len(names) != len(set(names)):
                raise ValueError(
                    "duplicate sandbox admin URI query keys are not allowed"
                )
            allowed_query = {"dbname", "sslmode"}
            if set(names) - allowed_query:
                raise ValueError(
                    "sandbox admin URI query contains a forbidden override"
                )
            # The exact canonical admin database below replaces any URI query
            # dbname, whose libpq precedence would otherwise beat the path.
        else:
            forbidden = {"service", "servicefile", "passfile", "hostaddr"}
            if forbidden.intersection(parsed):
                raise ValueError("sandbox admin DSN contains a forbidden libpq setting")
            if (
                parsed.get("connect_timeout", "3") != "3"
                or parsed.get("options", "-c statement_timeout=5000")
                != "-c statement_timeout=5000"
            ):
                raise ValueError(
                    "sandbox admin DSN timeout options are not the required bounds"
                )
            unknown = set(parsed) - {
                "dbname",
                "host",
                "port",
                "user",
                "password",
                "sslmode",
                "connect_timeout",
                "options",
            }
            if unknown:
                raise ValueError("sandbox admin DSN contains an unsupported setting")
            if parsed.get("dbname") != ADMIN_DATABASE:
                raise ValueError("sandbox admin DSN must target leaseq_sandbox_admin")
        host = parsed.get("host", "").lower()
        if host not in TRUSTED_DATABASE_HOSTS or parsed.get("hostaddr"):
            raise ValueError(
                "sandbox admin host must be loopback or the fixed Docker postgres service"
            )
        port = parsed.get("port", "")
        if not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError("sandbox admin port must be explicit and valid")
        if not parsed.get("user") or not parsed.get("password"):
            raise ValueError("sandbox admin user and password must be explicit")
        if sslmode and sslmode not in {
            "disable",
            "allow",
            "prefer",
            "require",
            "verify-ca",
            "verify-full",
        }:
            raise ValueError("sandbox admin sslmode is unsupported")
        canonical = {
            "dbname": ADMIN_DATABASE,
            "host": host,
            "port": str(int(port)),
            "user": parsed["user"],
            "password": parsed["password"],
            "connect_timeout": "3",
            "options": "-c statement_timeout=5000",
        }
        if sslmode:
            canonical["sslmode"] = sslmode
        return make_conninfo(**canonical)
    except (psycopg.ProgrammingError, ValueError, TypeError) as exc:
        if isinstance(exc, ValueError) and str(exc).startswith("sandbox admin"):
            raise
        raise ValueError("sandbox admin connection string is invalid") from exc


@dataclass
class Child:
    worker_id: str
    process: subprocess.Popen
    generation: int


@dataclass
class Run:
    run_id: str
    capability: str
    database: str
    database_url: str
    token: str
    api_process: subprocess.Popen | None
    api_url: str
    expires_at: float
    workers: dict[str, Child] = field(default_factory=dict)
    batches: int = 0
    owns_database: bool = True
    created_at: float = field(default_factory=time.time)
    killed_children: list[dict] = field(default_factory=list)
    closed: bool = False
    lifecycle_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    deadline_monotonic: float = 0.0


class SandboxManager:
    def __init__(self, admin_url: str, python: str | None = None):
        self.admin_url = normalize_admin_conninfo(admin_url)
        self.admin_database = conninfo_to_dict(self.admin_url)["dbname"]
        self.python = python or sys.executable
        self.current: Run | None = None
        self.ready = True
        self._rates: dict[str, deque[float]] = {}
        self._janitor: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self.orphan_cleanup_required: list[str] = []

    @classmethod
    def from_env(cls):
        url = os.environ.get("LEASEQ_SANDBOX_ADMIN_URL") or os.environ.get(
            "LEASEQ_DATABASE_URL", ""
        )
        if not url:
            raise RuntimeError("LEASEQ_SANDBOX_ADMIN_URL is required")
        try:
            manager = cls(url)
        except ValueError as exc:
            raise RuntimeError(
                "sandbox admin connection must be explicit, bounded, and loopback-only"
            ) from exc
        if manager.admin_database != ADMIN_DATABASE:
            raise RuntimeError("sandbox admin URL must target leaseq_sandbox_admin")
        return manager

    def allow_mutation(self, address: str) -> int | None:
        now = time.monotonic()
        q = self._rates.get(address)
        if q is None:
            if len(self._rates) >= 2048:
                stale = [
                    key
                    for key, times in self._rates.items()
                    if not times or now - times[-1] >= 60
                ]
                for key in stale:
                    self._rates.pop(key, None)
            if len(self._rates) >= 2048:
                return 60
            q = self._rates[address] = deque()
        while q and now - q[0] >= 60:
            q.popleft()
        if len(q) >= 10:
            return max(1, int(60 - (now - q[0])))
        q.append(now)
        return None

    def authorized(self, run_id, capability):
        r = self.current
        return bool(
            r
            and not getattr(r, "closed", False)
            and r.run_id == run_id
            and not self._expired(r)
            and secrets.compare_digest(r.capability, capability)
        )

    @staticmethod
    def _expired(run):
        deadline = getattr(run, "deadline_monotonic", 0.0)
        if deadline:
            return time.monotonic() >= deadline
        return time.time() >= run.expires_at

    def capability_status(self, run_id, capability):
        r = self.current
        if not r or r.closed or r.run_id != run_id or self._expired(r):
            return 410
        return (
            None
            if capability and secrets.compare_digest(r.capability, capability)
            else 401
        )

    def _assert_active(self, run):
        if (
            run.closed
            or self.current is not run
            or time.monotonic() >= run.deadline_monotonic
        ):
            raise SandboxError(410, "sandbox run is expired or closed")

    async def check_ready(self):
        try:

            def check():
                with self._admin() as conn:
                    conn.execute("SELECT 1")
                    rows = conn.execute(
                        "SELECT datname FROM pg_database WHERE left(datname,length('leaseq_sandbox_'))='leaseq_sandbox_' AND datname <> 'leaseq_sandbox_admin'"
                    ).fetchall()
                return [r["datname"] for r in rows]

            orphans = await asyncio.to_thread(check)
            # The only database this live supervisor knows it owns is its active run.
            allowed = (
                {self.current.database}
                if self.current and self.current.owns_database
                else set()
            )
            self.orphan_cleanup_required = [
                name for name in orphans if name not in allowed
            ]
            self.ready = not self.orphan_cleanup_required
        except Exception:
            self.ready = False
        return self.ready

    def start_janitor(self):
        if self._janitor is None or self._janitor.done():
            self._janitor = asyncio.create_task(self._janitor_loop())

    async def _janitor_loop(self):
        while True:
            await asyncio.sleep(1)
            run = self.current
            if run and time.monotonic() >= run.deadline_monotonic:
                await self.destroy(run, tolerate_unregistered=True)

    def _admin(self):
        return psycopg.connect(
            self.admin_url,
            autocommit=True,
            row_factory=dict_row,
            connect_timeout=3,
            options="-c statement_timeout=5000",
        )

    @staticmethod
    def _run_db(run, *, autocommit=True, row_factory=dict_row):
        return psycopg.connect(
            run.database_url,
            autocommit=autocommit,
            row_factory=row_factory,
            connect_timeout=3,
            options="-c statement_timeout=5000",
        )

    @staticmethod
    def _for_db(url: str, database: str) -> str:
        if not re.fullmatch(r"leaseq_sandbox_[0-9a-f]{16}", database):
            raise ValueError("sandbox database name is not a generated run identifier")
        canonical_admin = normalize_admin_conninfo(url)
        return make_conninfo(canonical_admin, dbname=database)

    @staticmethod
    def _bounded_url(url: str) -> str:
        values = conninfo_to_dict(url)
        forbidden = {"service", "servicefile", "passfile", "hostaddr"}
        if forbidden.intersection(values):
            raise ValueError("sandbox child DSN contains a forbidden libpq setting")
        if values.get("host", "").lower() not in TRUSTED_DATABASE_HOSTS:
            raise ValueError("sandbox child DSN host must be trusted local PostgreSQL")
        if (
            not values.get("port", "").isdigit()
            or not 1 <= int(values["port"]) <= 65535
        ):
            raise ValueError("sandbox child DSN port must be explicit and valid")
        if not re.fullmatch(r"leaseq_sandbox_[0-9a-f]{16}", values.get("dbname", "")):
            raise ValueError("sandbox child DSN must target a generated run database")
        values["connect_timeout"] = "3"
        values["options"] = "-c statement_timeout=5000"
        return make_conninfo(**values)

    @staticmethod
    def _port():
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        return port

    @staticmethod
    def _child_environment(database_url: str, token: str) -> dict[str, str]:
        # Children receive only ordinary process runtime variables and their
        # own sandbox DB/token. In particular, no gateway/admin or main DB URLs.
        allowed = (
            "PATH",
            "PYTHONPATH",
            "SYSTEMROOT",
            "WINDIR",
            "TMPDIR",
            "TEMP",
            "TMP",
            "LANG",
        )
        env = {key: os.environ[key] for key in allowed if key in os.environ}
        env.update(
            {
                "LEASEQ_DATABASE_URL": database_url,
                "LEASEQ_API_TOKEN": token,
                "LEASEQ_PUBLIC_READ": "0",
            }
        )
        return env

    async def create(self):
        async with self._lock:
            if self.current:
                raise SandboxError(409, "a sandbox run is already active")
            if not await self.check_ready():
                raise SandboxError(
                    503,
                    "sandbox database unavailable or manual orphan cleanup required",
                )
            run_id = secrets.token_hex(8)
            dbname = "leaseq_sandbox_" + secrets.token_hex(8)
            admin_db = conninfo_to_dict(self.admin_url).get("dbname")
            if admin_db != "leaseq_sandbox_admin":
                raise SandboxError(503, "sandbox admin database is misconfigured")
            token, capability = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            run_url = self._bounded_url(self._for_db(self.admin_url, dbname))
            api_port = self._port()
            env = self._child_environment(run_url, token)
            api = None
            run = Run(
                run_id,
                capability,
                dbname,
                run_url,
                token,
                None,
                f"http://127.0.0.1:{api_port}",
                time.time() + 600,
                owns_database=False,
                deadline_monotonic=time.monotonic() + 600,
            )
            try:
                with self._admin() as conn:
                    conn.execute(f'CREATE DATABASE "{dbname}"')
                run.owns_database = True
                api = subprocess.Popen(
                    [
                        self.python,
                        "-m",
                        "uvicorn",
                        "leaseq.api:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(api_port),
                        "--log-level",
                        "error",
                    ],
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                )
                run.api_process = api
                self.current = run
                await self._wait_api(run)
                for i in range(4):
                    self._spawn_worker(run, i, 1)
                self._enqueue_initial(run)
                self.ready = True
                return {
                    "run_id": run_id,
                    "capability": capability,
                    "expires_at": self._iso(run.expires_at),
                }
            except Exception as exc:
                await self.destroy(run, tolerate_unregistered=True)
                if isinstance(exc, SandboxError):
                    raise
                raise SandboxError(
                    503, "sandbox startup failed; owned resources were reaped"
                ) from exc
            except asyncio.CancelledError:
                cleanup = asyncio.create_task(
                    self.destroy(run, tolerate_unregistered=True)
                )
                await asyncio.shield(cleanup)
                raise

    async def _wait_api(self, run):
        import httpx

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if run.api_process.poll() is not None:
                raise RuntimeError("private core API exited during startup")
            try:
                async with httpx.AsyncClient(timeout=0.3) as client:
                    if (await client.get(run.api_url + "/livez")).status_code == 200:
                        return
            except Exception:
                pass
            await asyncio.sleep(0.1)
        raise RuntimeError("private core API startup timed out")

    def _spawn_worker(self, run, index, generation):
        worker_id = f"sandbox-{run.run_id}-{index}"
        env = self._child_environment(run.database_url, run.token)
        proc = subprocess.Popen(
            [
                self.python,
                "-m",
                "leaseq.worker",
                "--api",
                run.api_url,
                "--worker-id",
                worker_id,
                "--lease-seconds",
                "4",
                "--poll-seconds",
                ".05",
            ],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        run.workers[worker_id] = Child(worker_id, proc, generation)

    def _enqueue_initial(self, run):
        jobs = []
        jobs.extend(
            (
                "word_count",
                {"text": "LeaseQ sandbox real worker"},
                f"{run.run_id}:word:{i}",
                3,
            )
            for i in range(12)
        )
        jobs += [
            ("fail_first_n", {"n": 1}, f"{run.run_id}:transient", 3),
            ("fail", {"error": "sandbox poison fixture"}, f"{run.run_id}:poison", 2),
            ("sleep", {"ms": 200, "stall_ms": 12000}, f"{run.run_id}:stalled", 3),
        ]
        # Use the original API for every enqueue so its idempotency and audit behavior are real.
        import httpx

        with httpx.Client(
            base_url=run.api_url,
            headers={"Authorization": f"Bearer {run.token}"},
            timeout=5,
        ) as client:
            for kind, payload, key, attempts in jobs:
                client.post(
                    "/jobs",
                    json={"kind": kind, "payload": payload, "max_attempts": attempts},
                    headers={"Idempotency-Key": key},
                ).raise_for_status()

    def _fixed_jobs(self, run, batch):
        import httpx

        with httpx.Client(
            base_url=run.api_url,
            headers={"Authorization": f"Bearer {run.token}"},
            timeout=5,
        ) as c:
            results = []
            for i in range(32):
                r = c.post(
                    "/jobs",
                    json={"kind": "sleep", "payload": {"ms": 3000}, "max_attempts": 3},
                    headers={"Idempotency-Key": f"{run.run_id}:batch:{batch}:{i}"},
                )
                r.raise_for_status()
                results.append(r.json()["id"])
        return results

    async def batch(self, run):
        async with run.lifecycle_lock:
            self._assert_active(run)
            if run.batches >= 3:
                raise SandboxError(409, "three extra batches are the run limit")
            try:
                with self._run_db(run) as conn:
                    total = conn.execute("SELECT count(*) AS n FROM jobs").fetchone()[
                        "n"
                    ]
                if total + 32 > 128:
                    raise SandboxError(409, "run job limit reached")
                run.batches += 1
                ids = await asyncio.to_thread(self._fixed_jobs, run, run.batches)
            except psycopg.Error as exc:
                raise SandboxError(503, "sandbox database is unavailable") from exc
            return {
                "created": len(ids),
                "job_ids": ids,
                "batches_remaining": 3 - run.batches,
            }

    async def kill_leased_worker(self, run):
        async with run.lifecycle_lock:
            self._assert_active(run)
            try:
                with self._run_db(run, autocommit=False) as conn:
                    row = conn.execute(
                        "SELECT id,leased_by,lease_expires_at FROM jobs WHERE state='leased' "
                        "ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED"
                    ).fetchone()
                    if not row:
                        raise SandboxError(
                            409, "no currently leased worker is eligible"
                        )
                    child = run.workers.get(row["leased_by"])
                    if not child or child.process.poll() is not None:
                        raise SandboxError(
                            409, "leased process is no longer registered"
                        )
                    # Hold the row until the registered process is dead so its
                    # completion cannot commit between selection and SIGKILL.
                    child.process.send_signal(signal.SIGKILL)
                    await asyncio.to_thread(child.process.wait, 3)
                run.killed_children.append(
                    {
                        "worker_id": child.worker_id,
                        "returncode": child.process.returncode,
                        "job_id": row["id"],
                    }
                )
                idx = int(child.worker_id.rsplit("-", 1)[1])
                gen = child.generation + 1
                self._spawn_worker(run, idx, gen)
                return {"worker_id": child.worker_id, "job_id": row["id"]}
            except psycopg.Error as exc:
                raise SandboxError(503, "sandbox database is unavailable") from exc

    async def duplicate_first(self, run):
        async with run.lifecycle_lock:
            self._assert_active(run)
            import httpx

            key = f"{run.run_id}:word:0"
            try:
                with self._run_db(run) as conn:
                    prior = conn.execute(
                        "SELECT id FROM jobs WHERE idempotency_key=%s", (key,)
                    ).fetchone()
                if not prior:
                    raise SandboxError(
                        409, "initial idempotency fixture is unavailable"
                    )
                with httpx.Client(
                    base_url=run.api_url,
                    headers={"Authorization": f"Bearer {run.token}"},
                    timeout=5,
                ) as c:
                    r = c.post(
                        "/jobs",
                        json={
                            "kind": "word_count",
                            "payload": {"text": "LeaseQ sandbox real worker"},
                            "max_attempts": 3,
                        },
                        headers={"Idempotency-Key": key},
                    )
                    r.raise_for_status()
                return {
                    "original_job_id": prior["id"],
                    "existing_job_id": r.json()["id"],
                    "created": r.status_code == 201,
                }
            except psycopg.Error as exc:
                raise SandboxError(503, "sandbox database is unavailable") from exc

    def _snapshot_sync(self, run):
        with self._run_db(run, autocommit=False) as conn:
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            observed = conn.execute("SELECT clock_timestamp() AS observed").fetchone()[
                "observed"
            ]
            counts = conn.execute(
                "SELECT state,count(*) AS count FROM jobs GROUP BY state"
            ).fetchall()
            jobs = conn.execute(
                "SELECT id,kind,state,attempts,max_attempts,run_after,lease_expires_at,leased_by,created_at,updated_at,(SELECT count(*) FROM effects e WHERE e.job_id=j.id) effect_count FROM jobs j ORDER BY id DESC LIMIT 128"
            ).fetchall()
            events = conn.execute(
                "SELECT id,job_id,event,attempt,worker_id,detail,created_at FROM job_events ORDER BY id DESC LIMIT 100"
            ).fetchall()
            metrics = conn.execute(
                "SELECT (SELECT count(*) FROM job_events WHERE event='claimed' AND detail ? 'took_over_expired_lease_of') expired_retries,(SELECT count(*) FROM job_events WHERE event='rejected' AND detail->>'op'='complete') zombie_rejections,(SELECT count(*) FROM effects) effects"
            ).fetchone()
            takeover = conn.execute(
                "SELECT count(*) n FROM job_events WHERE event='claimed' AND detail ? 'took_over_expired_lease_of'"
            ).fetchone()["n"]
            stale = conn.execute(
                "SELECT count(*) n FROM job_events WHERE event='rejected' AND detail->>'op'='complete'"
            ).fetchone()["n"]
            poison = conn.execute(
                "SELECT count(*) n FROM jobs WHERE idempotency_key=%s AND state='dead'",
                (f"{run.run_id}:poison",),
            ).fetchone()["n"]
            live = conn.execute(
                "SELECT leased_by,id,lease_expires_at FROM jobs WHERE state='leased'"
            ).fetchall()
        leases = {r["leased_by"]: r for r in live}
        return {
            "run_id": run.run_id,
            "phase": "active"
            if time.monotonic() < run.deadline_monotonic
            else "expired",
            "observed_at": self._iso(observed.timestamp()),
            "expires_at": self._iso(run.expires_at),
            "workers": [
                {
                    "id": w.worker_id,
                    "generation": w.generation,
                    "status": "running" if w.process.poll() is None else "stopped",
                    "job_id": leases.get(w.worker_id, {}).get("id"),
                    "lease_expires_at": self._iso(
                        leases[w.worker_id]["lease_expires_at"].timestamp()
                    )
                    if w.worker_id in leases
                    else None,
                }
                for w in run.workers.values()
            ],
            "counts": {r["state"]: r["count"] for r in counts},
            "metrics": metrics,
            "jobs": [
                {
                    **j,
                    "run_after": self._iso(j["run_after"].timestamp()),
                    "lease_expires_at": self._iso(j["lease_expires_at"].timestamp())
                    if j["lease_expires_at"]
                    else None,
                    "created_at": self._iso(j["created_at"].timestamp()),
                    "updated_at": self._iso(j["updated_at"].timestamp()),
                }
                for j in jobs
            ],
            "events": [
                {
                    **e,
                    "detail": e["detail"],
                    "created_at": self._iso(e["created_at"].timestamp()),
                }
                for e in events
            ],
            "evidence": {
                "snapshot": "observed",
                "lease_recovery": "pass" if takeover else "inconclusive",
                "stale_completion": "pass" if stale else "inconclusive",
                "poison_dlq": "pass" if poison else "inconclusive",
                "database_time": "observed",
            },
            "limits": {
                "max_jobs": 128,
                "max_runtime_seconds": 600,
                "extra_batches": 3,
                "workers": 4,
            },
        }

    async def snapshot(self, run):
        async with run.lifecycle_lock:
            self._assert_active(run)
            try:
                return await asyncio.to_thread(self._snapshot_sync, run)
            except psycopg.Error as exc:
                raise SandboxError(503, "sandbox database is unavailable") from exc

    async def job_detail(self, run, job_id):
        def read_detail():
            with self._run_db(run, autocommit=False) as conn:
                conn.execute(
                    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
                )
                row = conn.execute(
                    "SELECT id,kind,state,attempts,max_attempts,run_after,lease_expires_at,leased_by,created_at,updated_at,(SELECT count(*) FROM effects e WHERE e.job_id=j.id) effect_count FROM jobs j WHERE id=%s",
                    (job_id,),
                ).fetchone()
                if not row:
                    return None
                events = conn.execute(
                    "SELECT id,job_id,event,attempt,worker_id,detail,created_at FROM job_events WHERE job_id=%s ORDER BY id LIMIT 100",
                    (job_id,),
                ).fetchall()
            for key in ("run_after", "created_at", "updated_at"):
                row[key] = self._iso(row[key].timestamp())
            if row["lease_expires_at"]:
                row["lease_expires_at"] = self._iso(row["lease_expires_at"].timestamp())
            return {
                "job": row,
                "events": [
                    {**e, "created_at": self._iso(e["created_at"].timestamp())}
                    for e in events
                ],
                "effect_count": row["effect_count"],
            }

        async with run.lifecycle_lock:
            self._assert_active(run)
            try:
                result = await asyncio.to_thread(read_detail)
            except psycopg.Error as exc:
                raise SandboxError(503, "sandbox database is unavailable") from exc
        if not result:
            raise SandboxError(404, "job not found in this run")
        return result

    async def destroy(self, run, tolerate_unregistered=False):
        async with run.lifecycle_lock:
            if run.closed:
                return
            run.closed = True
            if self.current is run:
                self.current = None
            for child in list(run.workers.values()):
                self._stop(child.process)
            if run.api_process:
                self._stop(run.api_process)
            if run.owns_database:
                try:
                    with self._admin() as conn:
                        exists = conn.execute(
                            "SELECT d.datname,pg_get_userbyid(d.datdba) AS owner,current_user AS current_user FROM pg_database d WHERE datname=%s",
                            (run.database,),
                        ).fetchone()
                        if (
                            exists
                            and exists["owner"] == exists["current_user"]
                            and run.database.startswith("leaseq_sandbox_")
                        ):
                            conn.execute(
                                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()",
                                (run.database,),
                            )
                            conn.execute(f'DROP DATABASE "{run.database}"')
                        elif exists:
                            raise RuntimeError(
                                "refusing to drop database not owned by this supervisor"
                            )
                    run.owns_database = False
                except Exception as exc:
                    if run.database not in self.orphan_cleanup_required:
                        self.orphan_cleanup_required.append(run.database)
                    self.ready = False
                    if not tolerate_unregistered:
                        raise SandboxError(
                            503,
                            "run resources stopped but its owned database needs manual cleanup",
                        ) from exc

    @staticmethod
    def _stop(proc):
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=3)

    async def shutdown(self):
        if self._janitor:
            self._janitor.cancel()
            try:
                await self._janitor
            except asyncio.CancelledError:
                pass
        if self.current:
            await self.destroy(self.current, tolerate_unregistered=True)

    @staticmethod
    def _iso(timestamp):
        return (
            datetime.fromtimestamp(timestamp, timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
