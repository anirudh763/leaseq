#!/usr/bin/env bash
# End-to-end check of a running stack (CI runs it against `docker compose up`).
# Needs LEASEQ_API_TOKEN, the token the stack was started with. Prints one
# "PASS <check>" line per assertion and exits non-zero on the first failure.
#
#   auth     anonymous write and read get 401; the token works
#   dash     /dashboard/ and its JS and CSS are served without a token
#   idem     the same Idempotency-Key twice gives the same job
#   events   a job reaches done; its audit log is enqueued, claimed, completed
#   words    a word_count job is done with the exact counts as its result
#   retry    a job that fails once is retried with backoff and ends done
#   cancel   a running job is cancelled; the worker's late result is rejected
#   requeue  the cancelled job is requeued and runs to done
set -euo pipefail
API="${1:-http://127.0.0.1:8000}"
TOKEN="${LEASEQ_API_TOKEN:?set LEASEQ_API_TOKEN to the token the stack was started with}"
AUTH="Authorization: Bearer $TOKEN"
RUN="$(date +%s)-$$"                       # unique keys, so reruns are independent
TIMEOUT="${SMOKE_TIMEOUT:-240}"            # seconds to wait for any one state

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
api() { curl -fsS -H "$AUTH" "$@"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
submit() {   # submit KEY JSON -> job id
  api -X POST "$API/jobs" -H 'Content-Type: application/json' -H "Idempotency-Key: $1" -d "$2" | field '["id"]'
}
state() { api "$API/jobs/$1" | field '["state"]'; }
events() {   # events ID -> "enqueued claimed completed ..."
  api "$API/jobs/$1/events?limit=500" | python3 -c \
    'import json,sys; print(" ".join(e["event"] for e in json.load(sys.stdin)["events"]))'
}
wait_state() {   # wait_state ID STATE
  local s=""
  for _ in $(seq 1 $((TIMEOUT * 2))); do
    s=$(state "$1"); [ "$s" = "$2" ] && return 0; sleep 0.5
  done
  fail "job $1 did not reach $2 within ${TIMEOUT}s (state=$s, events: $(events "$1"))"
}

for _ in $(seq 1 60); do curl -fsS "$API/healthz" >/dev/null 2>&1 && break; sleep 1; done

# --- auth ------------------------------------------------------------------
c=$(code -X POST "$API/jobs" -H 'Content-Type: application/json' -H 'Idempotency-Key: x' -d '{"kind":"noop"}')
[ "$c" = 401 ] || fail "auth: anonymous POST /jobs gave $c"
c=$(code "$API/jobs"); [ "$c" = 401 ] || fail "auth: anonymous GET /jobs gave $c"
c=$(code "$API/stats"); [ "$c" = 401 ] || fail "auth: anonymous GET /stats gave $c"
c=$(code -H "Authorization: Bearer wrong-token-0123456789" "$API/jobs"); [ "$c" = 401 ] || fail "auth: wrong token gave $c"
c=$(code -H "$AUTH" "$API/jobs"); [ "$c" = 200 ] || fail "auth: right token gave $c"
pass "auth: anonymous POST /jobs, GET /jobs, GET /stats and a wrong token -> 401; the token -> 200"

# --- dashboard files ---------------------------------------------------------
# Read the whole page first: `curl | grep -q` fails under pipefail when grep
# stops early and curl gets SIGPIPE.
page=$(curl -fsS "$API/dashboard/") || fail "dash: GET /dashboard/"
case "$page" in *'<title>leaseq operations</title>'*) ;; *) fail "dash: index.html has no title";; esac
for f in app.js app.css ui.css; do
  c=$(code "$API/dashboard/assets/$f"); [ "$c" = 200 ] || fail "dash: assets/$f gave $c"
done
pass "dash: /dashboard/, assets/app.js, assets/app.css, assets/ui.css -> 200 without a token"

