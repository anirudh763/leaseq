"""Database access: one URL, plain psycopg connections, no ORM."""
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

SCHEMA = Path(__file__).with_name("schema.sql")
DEFAULT_URL = "postgresql://leaseq:leaseq@localhost:5432/leaseq"

# autocommit=True means nothing is in a transaction unless the code says
# `with conn.transaction():`, so every transaction boundary is visible.
CONN_KWARGS = {"autocommit": True, "row_factory": dict_row}


def database_url() -> str:
    return os.environ.get("LEASEQ_DATABASE_URL", DEFAULT_URL)


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or database_url(), **CONN_KWARGS)


def make_pool(url: str | None = None, size: int = 10) -> ConnectionPool:
    pool = ConnectionPool(url or database_url(), min_size=size, max_size=size,
                          kwargs=CONN_KWARGS, open=False)
    pool.open(wait=True)
    return pool


# How long startup DDL may wait for a table lock. While a lock request waits,
# every later writer on that table queues behind it, so this bounds how long an
# API start can stall the queue. On a database that is already up to date the
# schema takes no table lock at all (see the DO block in schema.sql).
SCHEMA_LOCK_TIMEOUT = "2s"


class SchemaLockTimeout(RuntimeError):
    pass


def apply_schema(conn: psycopg.Connection) -> None:
    # The advisory lock stops two processes starting at once from racing on
    # CREATE. It is taken before lock_timeout is set: a second process waits
    # for the first, whose own DDL is bounded by the timeout.
    try:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(4217)")
            conn.execute("SELECT set_config('lock_timeout', %s, true)", (SCHEMA_LOCK_TIMEOUT,))
            conn.execute(SCHEMA.read_text())
    except psycopg.errors.LockNotAvailable as exc:
        raise SchemaLockTimeout(
            f"leaseq could not apply its schema: a schema change waited longer than "
            f"lock_timeout={SCHEMA_LOCK_TIMEOUT} for a table lock held by another transaction, "
            f"and gave up rather than stall queue writes. Nothing was changed. Find the long "
            f"transaction (SELECT pid, state, xact_start, query FROM pg_stat_activity "
            f"WHERE xact_start IS NOT NULL ORDER BY xact_start) and start leaseq again. "
            f"Database said: {exc}") from exc
