# LeaseQ PostgreSQL backup and restore

This guide is for the self-hosted Docker Compose installation. Keep backups
private: they contain job payloads, results, and audit history. For hosted
PostgreSQL, also follow the provider’s backup and recovery instructions.

## Back up

Run these commands from the directory containing `docker-compose.yml`. The
archive is a standard PostgreSQL custom-format dump. The archive file is
created with owner-only permissions; keep it in a private,
access-controlled location and include it in your normal encrypted backup plan.

```sh
umask 077
backup=$(mktemp "./leaseq-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX") || exit 1
if docker compose exec -T postgres pg_dump -U leaseq -d leaseq -Fc > "$backup"; then
  chmod 600 "$backup"
  docker compose exec -T postgres pg_restore --list < "$backup" >/dev/null
else
  echo "Backup failed; do not use this archive: $backup" >&2
  exit 1
fi
```

A failed command can leave an incomplete file. Do not restore it; retain it
privately for diagnosis or remove that failed archive. The generated filename
is unique, so a failed attempt does not overwrite an earlier backup.

Keep the source database and the dump until a restore has been checked. A
successful dump-list check confirms the archive can be read; it does not prove
the restore is usable.

## Restore and verify without replacing the current database

Restore into a newly created, empty database first. Choose a unique name with
the `leaseq_restore_` prefix. The following uses `leaseq_restore_check`; stop if
that database already exists and choose another name. Do not drop, truncate, or
overwrite the source database as part of recovery preparation.

```sh
restore_db=leaseq_restore_check
docker compose exec -T postgres createdb -U leaseq "$restore_db" &&
  docker compose exec -T postgres pg_restore --exit-on-error -U leaseq -d "$restore_db" < "$backup"
```

Point a separate LeaseQ instance at the restored database in a private local
environment and verify representative jobs, stored results, and their event
history. Compare job/effect/event counts and inspect that `job_events` remains
append-only. Confirm the application is healthy before planning any cutover.
Keep the original database intact until the restored copy has been verified and
the operator has chosen a recovery point.

The archive contains one database. PostgreSQL cluster-wide roles and other
databases are not included; record and back up those separately if the hosting
setup depends on them. Recovery to an earlier point can lose writes made after
that backup. Record the backup time and coordinate application writes when a
consistent recovery point is required.

## Local backup and restore proof

On 2026-11-14, the bounded local proof ran against LeaseQ commit `7914e8c` with
synthetic test data: 250 jobs were submitted by four submitters and processed
by two workers. All 250 finished within the 120-second ceiling (1.493 seconds
elapsed); there were no submission errors, skipped jobs, dead jobs, or backlog.
The source held 250 jobs, 250 effects, and 750 events (250 each of `enqueued`,
`claimed`, and `completed`). Submission latency was 6.348 ms median and 8.332 ms
p95 in this run. These are measurements from this local run, not a production
capacity guarantee.

A standard custom-format `pg_dump` archive (26,180 bytes, mode `0600`) was
restored into a separate empty database using `pg_restore --exit-on-error`.
The restored jobs, effects, events, all three sequence states, all public
constraints, and both append-only `job_events` triggers matched the source
snapshot exactly. This exercises the database archive and restore path; follow
the restore and application-health checks above for a deployment recovery.

The private run identifier is `20261114T080729Z-9e0b84`. Its report, raw
comparisons and archive are retained separately from this repository; neither
production backups nor job payloads belong in Git.
