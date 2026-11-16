# Hosting LeaseQ

This is an operator-controlled deployment template, not a deployed service or
a claim of production readiness. It defines one API, one worker and a persistent
PostgreSQL database in the same region. The demo feeder is absent. Job reads,
writes and worker calls require the shared token; the dashboard itself is public.
The token grants operator access, so share it only with trusted operators.

## Public entry status

The previously supplied `trycloudflare.com` URL failed DNS resolution on 2026-11-15. A Quick Tunnel is temporary and its generated hostname changes; do not use that URL as a durable share link. `docs/cloudflared.example.yml` is a credential-free template for a named tunnel and an operator-owned DNS hostname. It requires a Cloudflare account, a domain configured there, a real tunnel ID and credentials stored outside this repository. None of those were available here, and no tunnel or deployment was created. The template is therefore not an active or verified public entry point.

The API rate buckets use the connection address and ignore forwarded headers; behind a tunnel, clients may share the tunnel process address for admission. The default shared bearer token is not tenant isolation. Keep the service for trusted operators until a scoped identity and proxy-attribution design is separately established.

## Hosting template status

`render.yaml` is an unverified provider template that selects paid web, worker
and database resources. It is not part of a free launch path, has not been
deployed, and must not be applied as part of local verification. No hosted
service or public URL is available from this repository. A future operator may
evaluate a provider configuration separately; its resource and account costs
are not authorized or included here. For a stable public entry, first configure
an owner-controlled hostname and named tunnel as described in the section
above, then separately deploy and verify the API, assets, authentication and
reload from outside the host.

## Container and startup

`docker build --target production -t leaseq:production .` builds the existing
non-root image with runtime dependencies only. The default command listens on
`PORT` when set and otherwise port 8000. Compose still uses 8000. Workers run the
same image with the existing `python -m leaseq.worker` command.

With Docker running, `python3 scripts/hosting_smoke.py --image leaseq:production`
builds the production image through the actual base and production Compose
files, with temporary credentials, a fresh database volume, and an isolated
loopback host port. It checks a real worker result, private reads, both
container roles, and recovery from a database restart, then removes only its
uniquely named test project and data.

The Compose API and worker use the distinct `leaseq_app` login, configured
with a private random `LEASEQ_APP_PASSWORD` in `.env`. It owns only the LeaseQ
database objects and has no superuser, role-creation, database-creation or
replication privilege. A short-lived `db-bootstrap` service connects with the
existing local `leaseq` cluster-bootstrap account before the API starts. It
creates/updates the app login and transfers existing object ownership without
dropping rows or resetting the volume. The database has no published host
port. This is local least privilege, not a claim that the stack is production
ready: the default Compose file preserves its fixed local bootstrap credential
for development and legacy-volume compatibility. Do not expose that default
configuration. Use the production override below for a new deployment.

For a volume from an earlier Compose run, verify a backup, stop `app`, `worker`
and `demo`, keep the same project name, `pgdata` volume and `.env`, then run
`scripts/up.sh`. The bootstrap step is idempotent. It performs ownership DDL;
schedule it as a brief startup migration and do not run it concurrently with an
older API process. Never use `docker compose down -v` as a migration step.

The API applies its schema during startup as the `leaseq_app` database owner,
before serving requests. That migration path and lock-timeout protection are
unchanged.
Follow the [backup and restore guide](backup-restore.md) before upgrades; a code rollback cannot undo schema/data
changes. The API will not start without a valid token or an available database.

### Recommended Compose configuration for a fresh production volume

Use the production override for a new volume. It removes the development
bootstrap password and requires an explicit administrator password of at least
64 hexadecimal characters. Create it in a protected shell, and retain the same
value in the operator's secret manager for later restarts:

```sh
export LEASEQ_POSTGRES_PASSWORD="$(openssl rand -hex 32)"
scripts/up.sh --production
```

The launcher rejects a missing or weak password before it writes `.env` or
starts containers. The API token and ordinary app-role password are generated
in `.env` with mode 600. The PostgreSQL administrator password is supplied
only to the database and the short-lived bootstrap service; API and worker
containers receive the random `leaseq_app` DSN and API token. The database has
no host-published port. To omit the demo feeder, append `--scale demo=0`.
Production Compose mode changes no existing password automatically and does
not reset a volume.

For an existing volume, take and verify a backup first, then stop `app`,
`worker` and `demo`. The bootstrap password must match the PostgreSQL role's
current password. A volume created with the earlier development Compose file
still has the weak `leaseq` bootstrap password unless its owner changed it;
do not carry that password into production. Rotate it interactively while the
old stack is available:

```sh
docker compose stop app worker demo
docker compose exec postgres psql -U leaseq -d postgres
```

At the `psql` prompt, run `\password leaseq`, enter the strong generated value
without echoing or recording it in shell history, then `\q`. Export that same
value as `LEASEQ_POSTGRES_PASSWORD` from the protected secret manager and run
`scripts/up.sh --production`. Keep the existing Compose project name, `.env`
and `pgdata` volume. The bootstrap migrates object ownership and does not
delete data. If the old admin password was already changed, use its matching
secret or rotate it through the existing administrator access before startup.
Do not use `docker compose down -v` as an upgrade step. This is a deployment
procedure, not a migration that has been applied to any user volume here.

| Probe | Meaning | Database access |
|---|---|---|
| `/livez` | The HTTP process answers | None |
| `/readyz` | A pooled connection can execute a small query | Yes; returns a generic 503 on failure |
| `/healthz` | Existing database-backed health and version check | Unchanged |

The probes expose no jobs or credentials. Readiness has a two-second pool wait
and statement timeout; these do not promise a bound for every network-partition
scenario. Monitor readiness separately from process liveness.

## Before opening it to more users

Keep this deployment private to trusted operators. There is one shared token,
no per-user roles, quotas or tenant isolation. Queue fencing rejects stale
completion writes; it cannot undo an external side effect a worker already made.

Start with one API and one worker. Observe queue delay, database connections,
claim latency, error rates and storage before increasing workers. Counts are
cached per API process; adding replicas increases aggregate database queries.
Local benchmark results are not HTTP service-level guarantees.

Jobs and audit events currently have no automatic retention. Monitor database
space and arrange verified backups. The guide records a local full-database
archive/restore proof, including audit history, sequences and triggers. It does
not implement terminal-job archives, automatic retention or deletion. A separate
retention policy must preserve audit guarantees; this change does not prune
records or weaken append-only triggers.
