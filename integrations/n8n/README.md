# Optional local n8n configuration

This directory contains configuration examples only. The repository does not install or run n8n, provide a workflow, or connect n8n to this application. One optional n8n installation may serve all five apps; these templates do not mean launching five instances. The `.env.example` uses standard dotenv `KEY=value` syntax as a configuration template. n8n does not automatically load an arbitrary `.env` file from this directory; supply these values through the existing process or container environment mechanism for a separately installed local n8n instance.

The example binds the editor to `127.0.0.1` and uses HTTP with `N8N_SECURE_COOKIE=false` for loopback development only. For remote access, configure HTTPS, secure cookies, and real domain-based editor and webhook URLs; do not expose the local HTTP settings publicly.

n8n generates and persists its encryption key in its private settings file when no key is supplied. Preserve and back up that key securely; replacing it can make stored credentials unreadable. Store API keys in n8n's credential store, not workflow `$env` expressions or frontend code.

See the [repository environment guide](../../docs/ENVIRONMENT.md) for app-specific variables. n8n settings are independent of the app and do not activate an integration. For current settings and key handling, see the official n8n documentation on [deployment](https://docs.n8n.io/hosting/configuration/environment-variables/deployment/), [security](https://docs.n8n.io/hosting/configuration/environment-variables/security/), [endpoints](https://docs.n8n.io/hosting/configuration/environment-variables/endpoints/), and [encryption keys](https://docs.n8n.io/hosting/configuration/configuration-examples/encryption-key/).
