import json
import os
import subprocess
from pathlib import Path


def test_supabase_sync_reference_protocol_boundaries_and_conflicts():
    script = Path(__file__).with_name("e2e") / "sync_provider.test.cjs"
    result = subprocess.run(["node", str(script)], text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1])["checks"] >= 15


def test_supabase_rls_reference_with_real_postgres_roles():
    """Apply the published schema in an isolated DB and exercise RLS as ordinary roles."""
    import uuid

    import psycopg
    from psycopg import sql
    from psycopg.conninfo import conninfo_to_dict

    env_file = os.environ.get("LEASEQ_TEST_ENV_FILE")
    if not env_file:
        import pytest

        pytest.skip("set LEASEQ_TEST_ENV_FILE to the dedicated disposable test environment")
    import json as json_module

    base_url = json_module.loads(Path(env_file).read_text())["LEASEQ_DATABASE_URL"]
    params = conninfo_to_dict(base_url)
    if params.get("port") != "55444" or params.get("dbname") != "leaseq":
        raise AssertionError("refusing SQL policy test outside the designated LeaseQ task database")
    db_name = "leaseq_rls_" + uuid.uuid4().hex[:12]
    role_auth = "leaseq_sync_auth_" + uuid.uuid4().hex[:8]
    role_anon = "leaseq_sync_anon_" + uuid.uuid4().hex[:8]
    admin_params = dict(params, dbname="postgres")
    admin_url = psycopg.conninfo.make_conninfo(**admin_params)
    created_roles = []
    try:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name)))
            for role in (role_auth, role_anon):
                admin.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT").format(sql.Identifier(role)))
                created_roles.append(role)
        db_params = dict(params, dbname=db_name)
        scratch_url = psycopg.conninfo.make_conninfo(**db_params)
        schema = Path(__file__).parents[1] / "leaseq" / "dashboard" / "supabase-leaseq-workspaces.sql"
        published_sql = schema.read_text()
        # Substitute unique ordinary roles so tests can run safely beside unrelated projects.
        published_sql = published_sql.replace("authenticated", role_auth).replace("anon", role_anon)
        with psycopg.connect(scratch_url, autocommit=True) as owner:
            owner.execute("CREATE SCHEMA auth")
            owner.execute("CREATE TABLE auth.users (id uuid PRIMARY KEY)")
            owner.execute("CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
            owner.execute("GRANT USAGE ON SCHEMA auth TO PUBLIC")
            owner.execute("GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC")
            owner.execute(published_sql)
            owner.execute("INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b')")
        def as_user(user_id, statements):
            with psycopg.connect(scratch_url) as conn:
                conn.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(role_auth)))
                conn.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (user_id,))
                return statements(conn)

        uid_a = "00000000-0000-0000-0000-00000000000a"
        uid_b = "00000000-0000-0000-0000-00000000000b"
        as_user(uid_a, lambda c: c.execute("INSERT INTO public.leaseq_workspaces(user_id,revision,data) VALUES (%s,1,'{}')", (uid_a,)))
        assert as_user(uid_a, lambda c: c.execute("SELECT count(*) FROM public.leaseq_workspaces").fetchone()[0]) == 1
        assert as_user(uid_b, lambda c: c.execute("SELECT count(*) FROM public.leaseq_workspaces").fetchone()[0]) == 0
        assert as_user(uid_b, lambda c: c.execute("UPDATE public.leaseq_workspaces SET revision=2 WHERE user_id=%s", (uid_a,)).rowcount) == 0
        try:
            as_user(uid_b, lambda c: c.execute("INSERT INTO public.leaseq_workspaces(user_id,revision,data) VALUES (%s,1,'{}')", (uid_a,)))
        except psycopg.errors.InsufficientPrivilege:
            pass
        else:
            raise AssertionError("authenticated user inserted another user's workspace")
        try:
            as_user(uid_b, lambda c: c.execute("INSERT INTO public.leaseq_workspaces(user_id,revision,data) VALUES (%s,1,jsonb_build_object('x',repeat('x',16384)))", (uid_b,)))
        except psycopg.errors.CheckViolation:
            pass
        else:
            raise AssertionError("decoded JSON workspace size cap was not enforced by Postgres")

        with psycopg.connect(scratch_url) as conn:
            conn.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(role_auth)))
            conn.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (uid_a,))
            try:
                conn.execute("DELETE FROM public.leaseq_workspaces WHERE user_id=%s", (uid_a,))
            except psycopg.errors.InsufficientPrivilege:
                conn.rollback()
            else:
                raise AssertionError("authenticated cloud role unexpectedly has hard-delete access")
        with psycopg.connect(scratch_url) as conn:
            conn.execute(sql.SQL("SET ROLE {}").format(sql.Identifier(role_auth)))
            conn.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (uid_a,))
            try:
                conn.execute("UPDATE public.leaseq_workspaces SET data='{}' WHERE user_id=%s", (uid_a,))
            except psycopg.errors.RaiseException as exc:
                assert "revision must increment" in str(exc)
                conn.rollback()
            else:
                raise AssertionError("revision bypass was accepted")
        updated = as_user(uid_a, lambda c: c.execute("UPDATE public.leaseq_workspaces SET revision=2, deleted_at=now(), data='{}' WHERE user_id=%s AND revision=1 RETURNING revision", (uid_a,)).fetchone())
        assert updated == (2,)
        assert as_user(uid_a, lambda c: c.execute("SELECT deleted_at IS NOT NULL FROM public.leaseq_workspaces WHERE user_id=%s", (uid_a,)).fetchone()[0]) is True
        assert as_user(uid_a, lambda c: c.execute("UPDATE public.leaseq_workspaces SET revision=3 WHERE user_id=%s AND revision=1", (uid_a,)).rowcount) == 0
        assert as_user(uid_a, lambda c: c.execute("UPDATE public.leaseq_workspaces SET revision=3 WHERE user_id=%s AND revision=2 RETURNING revision", (uid_a,)).fetchone()) == (3,)
        assert as_user(uid_b, lambda c: c.execute("SELECT count(*) FROM public.leaseq_workspaces").fetchone()[0]) == 0
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()", (db_name,))
            admin.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db_name)))
            for role in created_roles:
                admin.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))
