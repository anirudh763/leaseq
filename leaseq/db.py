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


def apply_schema(conn: psycopg.Connection) -> None:
    # The advisory lock stops two processes starting at once from racing on CREATE.
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(4217)")
        conn.execute(SCHEMA.read_text())
