#!/usr/bin/env bash
# Smoke test against a running stack (docker compose up): writes need the token,
# submit one job twice with the same key, wait for the worker to finish it,
# check the stats and that the dashboard is served.
set -euo pipefail
API="${1:-http://127.0.0.1:8000}"
TOKEN="${LEASEQ_API_TOKEN:-leaseq-dev-token-change-me}"   # the compose default
AUTH="Authorization: Bearer $TOKEN"

for _ in $(seq 1 60); do
  curl -fsS "$API/healthz" >/dev/null 2>&1 && break
  sleep 1
done

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/jobs" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: smoke-noauth' -d '{"kind": "noop"}')
[ "$code" = "401" ] || { echo "expected 401 without a token, got $code"; exit 1; }

post() {
  curl -fsS -X POST "$API/jobs" -H 'Content-Type: application/json' -H "$AUTH" \
    -H 'Idempotency-Key: smoke-1' -d '{"kind": "sleep", "payload": {"ms": 50}}'
}
id1=$(post | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
id2=$(post | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ "$id1" = "$id2" ] || { echo "idempotency broken: $id1 != $id2"; exit 1; }

curl -fsS "$API/dashboard/" | grep -q '<title>leaseq operations</title>' \
  || { echo "dashboard not served"; exit 1; }

for _ in $(seq 1 120); do   # the demo batch is ahead of this job on the one worker
  state=$(curl -fsS -H "$AUTH" "$API/jobs/$id1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
  [ "$state" = "done" ] && { echo "smoke test passed: job $id1 is done"; curl -fsS -H "$AUTH" "$API/stats"; echo; exit 0; }
  sleep 1
done
echo "job $id1 did not finish, state=$state"; exit 1
