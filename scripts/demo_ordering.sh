#!/bin/bash
# Queue three demo attack-ordering analyses against a real corpus.
#
#   ./scripts/demo_ordering.sh          # queue them and print the links
#   ./scripts/demo_ordering.sh --wait   # ...and wait, printing each result
#
# Needs the stack already running (`docker compose up`) and a wordlist library
# configured in .env. scripts/demo_corpus.py builds what's missing into a
# `demo/` subdirectory of that library the first time — nothing else is
# touched, and `rm -rf <library>/demo` undoes it.
#
# The three jobs are chosen to show three different answers, not three
# variations of one:
#
#   1. The full lineup   — a realistic six-attack plan. Contains an expensive
#                          brute force that is *completely* redundant: every
#                          7-lowercase-letter password in the goal list is also
#                          in rockyou.alpha, so after the dictionary has run it
#                          contributes literally nothing for its 8 billion
#                          candidates. 720 sequences.
#   2. Dictionary vs rules — the nesting every operator actually faces. A rule
#                          set that includes the identity rule is a strict
#                          superset of the bare wordlist, so one of these two
#                          attacks is guaranteed redundant after the other.
#                          The question is whether the cheap one still earns an
#                          early slot. 6 sequences.
#   3. Mask family       — four brute forces over mostly disjoint character
#                          classes, so almost nothing is redundant. The
#                          baseline case: with no overlap to reason about,
#                          ordering collapses to "cheapest yield first" and
#                          greedy should be optimal. 24 sequences.
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

post() {  # post <name> <attacks-json>
  local name="$1" attacks="$2" id
  id=$(curl -sf -X POST "$API/api/jobs" -H 'Content-Type: application/json' \
       -d "{\"name\": \"$name\", \"spec\": {\"kind\": \"ordering\",
            \"goal\": \"demo/goal_rockyou.txt\", \"attacks\": $attacks}}" \
       | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  echo "$id"
}

echo
echo "== queueing"

# 1. The full lineup. Ordered here worst-first on purpose — the analysis has to
#    find the good sequence itself, and the builder's order is not it.
JOB1=$(post "Demo 1 — the full lineup" '[
  {"label":"brute 7 lower","mode":"mask","mask":"?l?l?l?l?l?l?l"},
  {"label":"common 815","mode":"wordlist","wordlist":"common_passwords_win.txt"},
  {"label":"en+nl dictionary","mode":"wordlist","wordlist":"demo/en_nl_words.txt"},
  {"label":"tokens + best64","mode":"wordlist","wordlist":"demo/rockyou_tokens.txt","rules":["best64.rule"]},
  {"label":"digits 1-8","mode":"mask","mask":"?d?d?d?d?d?d?d?d","increment_min":1,"increment_max":8},
  {"label":"rockyou alpha","mode":"wordlist","wordlist":"rockyou.alpha"}
]')
echo "  1. the full lineup      $API/#ordering/$JOB1"

# 2. best64.rule starts with ":" (the identity rule), so "tokens + best64"
#    generates every candidate "tokens" does and ~76 more per word.
JOB2=$(post "Demo 2 — dictionary vs rules" '[
  {"label":"tokens","mode":"wordlist","wordlist":"demo/rockyou_tokens.txt"},
  {"label":"tokens + best64","mode":"wordlist","wordlist":"demo/rockyou_tokens.txt","rules":["best64.rule"]},
  {"label":"digits 1-8","mode":"mask","mask":"?d?d?d?d?d?d?d?d","increment_min":1,"increment_max":8}
]')
echo "  2. dictionary vs rules  $API/#ordering/$JOB2"

# 3. Different lengths and character classes, so the recovered sets barely
#    intersect and there is nothing for an ordering to exploit beyond cost.
JOB3=$(post "Demo 3 — mask family" '[
  {"label":"brute 6 lower","mode":"mask","mask":"?l?l?l?l?l?l"},
  {"label":"digits 1-8","mode":"mask","mask":"?d?d?d?d?d?d?d?d","increment_min":1,"increment_max":8},
  {"label":"brute 5 lower","mode":"mask","mask":"?l?l?l?l?l"},
  {"label":"lower4 + digits2","mode":"mask","mask":"?l?l?l?l?d?d"}
]')
echo "  3. mask family          $API/#ordering/$JOB3"

[ "$WAIT" = "--wait" ] || { echo; echo "they run one at a time; watch them at $API/#ordering"; exit 0; }

echo
for JOB in "$JOB1" "$JOB2" "$JOB3"; do
  for _ in $(seq 1 240); do
    STATUS=$(curl -sf "$API/api/jobs/$JOB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
    [ "$STATUS" = queued ] || [ "$STATUS" = running ] || break
    sleep 5
  done
  curl -sf "$API/api/jobs/$JOB" | python3 scripts/demo_report.py
done