# --- idempotency ---------------------------------------------------------------
body='{"kind": "sleep", "payload": {"ms": 50}}'
id1=$(submit "smoke-$RUN-idem" "$body"); id2=$(submit "smoke-$RUN-idem" "$body")
[ "$id1" = "$id2" ] || fail "idem: $id1 != $id2"
pass "idem: same Idempotency-Key twice -> job $id1 both times"

# --- (a) a job runs; its events show claim and completion ---------------------
wait_state "$id1" done
ev=$(events "$id1")
[ "$ev" = "enqueued claimed completed" ] || fail "events: job $id1 events are '$ev'"
pass "events: job $id1 done; audit log = '$ev'"

# --- word_count: the bundled handler that does real work ------------------------
wid=$(submit "smoke-$RUN-words" '{"kind": "word_count", "payload": {"text": "to be or\nnot to be"}}')
wait_state "$wid" done
res=$(api "$API/jobs/$wid" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["result"], sort_keys=True))')
[ "$res" = '{"lines": 2, "words": 6}' ] || fail "words: job $wid result is $res"
ev=$(events "$wid")
[ "$ev" = "enqueued claimed completed" ] || fail "words: job $wid events are '$ev'"
pass "words: word_count job $wid done; result $res; audit log = '$ev'"

# --- (b) retry: fails on attempt 1, succeeds on attempt 2 ----------------------
rid=$(submit "smoke-$RUN-retry" '{"kind": "fail_first_n", "payload": {"n": 1}, "max_attempts": 3}')
wait_state "$rid" done
attempts=$(api "$API/jobs/$rid" | field '["attempts"]')
ev=$(events "$rid")
[ "$attempts" -ge 2 ] || fail "retry: attempts=$attempts"
[ "$ev" = "enqueued claimed failed claimed completed" ] || fail "retry: events '$ev'"
pass "retry: job $rid done after $attempts attempts; audit log = '$ev'"

# --- (c) cancel a job the worker is running; its late result is rejected -------
# 8 s of work is shorter than the worker's first heartbeat (lease 30 s / 3), so
# the worker finishes and tries to complete with the lease token it was given.
sid=$(submit "smoke-$RUN-slow" '{"kind": "sleep", "payload": {"ms": 8000}}')
wait_state "$sid" leased
cancelled=$(api -X POST "$API/jobs/$sid/cancel" -H 'Content-Type: application/json' -d '{"reason": "smoke test"}' | field '["state"]')
[ "$cancelled" = dead ] || fail "cancel: state after cancel is $cancelled"
for _ in $(seq 1 60); do
  ev=$(events "$sid"); case "$ev" in *"cancelled rejected"*) break;; esac; sleep 0.5
done
case "$ev" in *"claimed cancelled rejected"*) ;; *) fail "cancel: events '$ev'";; esac
case "$ev" in *completed*) fail "cancel: a completion was recorded: '$ev'";; esac
[ "$(state "$sid")" = dead ] || fail "cancel: state changed after the late result"
detail=$(api "$API/jobs/$sid/events" | python3 -c \
  'import json,sys; print([e["detail"] for e in json.load(sys.stdin)["events"] if e["event"] in ("cancelled","rejected")])')
pass "cancel: job $sid cancelled while leased, stays dead; audit log = '$ev'; details $detail"

# --- (d) requeue the cancelled job; it runs again -------------------------------
q=$(api -X POST "$API/jobs/$sid/requeue" -H 'Content-Type: application/json' -d '{"extra_attempts": 2}' | field '["state"]')
[ "$q" = queued ] || fail "requeue: state after requeue is $q"
wait_state "$sid" done
ev=$(events "$sid"); attempts=$(api "$API/jobs/$sid" | field '["attempts"]')
case "$ev" in *"rejected requeued claimed completed") ;; *) fail "requeue: events '$ev'";; esac
pass "requeue: job $sid requeued and done on attempt $attempts; audit log = '$ev'"

echo "smoke test passed"
api "$API/stats"; echo
