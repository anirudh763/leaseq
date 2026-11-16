"""Fresh-DB Compose role migration and authenticated queue flow on real PostgreSQL."""
import json
import os
import re
import secrets
from pathlib import Path

import pytest


def test_compose_bootstrap_role_and_queue_flow_on_fresh_database(monkeypatch):
    env_file = os.environ.get("LEASEQ_TEST_ENV_FILE")
    if not env_file:
        pytest.skip("set LEASEQ_TEST_ENV_FILE to the designated disposable test environment")

    import psycopg
    from psycopg import sql
    from psycopg.conninfo import conninfo_to_dict
    from fastapi.testclient import TestClient

    from leaseq import db
    from leaseq.api import app

    base = json.loads(Path(env_file).read_text())["LEASEQ_DATABASE_URL"]
    params = conninfo_to_dict(base)
    if params.get("port") != "55444" or params.get("dbname") != "leaseq":
        raise AssertionError("refusing role test outside the designated LeaseQ task database")

    suffix = secrets.token_hex(4)
    db_name = f"leaseq_boot_{suffix}"
    admin_role = f"leaseq_admin_{suffix}"
    app_role = f"leaseq_app_{suffix}"
    app_password = secrets.token_hex(24)
    admin_url = psycopg.conninfo.make_conninfo(**dict(params, dbname="postgres"))
    admin_db_url = psycopg.conninfo.make_conninfo(**dict(params, dbname=db_name))
    database_url = psycopg.conninfo.make_conninfo(**dict(params, dbname=db_name, user=app_role, password=app_password))
    created_db = False
    created_roles = []
    api_token = "compose-role-test-" + secrets.token_hex(16)

    try:
        with psycopg.connect(admin_url, autocommit=True) as root:
            root.execute(sql.SQL("CREATE ROLE {} NOLOGIN SUPERUSER").format(sql.Identifier(admin_role)))
            created_roles.append(admin_role)
            root.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(db_name), sql.Identifier(admin_role)))
            created_db = True

        bootstrap = (Path(__file__).parents[1] / "scripts" / "compose_db_bootstrap.sql").read_text()
        bootstrap = re.sub(r"\bleaseq_app\b", app_role, bootstrap)
        bootstrap = re.sub(r"\bleaseq\b", admin_role, bootstrap)
        bootstrap = bootstrap.replace("ALTER DATABASE " + admin_role,
                                      "ALTER DATABASE " + db_name)
        bootstrap = bootstrap.replace("GRANT CONNECT ON DATABASE " + admin_role,
                                      "GRANT CONNECT ON DATABASE " + db_name)

        with psycopg.connect(admin_db_url, autocommit=True) as owner:
            # Seed one preexisting object as the old Compose owner, then run the
            # same role bootstrap SQL as the Compose one-shot service.
            owner.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(admin_role)))
            owner.execute("CREATE TABLE public.bootstrap_owner_probe "
                          "(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)")
            owner.execute("CREATE FUNCTION public.bootstrap_owner_function() RETURNS integer "
                          "LANGUAGE SQL IMMUTABLE AS 'SELECT 7'")
            owner.execute("RESET ROLE")
            setting = re.search(r"current_setting\('([^']+)'\)", bootstrap).group(1)
            owner.execute("SELECT set_config(%s, %s, false)", (setting, app_password))
            bootstrap_marker = "$bootstrap$;"
            cut = bootstrap.index(bootstrap_marker) + len(bootstrap_marker)
            owner.execute(bootstrap[:cut])
            created_roles.append(app_role)
            transfer_marker = "$transfer$;"
            transfer_end = bootstrap.index(transfer_marker, cut) + len(transfer_marker)
            owner.execute(bootstrap[cut:transfer_end])
            for statement in bootstrap[transfer_end:].split(";"):
                if statement.strip():
                    owner.execute(statement)

        # Repeating the startup migration must be harmless after ownership has
        # moved and the app role already exists.
        with psycopg.connect(admin_db_url, autocommit=True) as owner:
            owner.execute("SELECT set_config(%s, %s, false)", (setting, app_password))
            owner.execute(bootstrap[:cut])
            owner.execute(bootstrap[cut:transfer_end])
            for statement in bootstrap[transfer_end:].split(";"):
                if statement.strip():
                    owner.execute(statement)

        with psycopg.connect(database_url, autocommit=True) as app_conn:
            flags = app_conn.execute(
                "SELECT current_user, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, "
                "(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) "
                "FROM pg_roles r WHERE r.rolname=current_user").fetchone()
            assert flags == (app_role, False, False, False, False, app_role)
            assert app_conn.execute(
                "SELECT pg_get_userbyid(c.relowner) FROM pg_class c "
                "WHERE c.oid='public.bootstrap_owner_probe'::regclass").fetchone()[0] == app_role
            assert app_conn.execute(
                "SELECT pg_get_userbyid(c.relowner) FROM pg_class c "
                "WHERE c.oid=pg_get_serial_sequence('public.bootstrap_owner_probe','id')::regclass"
            ).fetchone()[0] == app_role
            assert app_conn.execute(
                "SELECT pg_get_userbyid(p.proowner) FROM pg_proc p "
                "WHERE p.oid='public.bootstrap_owner_function()'::regprocedure"
            ).fetchone()[0] == app_role
            db.apply_schema(app_conn)

        monkeypatch.setenv("LEASEQ_DATABASE_URL", database_url)
        monkeypatch.setenv("LEASEQ_API_TOKEN", api_token)
        with TestClient(app, headers={"Authorization": f"Bearer {api_token}"}) as client:
            submitted = client.post("/jobs", headers={"Idempotency-Key": "fresh-role-flow"},
                                    json={"kind": "role_probe", "payload": {"ok": True}})
            assert submitted.status_code == 201, submitted.text
            job_id = submitted.json()["id"]
            claimed = client.post("/jobs/claim", json={"worker_id": "role-proof-worker",
                                                        "lease_seconds": 30})
            assert claimed.status_code == 200, claimed.text
            lease = claimed.json()
            assert lease["id"] == job_id and lease["state"] == "leased"
            completed = client.post(f"/jobs/{job_id}/complete",
                                    json={"lease_token": lease["lease_token"],
                                          "result": {"proof": "app-role"}})
            assert completed.status_code == 200, completed.text
            result = client.get(f"/jobs/{job_id}")
            assert result.status_code == 200
            assert result.json()["state"] == "done"
            assert result.json()["result"] == {"proof": "app-role"}
    finally:
        if created_db:
            with psycopg.connect(admin_url, autocommit=True) as root:
                root.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                             "WHERE datname=%s AND pid<>pg_backend_pid()", (db_name,))
                root.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db_name)))
        if created_roles:
            with psycopg.connect(admin_url, autocommit=True) as root:
                for role in reversed(created_roles):
                    root.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))


