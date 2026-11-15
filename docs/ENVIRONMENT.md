# Environment configuration

LeaseQ reads service settings from its process environment. For Docker Compose, copy the root `.env.example` to `.env`; `scripts/up.sh` fills a blank or missing `LEASEQ_API_TOKEN` with a random value, preserves an existing token, sets mode 600, and uses a shell-exported token ahead of the file. This preserves the documented quick-start behavior. Do not commit `.env`.

`LEASEQ_API_TOKEN` is required for authenticated API requests. The default Compose file forwards that token and a fixed Docker database URL with host `postgres`. Other settings in the example (database URL, body/rate budgets, public-read mode, retry backoff and count-cache age) apply to directly launched processes; adding them to Compose's `.env` alone does not pass them into containers. To configure a container, declare the chosen setting explicitly in that service's `environment` section or a Compose override. A container database URL must use the reachable Docker service hostname, rather than host-loopback `127.0.0.1`. Leave optional settings unset to use the code defaults.

The optional n8n configuration is separate at [integrations/n8n/.env.example](../integrations/n8n/.env.example). It does not connect LeaseQ to n8n or enable workflows. Keep API keys in n8n's credential store, not workflow `$env` expressions or browser code.
