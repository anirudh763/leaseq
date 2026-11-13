#!/usr/bin/env bash
# Start the Docker stack with a private API token, in one command.
#
#   scripts/up.sh                    # PostgreSQL, API, one worker, demo feeder
#   scripts/up.sh --scale demo=0     # extra arguments go to `docker compose up`
#
# Where the token comes from (one source, never printed):
#  - LEASEQ_API_TOKEN exported in your shell: Compose uses it ahead of .env, so
#    this script uses it too and leaves .env alone. It must be 16+ characters.
#  - Otherwise .env: an existing non-blank LEASEQ_API_TOKEN is kept as it is.
#    If .env is missing, has no LEASEQ_API_TOKEN line, or has a blank one (as
#    after `cp .env.example .env`), a random token is written: a blank line is
#    filled in place and every other line is kept. .env is chmod 600 and is
#    listed in .gitignore. Two LEASEQ_API_TOKEN lines are refused.
# Then: `docker compose up -d --build [args]`, wait for /healthz (each request
# is capped at 5 s, the whole wait at LEASEQ_UP_TIMEOUT, default 120 s), and
# print the dashboard URL, where the token is and how to stop the stack.
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
die() { echo "scripts/up.sh: $*" >&2; exit 1; }
blank() { [ -z "$(printf '%s' "$1" | tr -d "[:space:]\"'")" ]; }

if [ -n "${LEASEQ_API_TOKEN+set}" ]; then
  # Compose would use this value instead of .env, so it is the only source.
  if blank "$LEASEQ_API_TOKEN"; then
    die "LEASEQ_API_TOKEN is set in your shell but blank. Run 'unset LEASEQ_API_TOKEN' to use .env, or export a real token."
  fi
  [ "${#LEASEQ_API_TOKEN}" -ge 16 ] || \
    die "LEASEQ_API_TOKEN in your shell is shorter than 16 characters; the API would refuse it."
  TOKEN_SOURCE=shell
  echo "Using LEASEQ_API_TOKEN from your shell environment; .env is not read or changed."
  if [ -f "$ENV_FILE" ] && grep -q '^LEASEQ_API_TOKEN=' "$ENV_FILE"; then
    echo "The LEASEQ_API_TOKEN in $ENV_FILE is ignored while the shell variable is set."
  fi
else
  TOKEN_SOURCE=env-file
  count=0
  if [ -f "$ENV_FILE" ]; then count=$(grep -c '^LEASEQ_API_TOKEN=' "$ENV_FILE" || true); fi
  [ "$count" -le 1 ] || die "$ENV_FILE has more than one LEASEQ_API_TOKEN line; keep one and run again."
  current=""
  if [ "$count" = 1 ]; then current=$(sed -n 's/^LEASEQ_API_TOKEN=//p' "$ENV_FILE"); fi
  if [ "$count" = 1 ] && ! blank "$current"; then
    echo "Using the existing LEASEQ_API_TOKEN in $ENV_FILE (not changed)."
  else
    token="$(new_token)"
    [ "${#token}" -ge 32 ] || die "could not generate a token"
    if [ "$count" = 1 ]; then
      # Fill the blank line in place: write a private copy, then replace .env.
      tmp="$(umask 077 && mktemp "$ENV_FILE.XXXXXX")"
      if ! TOKEN="$token" awk '/^LEASEQ_API_TOKEN=/ { print "LEASEQ_API_TOKEN=" ENVIRON["TOKEN"]; next } { print }' \
          "$ENV_FILE" > "$tmp"; then
        rm -f "$tmp"; die "could not update $ENV_FILE"
      fi
      chmod 600 "$tmp"
      mv "$tmp" "$ENV_FILE"
      echo "Filled in the blank LEASEQ_API_TOKEN in $ENV_FILE with a random token."
    else
      (
        umask 077                              # a new .env is never world-readable
        if [ -s "$ENV_FILE" ] && [ -n "$(tail -c1 "$ENV_FILE")" ]; then echo >> "$ENV_FILE"; fi
        echo "LEASEQ_API_TOKEN=$token" >> "$ENV_FILE"
      )
      echo "Created a random LEASEQ_API_TOKEN in $ENV_FILE."
    fi
    unset token
  fi
  unset current count
  chmod 600 "$ENV_FILE"
fi

docker compose up -d --build "$@"

printf 'Waiting for %s/healthz ' "$URL"
deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  left=$((deadline - SECONDS))
  if [ "$left" -gt 5 ]; then left=5; fi
  if [ "$left" -lt 1 ]; then left=1; fi
  if curl -fsS --connect-timeout "$left" --max-time "$left" "$URL/healthz" >/dev/null 2>&1; then
    echo "ok"
    if [ "$TOKEN_SOURCE" = shell ]; then
      where="LEASEQ_API_TOKEN in your shell environment (not .env); the dashboard asks for it."
      smoke="scripts/smoke.sh   (reads LEASEQ_API_TOKEN from your shell)"
    else
      where="$ENV_FILE (LEASEQ_API_TOKEN); the dashboard asks for it."
      smoke="LEASEQ_API_TOKEN=\$(sed -n 's/^LEASEQ_API_TOKEN=//p' .env) scripts/smoke.sh"
    fi
    printf '\nleaseq is running.\n'
    printf '  Dashboard:  %s/dashboard/\n' "$URL"
    printf '  API token:  %s\n' "$where"
    printf '  Smoke test: %s\n' "$smoke"
    printf '  Stop:       docker compose down      (keeps the data; add -v to delete it)\n'
    exit 0
  fi
  printf '.'
  if [ "$SECONDS" -lt "$deadline" ]; then sleep 1; fi
done
echo
echo "The API did not answer $URL/healthz within ${TIMEOUT}s. See: docker compose logs app" >&2
exit 1
