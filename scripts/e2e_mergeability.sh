#!/bin/bash
# End-to-end check of the mergeability queue through docker compose.
#
# Brings the stack up against a small throwaway wordlist library, posts a job
# over the real HTTP API, waits for the worker to finish it, and prints the
# result. Numbers are small enough to verify by eye — see the expectations
# printed at the end.
#
#   ./scripts/e2e_mergeability.sh
#
# Leaves the stack running so you can poke at http://localhost:7070/#mergeability.
set -euo pipefail

cd "$(dirname "$0")/.."
# The worker image ships no hashcat — it is bind-mounted from NARWAL_HASHCAT_DIR
# (see .env.example). Without it the worker exits at startup and this script
# would just sit watching a job that never gets claimed.
HCDIR=$(sed -n 's/^NARWAL_HASHCAT_DIR=//p' .env 2>/dev/null | tr -d "\"'")
[ -n "$HCDIR" ] && [ -x "$HCDIR/hashcat" ] || {
  echo "set NARWAL_HASHCAT_DIR in .env to a hashcat install first (see .env.example)"; exit 1; }

LIB=$(mktemp -d)
RUNS=$(mktemp -d)
chmod a+rwX "$RUNS"
# A throwaway queue directory, so this run isn't mixed in with real jobs (whose
# wordlist paths point at a different library and would fail re-validation).
export NARWAL_RUNS_HOST_DIR="$RUNS"
trap 'echo; echo "test library was $LIB, queue was $RUNS"' EXIT

# Six goal entries. "dict" finds 3, "sixlower" finds 2, sharing "abcdef".
printf 'password\nhunter2\nqwerty123\nCafe123\nzzzzzz\nabcdef\n' > "$LIB/goal.txt"
printf 'password\nhunter2\nabcdef\nnotinthegoallist\n'           > "$LIB/wl_a.txt"
chmod -R a+rX "$LIB"

echo "== bringing up the stack (library: $LIB)"
NARWAL_WORDLISTS_DIR="$LIB" docker compose up -d --build

echo "== waiting for the API"
for _ in $(seq 1 60); do
  curl -sf http://localhost:7070/healthz >/dev/null && break
  sleep 1
done
curl -sf http://localhost:7070/healthz >/dev/null || { echo "API never came up"; exit 1; }

echo "== the worker should see hashcat"
docker compose logs narwal-worker | tail -5

echo
echo "== posting a job"
JOB=$(curl -sf -X POST http://localhost:7070/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "e2e",
        "spec": {
          "goal": "goal.txt",
          "attacks": [
            {"label": "dict",     "mode": "wordlist", "wordlist": "wl_a.txt"},
            {"label": "sixlower", "mode": "mask",     "mask": "?l?l?l?l?l?l"}
          ]
        }
      }' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "job $JOB"

echo "== waiting for it to finish"
for _ in $(seq 1 120); do
  STATUS=$(curl -sf "http://localhost:7070/api/jobs/$JOB" \
           | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  echo "  $STATUS"
  [ "$STATUS" = "queued" ] || [ "$STATUS" = "running" ] || break
  sleep 2
done

echo
echo "== result"
curl -sf "http://localhost:7070/api/jobs/$JOB" | python3 -m json.tool

cat <<'EOF'

== expected
  status            done
  goal_size         6
  dict recovered    3      (password, hunter2, abcdef)
  sixlower          2      (zzzzzz, abcdef)
  shared            1      (abcdef)
  union             4
  jaccard           25.0%  (1/4)
  mergeability      33.3%  ((4-3)/3)
  combined_coverage 66.7%  (4/6)
EOF
