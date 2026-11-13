# Security policy

leaseq is a reference implementation at demo scale, maintained by one person.
It is not meant for production use, and there is no bug bounty.

## Reporting a vulnerability

Please do not put details of a vulnerability in a public issue. GitHub's
private vulnerability reporting is not switched on for this repository yet
(checked 2026-11-13). Until it is, open an issue titled "Security report,
please contact me" with no details, and I will reply with a private way to
send them. If the repository page shows **Security > Report a vulnerability**,
use that instead.

Include the commit or version (`GET /healthz` shows it), the request or
steps that show the problem, and what you expected to happen. Fixes get a
test that fails without them, as the existing security fixes do (see the
Security section of the README).

## In scope

- The HTTP API in `leaseq/api.py` and `leaseq/security.py`: bearer-token
  checks, the request body limit, input validation, error responses.
- Lease fencing in `leaseq/queue.py` and `leaseq/schema.sql`: anything that
  lets a worker whose lease was re-issued or cancelled record a result, or
  that edits the append-only `job_events` log through the API.
- The dashboard (`leaseq/dashboard/`): script injection through job data,
  token leakage (the token must stay in page memory and the Authorization
  header only), the Content-Security-Policy.
- `docker-compose.yml`, the `Dockerfile` and `scripts/up.sh` as shipped: the
  token handling in `.env`, published ports, the container user.

## Out of scope

- Anything that needs the API token already: the token is one shared secret
  with full rights (see Limitations in the README).
- Plain HTTP between client and API. leaseq does not serve TLS; put a reverse
  proxy in front of it if it is reached over a network.
- `LEASEQ_PUBLIC_READ=1` exposing job payloads: that is what it is documented to do.
- No rate limiting, and audit-log growth from wrong lease tokens (both listed
  as known limitations).
- A database superuser disabling the audit trigger.
- The demo worker kinds and `leaseq.demo`, which do no real work.
