#!/usr/bin/env bash
# Start the Docker stack with a private API token, in one command.
#
#   scripts/up.sh                    # PostgreSQL, API, one worker, demo feeder
#   scripts/up.sh --scale demo=0     # extra arguments go to `docker compose up`
#
# 1. If .env has no LEASEQ_API_TOKEN (or there is no .env), adds a random one.
#    An existing token or .env is never overwritten. .env is chmod 600 and is
#    listed in .gitignore. `docker compose` reads .env from this directory.
# 2. Runs `docker compose up -d --build`.
# 3. Waits for /healthz, then prints the dashboard URL, where the token is
#    stored and how to stop the stack.
#
# A bare `docker compose up` without .env and without LEASEQ_API_TOKEN still
# refuses to start (docker-compose.yml has no default token).
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${LEASEQ_URL:-http://127.0.0.1:8000}"
TIMEOUT="${LEASEQ_UP_TIMEOUT:-120}"
ENV_FILE="$PWD/.env"

new_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  else python3 -c 'import secrets; print(secrets.token_hex(24))'; fi
}

if [ -f "$ENV_FILE" ] && grep -q '^LEASEQ_API_TOKEN=.' "$ENV_FILE"; then
  echo "Using the existing LEASEQ_API_TOKEN in $ENV_FILE (not changed)."
else
  token="$(new_token)"
  [ "${#token}" -ge 32 ] || { echo "could not generate a token" >&2; exit 1; }
  (
    umask 077                                  # a new .env is never world-readable
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then echo >> "$ENV_FILE"; fi
    echo "LEASEQ_API_TOKEN=$token" >> "$ENV_FILE"
  )
  unset token
  echo "Created a random LEASEQ_API_TOKEN in $ENV_FILE."
fi
chmod 600 "$ENV_FILE"

if [ -n "${LEASEQ_API_TOKEN:-}" ]; then
  echo "Note: LEASEQ_API_TOKEN is set in your shell; docker compose uses it instead of .env." >&2
fi

docker compose up -d --build "$@"

printf 'Waiting for %s/healthz ' "$URL"
for _ in $(seq 1 "$TIMEOUT"); do
  if curl -fsS "$URL/healthz" >/dev/null 2>&1; then
    echo "ok"
    cat <<EOF

leaseq is running.
  Dashboard:  $URL/dashboard/
  API token:  stored in $ENV_FILE (LEASEQ_API_TOKEN); the dashboard asks for it.
              Show it with: grep LEASEQ_API_TOKEN .env
  Smoke test: LEASEQ_API_TOKEN=\$(sed -n 's/^LEASEQ_API_TOKEN=//p' .env) scripts/smoke.sh
  Stop:       docker compose down      (keeps the data; add -v to delete it)
EOF
    exit 0
  fi
  printf '.'
  sleep 1
done
echo
echo "The API did not answer $URL/healthz within ${TIMEOUT}s. See: docker compose logs app" >&2
exit 1
