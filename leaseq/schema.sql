-- leaseq schema. Idempotent: safe to apply on every start.

CREATE TABLE IF NOT EXISTS jobs (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind             TEXT        NOT NULL,
    payload          JSONB       NOT NULL DEFAULT '{}',
    state            TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('queued', 'leased', 'done', 'dead')),
    attempts         INT         NOT NULL DEFAULT 0,   -- number of times claimed
    max_attempts     INT         NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
    run_after        TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token      TEXT,                              -- fencing token of the current lease
    lease_expires_at TIMESTAMPTZ,
    leased_by        TEXT,
    idempotency_key  TEXT        NOT NULL UNIQUE,
    result           JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((state = 'leased') = (lease_token IS NOT NULL)),
    CHECK ((state = 'leased') = (lease_expires_at IS NOT NULL))
);

-- Only unfinished jobs are indexed, so the claim scan does not grow with history.
CREATE INDEX IF NOT EXISTS jobs_unfinished ON jobs (id) WHERE state IN ('queued', 'leased');

-- Audit log: one row per state change, written in the same transaction as the change.
CREATE TABLE IF NOT EXISTS job_events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id     BIGINT      NOT NULL REFERENCES jobs (id),
    event      TEXT        NOT NULL
               CHECK (event IN ('enqueued', 'claimed', 'completed', 'failed', 'dead', 'rejected')),
    attempt    INT         NOT NULL,
    worker_id  TEXT,
    detail     JSONB       NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events (job_id, id);

CREATE OR REPLACE FUNCTION job_events_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'job_events is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_events_no_update_delete ON job_events;
CREATE TRIGGER job_events_no_update_delete
    BEFORE UPDATE OR DELETE ON job_events
    FOR EACH ROW EXECUTE FUNCTION job_events_append_only();

DROP TRIGGER IF EXISTS job_events_no_truncate ON job_events;
CREATE TRIGGER job_events_no_truncate
    BEFORE TRUNCATE ON job_events
    FOR EACH STATEMENT EXECUTE FUNCTION job_events_append_only();

-- The worker's side effect. Deliberately NOT unique on job_id: nothing in this
-- table prevents a duplicate, so the chaos test measures whether the fenced
-- completion alone keeps it at exactly one row per job.
CREATE TABLE IF NOT EXISTS effects (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id     BIGINT      NOT NULL REFERENCES jobs (id),
    worker_id  TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS effects_job ON effects (job_id);
