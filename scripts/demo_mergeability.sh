#!/bin/bash
# Queue a demo mergeability analysis against a real corpus.
#
#   ./scripts/demo_mergeability.sh          # queue it and print the link
#   ./scripts/demo_mergeability.sh --wait   # ...and wait, printing the result
#
# Needs the stack already running (`docker compose up`) and a wordlist library
# configured in .env. scripts/demo_corpus.py builds what's missing into a
# `demo/` subdirectory of that library the first time — nothing else is
# touched, and `rm -rf <library>/demo` undoes it.
#
# Same four attacks as scripts/demo_ordering.sh's "dictionary vs rules" /
# "mask family" jobs, run here as one mergeability job instead of an ordering
# one, so the two scripts show the same attacks answering two different
# questions:
#
#   cracklib            — cracklib's small dictionary, bare.
#   cracklib + rules     — the same dictionary through best64/best66, which
#                          starts with ":" (the identity rule) — a strict
#                          superset of the bare wordlist, so this pair's
#                          mergeability should come out at (or very near) 0:
#                          the rule attack already finds everything the bare
#                          one does.
#   brute 6 lower        — ?l?l?l?l?l?l, disjoint from the dictionary attacks
#                          on both length and character class.
#   digits 1-8            — ?d{1,8}, disjoint from everything else here too.
#
# The brute-force / digits pair against the dictionary pairs is the contrast:
# nowhere near as redundant, so expect mergeability much closer to 1 there —
# two attacks that barely overlap add up to roughly the sum of what they find.
#
# rockyou.txt is deliberately never used as an attack wordlist: the goal list
# is sampled from it, so it would recover 100% by construction and say nothing.
set -euo pipefail

cd "$(dirname "$0")/.."
API=${NARWAL_API:-http://localhost:7070}
WAIT=${1:-}

curl -sf "$API/healthz" >/dev/null || { echo "no stack at $API — docker compose up"; exit 1; }

echo "== building the demo corpus (idempotent)"
PYTHONPATH=. python3 scripts/demo_corpus.py

# Rules come from whatever hashcat NARWAL_HASHCAT_BIN points at, so the name
# depends on the version: hashcat 7 renamed best64.rule to best66.rule. Ask the
# API which one this install actually has rather than guessing.
RULE=$(curl -sf "$API/api/jobs/config" | python3 -c '
import json, sys
rules = json.load(sys.stdin)["rules"]
print(next((r for r in ("best66.rule", "best64.rule") if r in rules), ""))')
[ -n "$RULE" ] || { echo "neither best66.rule nor best64.rule in this hashcat install"; exit 1; }
echo "   using rule file: $RULE"

echo
echo "== queueing"

JOB=$(curl -sf -X POST "$API/api/jobs" -H 'Content-Type: application/json' \
  -d "{\"name\": \"Demo — mergeability\", \"spec\": {
        \"goal\": \"demo/goal_rockyou.txt\", \"attacks\": [
          {\"label\":\"cracklib\",\"mode\":\"wordlist\",\"wordlist\":\"demo/cracklib_small.txt\"},
          {\"label\":\"cracklib + rules\",\"mode\":\"wordlist\",\"wordlist\":\"demo/cracklib_small.txt\",\"rules\":[\"$RULE\"]},
          {\"label\":\"brute 6 lower\",\"mode\":\"mask\",\"mask\":\"?l?l?l?l?l?l\"},
          {\"label\":\"digits 1-8\",\"mode\":\"mask\",\"mask\":\"?d?d?d?d?d?d?d?d\",\"increment_min\":1,\"increment_max\":8}
        ]}}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "  $API/#mergeability/$JOB"

[ "$WAIT" = "--wait" ] || { echo; echo "watch it at $API/#mergeability"; exit 0; }

echo
for _ in $(seq 1 240); do
  STATUS=$(curl -sf "$API/api/jobs/$JOB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  [ "$STATUS" = queued ] || [ "$STATUS" = running ] || break
  sleep 5
done
curl -sf "$API/api/jobs/$JOB" | python3 scripts/show_job.py
