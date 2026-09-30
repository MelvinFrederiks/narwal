#!/bin/bash
# Restart safety: a job whose worker dies mid-run must come back, not strand.
#
# STATUS: unproven. This script has not been run to completion in its current
# form. An earlier version did catch a real bug — a killed worker left a stale
# hashcat session pidfile, so the requeued job died with "Already an instance
# running" (fixed by making --session unique per attempt, worker/main.py) — but
# the claimed_at-based detection below has not itself been exercised. The
# underlying requeue logic is covered by tests/test_db.py.
#
# Queues a deliberately long attack, kills the worker while it is running, and
# checks the job returns to `queued` and is picked up again. Uses a short
# NARWAL_WORKER_STALE so the sweep happens in seconds rather than 2 minutes.
set -euo pipefail

cd "$(dirname "$0")/.."
LIB=$(mktemp -d)
RUNS=$(mktemp -d)
trap 'echo; echo "test library was $LIB, queue was $RUNS"' EXIT

printf 'password\nzzzzzz\nabcdef\n' > "$LIB/goal.txt"
printf 'password\n'                 > "$LIB/wl_a.txt"
chmod -R a+rX "$LIB"
chmod -R a+rwX "$RUNS"

export NARWAL_WORKER_STALE=10
export NARWAL_WORKER_POLL=1
export NARWAL_WORDLISTS_DIR="$LIB"
# A fresh queue, so jobs left over from an earlier run against a different
# library can't show up here as confusing failures.
export NARWAL_RUNS_HOST_DIR="$RUNS"
docker compose up -d --build

for _ in $(seq 1 60); do curl -sf http://localhost:7070/healthz >/dev/null && break; sleep 1; done

# "<status> <claimed_at>". Tolerates a momentarily unreachable API so a blip
# in the poll loop doesn't read as a test failure.
#
# claimed_at is what actually proves a re-claim happened. Watching for the
# literal `queued` state is a race: the sweep requeues the job and the very
# next poll of the worker loop claims it again, so the queued window can be
# shorter than any sane sampling interval.
status() {
  local body
  body=$(curl -sf "http://localhost:7070/api/jobs/$1" 2>/dev/null) || { echo "unavailable -"; return; }
  printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unavailable -"); sys.exit()
print(d["status"], d.get("claimed_at") or "-")'
}

echo "== queueing a long job"
JOB=$(curl -sf -X POST http://localhost:7070/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"name":"restart-test","spec":{"goal":"goal.txt","attacks":[
        {"label":"slow","mode":"mask","mask":"?a?a?a?a?a?a?a?a"},
        {"label":"dict","mode":"wordlist","wordlist":"wl_a.txt"}]}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "job $JOB"

echo "== waiting for it to start running"
for _ in $(seq 1 60); do
  s=$(status "$JOB"); echo "  $s"
  [[ "$s" == running* ]] && break
  sleep 1
done
[[ "$(status "$JOB")" == running* ]] || { echo "FAIL: job never started"; exit 1; }
FIRST_CLAIM=$(status "$JOB" | cut -d' ' -f2)
echo "  first claimed_at: $FIRST_CLAIM"

echo "== killing the worker mid-attack"
docker compose kill narwal-worker
echo "  status right after the kill: $(status "$JOB")"

echo "== restarting the worker; the stale sweep should requeue the job"
# --no-deps so compose doesn't also recreate the API container it depends on,
# which would take the status endpoint down mid-poll.
docker compose up -d --no-deps narwal-worker
RECLAIMED=0
for _ in $(seq 1 40); do
  s=$(status "$JOB"); echo "  $s"
  claim=$(printf '%s' "$s" | cut -d' ' -f2)
  if [[ "$s" == running* && "$claim" != "$FIRST_CLAIM" && "$claim" != "-" ]]; then
    RECLAIMED=1; break
  fi
  sleep 2
done

if [[ "$RECLAIMED" == 1 ]]; then
  echo "PASS: the abandoned job was requeued and claimed again by a fresh worker"
else
  echo "FAIL: job was never requeued (claimed_at never changed from $FIRST_CLAIM)"; exit 1
fi

curl -sf -X DELETE "http://localhost:7070/api/jobs/$JOB" >/dev/null
echo "cancelled the test job"