def test_production_compose_requires_bootstrap_secret_and_isolates_roles():
    import shutil
    import subprocess

    docker = shutil.which("docker")
    if not docker:
        pytest.skip("Docker Compose is required to inspect the production override")
    root = Path(__file__).parents[1]
    compose_files = ["-f", str(root / "docker-compose.yml"),
                     "-f", str(root / "docker-compose.production.yml")]
    environment = {key: value for key, value in os.environ.items()
                   if key not in {"LEASEQ_POSTGRES_PASSWORD", "LEASEQ_APP_PASSWORD", "LEASEQ_API_TOKEN"}}
    environment.update({"LEASEQ_APP_PASSWORD": secrets.token_hex(24),
                        "LEASEQ_API_TOKEN": secrets.token_hex(32)})

    missing = subprocess.run([docker, "compose", *compose_files, "config", "--quiet"],
                             env=environment, capture_output=True, text=True, timeout=30)
    assert missing.returncode != 0, "production Compose accepted a missing database secret"
    assert "LEASEQ_POSTGRES_PASSWORD" in missing.stderr, "missing-secret error was not actionable"

    bootstrap_secret = secrets.token_hex(32)
    environment["LEASEQ_POSTGRES_PASSWORD"] = bootstrap_secret
    rendered = subprocess.run([docker, "compose", *compose_files, "config", "--format", "json"],
                              env=environment, capture_output=True, text=True, timeout=30)
    assert rendered.returncode == 0, "production Compose could not render with a supplied secret"
    config = json.loads(rendered.stdout)
    services = config["services"]
    postgres_env = services["postgres"]["environment"]
    bootstrap_env = services["db-bootstrap"]["environment"]
    assert postgres_env["POSTGRES_PASSWORD"] == bootstrap_secret, "database did not receive explicit bootstrap credential"
    assert bootstrap_env["PGPASSWORD"] == bootstrap_secret, "bootstrap did not receive matching credential"
    assert "ports" not in services["postgres"], "database must stay off host-published ports"
    assert bootstrap_secret not in services["db-bootstrap"]["command"], "bootstrap command exposed password"
    for service in ("app", "worker"):
        app_env = services[service]["environment"]
        dsn = app_env["LEASEQ_DATABASE_URL"]
        assert dsn.startswith("postgresql://leaseq_app:"), "runtime service is not configured as the app role"
        assert bootstrap_secret not in dsn, "runtime DSN contains administrator password"
        assert "POSTGRES_PASSWORD" not in app_env and "PGPASSWORD" not in app_env, \
            "runtime service received database bootstrap credentials"
    assert bootstrap_secret not in rendered.stderr, "Compose diagnostic printed bootstrap secret"
