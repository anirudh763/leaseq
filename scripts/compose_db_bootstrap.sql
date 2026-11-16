-- Local Compose role setup/migration. Run as the existing cluster bootstrap
-- administrator, connected to the LeaseQ database. Safe to repeat; no data is
-- dropped. PGOPTIONS supplies the validated password; it is never interpolated
-- into or printed by SQL text.
DO $bootstrap$
DECLARE
    app_password text := current_setting('leaseq.app_password');
BEGIN
    IF app_password !~ '^[0-9a-fA-F]{32,}$' THEN
        RAISE EXCEPTION 'invalid LeaseQ Compose role bootstrap configuration';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leaseq_app') THEN
        EXECUTE format(
            'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
            'leaseq_app', app_password);
    ELSE
        EXECUTE format(
            'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
            'leaseq_app', app_password);
    END IF;
END
$bootstrap$;

-- Transfer only LeaseQ's supported table/sequence/function objects in public.
-- REASSIGN OWNED is intentionally avoided: the bootstrap role may also own
-- extension/system objects that PostgreSQL refuses to transfer.
DO $transfer$
DECLARE
    item record;
BEGIN
    FOR item IN
        SELECT n.nspname, c.relname, c.relkind
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relowner = 'leaseq'::regrole
          AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend AS d
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE format('ALTER TABLE %I.%I OWNER TO leaseq_app', item.nspname, item.relname);
    END LOOP;

    -- Table ownership already moves owned identity/serial sequences; this pass
    -- handles only sequences that remain owned by the former app role.
    FOR item IN
        SELECT n.nspname, c.relname
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relowner = 'leaseq'::regrole
          AND c.relkind = 'S'
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend AS d
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
          )
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend AS d
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO leaseq_app', item.nspname, item.relname);
    END LOOP;

    FOR item IN
        SELECT n.nspname, p.proname, p.prokind,
               pg_get_function_identity_arguments(p.oid) AS identity_arguments
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proowner = 'leaseq'::regrole
          AND p.prokind IN ('f', 'p')
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend AS d
              WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE format('%s %I.%I(%s) OWNER TO leaseq_app',
            CASE WHEN item.prokind = 'p' THEN 'ALTER PROCEDURE' ELSE 'ALTER FUNCTION' END,
            item.nspname, item.proname, item.identity_arguments);
    END LOOP;
END
$transfer$;

-- ALTER DATABASE must execute outside the DO blocks above.
ALTER DATABASE leaseq OWNER TO leaseq_app;
ALTER SCHEMA public OWNER TO leaseq_app;
GRANT CONNECT ON DATABASE leaseq TO leaseq_app;
