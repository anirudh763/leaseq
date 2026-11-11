"""Shared helpers for the tests, the chaos run and the benchmark: a scratch
database that is safe to wipe, and an API server in a subprocess."""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from leaseq import db  # noqa: E402


def scratch_database(name: str) -> str:
    """Create database `name` next to the configured one (if missing), wipe it,
    apply the schema and return its connection string. Only ever wipes `name`."""
    with psycopg.connect(db.database_url(), autocommit=True) as admin:
        exists = admin.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
        if not exists:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    url = make_conninfo(db.database_url(), dbname=name)
    with db.connect(url) as conn:
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        db.apply_schema(conn)
    return url


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def child_env(db_url: str) -> dict:
    return {**os.environ, "LEASEQ_DATABASE_URL": db_url, "PYTHONPATH": str(ROOT)}


def start_api(db_url: str) -> tuple[subprocess.Popen, str]:
    """Run `uvicorn leaseq.api:app` in a subprocess and wait until it answers."""
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "leaseq.api:app", "--host", "127.0.0.1",
         "--port", str(port), "--log-level", "warning"], env=child_env(db_url), cwd=ROOT)
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            if httpx.get(base + "/stats", timeout=1).status_code == 200:
                return proc, base
        except httpx.HTTPError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("API server did not start")


def start_worker(db_url: str, api: str, worker_id: str, lease_seconds: float,
                 unfenced: bool = False) -> subprocess.Popen:
    cmd = [sys.executable, "-m", "leaseq.worker", "--api", api, "--worker-id", worker_id,
           "--lease-seconds", str(lease_seconds), "--poll-seconds", "0.05"]
    if unfenced:
        cmd.append("--unfenced")
    return subprocess.Popen(cmd, env=child_env(db_url), cwd=ROOT)
