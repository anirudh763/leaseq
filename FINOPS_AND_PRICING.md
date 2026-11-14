# FinOps and pricing

## Current posture

The reference implementation can run locally with Docker. A static frontend can be hosted on a free static-site tier, but that does not host a durable queue API, PostgreSQL database and always-on workers. No hosted accounts, private waitlist, analytics, payment flow or cloud credentials are configured. Do not treat $0 as the cost of a permanent server deployment.

Render currently documents free web services that spin down after 15 minutes idle, use ephemeral local filesystems, and free Postgres that expires after 30 days. Free service types do not include background workers. These constraints do not provide a durable always-on LeaseQ stack ([Render free-plan documentation](https://render.com/docs/free)). Fly.io documents a $1 trial credit lasting seven days or until used, with trial Machines stopping after five minutes; it is not a permanent free hosting commitment ([Fly.io free trial](https://fly.io/docs/about/free-trial/)). Verify provider terms and prices again before any deployment decision.

## Workload-based cost model

Do not use a flat “$0.40 per million jobs” as a cost-of-goods estimate. Queue cost depends on job mix, payload/result size, retries, retention, worker duration and concurrency, database IOPS/CPU/connections/storage, network egress, backups, monitoring, and idle capacity. Estimate each component against an actual provider quote and measured workload:

`monthly cost = API compute + worker compute + database compute/storage/IOPS + backup storage + network egress + monitoring + support/operations`

For a workload estimate, record jobs/month, average and tail execution duration, bytes written per job/event, retry rate, retention period, peak concurrent workers, and expected availability. Then measure a representative run and include headroom. No deployed workload or cloud cost measurement is available yet.

## Pricing hypotheses

Free 50K jobs, Pro $19/month, and Team $79/month are proposed package hypotheses only. They are not purchasable plans, validated willingness-to-pay, costed margins, forecasts, or revenue evidence. Quotas and support costs would need to be defined before these prices could be evaluated.

## Recovery objectives

RPO/RTO are operational targets to set and test, not guarantees implied by backups or a cloud architecture diagram. Record backup age and restore duration during repeat drills. A local single-disk deployment has no synchronous Multi-AZ copy; a proposed Multi-AZ database is not provisioned and does not establish a tested recovery objective by itself.
