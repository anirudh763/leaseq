# Hosting LeaseQ

This is an operator-controlled deployment template, not a deployed service or
a claim of production readiness. It defines one API, one worker and a persistent
PostgreSQL database in the same region. The demo feeder is absent. Job reads,
writes and worker calls require the shared token; the dashboard itself is public.
The token grants operator access, so share it only with trusted operators.

## Cost and account setup

`render.yaml` selects **paid** Starter web/worker services and Basic PostgreSQL.
Check the resource summary and current prices before creating them. The owner’s
proposed $20/month total hosting budget still requires confirmation of that
period and explicit approval of an itemized estimate before any financial
commitment. This template is not that approval. No account,
resources or payment have been created by this change. Free Render web services
sleep after 15 idle minutes, free databases expire after 30 days, and background
workers do not support the Free plan. They do not provide this durable stack.
See [Render's free-instance limits](https://render.com/docs/free).

1. In your Render account, choose **New → Blueprint** and connect the existing
   `anirudh763/leaseq` repository, branch `main`. Review `render.yaml`.
2. Check the paid resource summary, region and database backup/restore options.
   Creating the Blueprint provisions the resources; automatic deploys are off
   for subsequent commits, not for initial provisioning.
3. Create the resources only after accepting their costs. The shared environment
   group generates the API token. The worker uses the API's private host/port;
   the database has no public IP allow-list entries.
4. Wait for the API's `/readyz` health check, then the worker. Open
   `https://YOUR-API.onrender.com/dashboard/`. Retrieve the generated token in
   the provider's environment settings and enter it on **Connection & API**.
   Do not paste it into repository files, screenshots, issues or command lines.
5. Submit a small `word_count` job. Confirm a real worker result and a completed
   audit event. Reloading the dashboard should require the token again.
6. Check that `/jobs` without the token returns 401. Confirm worker recovery
   after a restart using a synthetic job before accepting important work.

Field definitions and private-network behaviour come from the
[Blueprint reference](https://render.com/docs/blueprint-spec) and
[private-network documentation](https://render.com/docs/private-network).
The template has local validation and container tests; an actual Render deploy
is still a separate acceptance step.

## Container and startup

`docker build --target production -t leaseq:production .` builds the existing
non-root image with runtime dependencies only. The default command listens on
`PORT` when set and otherwise port 8000. Compose still uses 8000. Workers run the
same image with the existing `python -m leaseq.worker` command.

With Docker running, `python3 scripts/hosting_smoke.py --image leaseq:production`
tests that built image using fresh disposable resources bound to loopback. It
checks a real worker result, the port override, private reads and recovery from
a database restart, then removes only its uniquely named test project and data.

The API already applies its schema during startup, before serving requests.
That existing migration path and its lock-timeout protection are unchanged.
Follow the [backup and restore guide](backup-restore.md) before upgrades; a code rollback cannot undo schema/data
changes. The API will not start without a valid token or an available database.

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
