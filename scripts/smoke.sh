#!/usr/bin/env bash
# Smoke test against a running stack (docker compose up): submit one job twice
# with the same key, wait for the worker to finish it, check the stats.
set -euo pipefail
API="${1:-http://127.0.0.1:8000}"

for _ in $(seq 1 60); do
  curl -fsS "$API/stats" >/dev/null 2>&1 && break
  sleep 1
done

post() {
  curl -fsS -X POST "$API/jobs" -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: smoke-1' -d '{"kind": "sleep", "payload": {"ms": 50}}'
}
id1=$(post | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
id2=$(post | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ "$id1" = "$id2" ] || { echo "idempotency broken: $id1 != $id2"; exit 1; }

for _ in $(seq 1 30); do
  state=$(curl -fsS "$API/jobs/$id1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
  [ "$state" = "done" ] && { echo "smoke test passed: job $id1 is done"; curl -fsS "$API/stats"; echo; exit 0; }
  sleep 1
done
echo "job $id1 did not finish, state=$state"; exit 1
