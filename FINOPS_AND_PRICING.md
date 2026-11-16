# Hosting boundaries

## Current posture

The `$0` description applies only to running LeaseQ locally or to a temporary,
disposable demo using resources you already control. No hosted accounts,
private waitlist, analytics, payment flow or cloud credentials are configured.
There is no claim that a free static tier or temporary credits cover the full
stack of a durable API, PostgreSQL database and running workers. Provider
entitlements and prices change; check current terms and obtain an actual quote
before choosing a deployment. No permanent free Render or Fly server-plus-worker
entitlement is promised here.

## Workload-based cost model

Do not use a flat “$0.40 per million jobs” as a cost-of-goods estimate. Queue cost depends on job mix, payload/result size, retries, retention, worker duration and concurrency, database IOPS/CPU/connections/storage, network egress, backups, monitoring, and idle capacity. Estimate each component against an actual provider quote and measured workload:

`monthly cost = API compute + worker compute + database compute/storage/IOPS + backup storage + network egress + monitoring + support/operations`

For a workload estimate, record jobs/month, average and tail execution duration, bytes written per job/event, retry rate, retention period, peak concurrent workers, and expected availability. Then measure a representative run and include headroom. No deployed workload or cloud cost measurement is available yet.

The local kind/due claim benchmark in the README exercised up to 1M small
rows on one host. It found a useful read-plan change for the tested kind and
due-time distributions, with roughly 7.1 MB of additional index storage per
million rows. Sustained write amplification, managed database pricing, multi-
host behavior and cloud capacity were not measured; these results cannot be
used as a cloud cost or throughput estimate.

## Feature availability

All available features are free. There are no paid tiers, subscriptions, trials, paid quotas or upgrade gates. This does not promise free hosted infrastructure: the verified workflow is local or operator-controlled, and no public hosted service or cloud budget is provisioned. Reliability bounds apply equally to every user.

## Recovery objectives

RPO/RTO are planning questions, not guarantees implied by backups or a cloud
architecture diagram. No revenue, availability, RPO or RTO guarantee is made.
Record backup age and restore duration during repeat drills. A local single-
disk deployment has no synchronous Multi-AZ copy; a proposed Multi-AZ database
is not provisioned and does not establish a tested recovery objective by itself.
