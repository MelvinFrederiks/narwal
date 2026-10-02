#!/bin/bash
# End-to-end check of an attack-ordering job through docker compose.
#
# Same shape as scripts/e2e_mergeability.sh — it brings the stack up against a
# throwaway wordlist library, posts a real job over HTTP, waits for the worker,
# and prints the result against hand-computed expectations.
#
# The library is rigged so the right answer is obvious and depends on *timing*,
# not just on the sets: `cheap` recovers 3 of the goal list from a four-line
# wordlist in well under a second, while `brute` recovers 2 (one of which
# `cheap` already found) by grinding a six-lowercase-letter keyspace. Any
# sequence that runs `brute` first spends its whole runtime before reporting
# anything, so `cheap` has to come first.
#
#   ./scripts/e2e_ordering.sh
#
# Leaves the stack running so you can poke at http://localhost:7070/#ordering.
set -euo pipefail

cd "$(dirname "$0")/.."
LIB=$(mktemp -d)
RUNS=$(mktemp -d)
chmod a+rwX "$RUNS"
export NARWAL_RUNS_HOST_DIR="$RUNS"
trap 'echo; echo "test library was $LIB, queue was $RUNS"' EXIT

# Six goal entries. cheap -> password, hunter2, abcdef. brute -> zzzzzz, abcdef.
# subset -> abcdef only, which both of the others already cover.
printf 'password\nhunter2\nqwerty123\nCafe123\nzzzzzz\nabcdef\n' > "$LIB/goal.txt"
printf 'password\nhunter2\nabcdef\nnotinthegoallist\n'           > "$LIB/wl_cheap.txt"
printf 'abcdef\n'                                                > "$LIB/wl_subset.txt"
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
echo "== posting an ordering job"
JOB=$(curl -sf -X POST http://localhost:7070/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "e2e ordering",
        "spec": {
          "kind": "ordering",
          "goal": "goal.txt",
          "attacks": [
            {"label": "brute",  "mode": "mask",     "mask": "?l?l?l?l?l?l"},
            {"label": "cheap",  "mode": "wordlist", "wordlist": "wl_cheap.txt"},
            {"label": "subset", "mode": "wordlist", "wordlist": "wl_subset.txt"}
          ]
        }
      }' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "job $JOB"

echo "== waiting for it to finish"
for _ in $(seq 1 180); do
  STATUS=$(curl -sf "http://localhost:7070/api/jobs/$JOB" \
           | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  echo "  $STATUS"
  [ "$STATUS" = "queued" ] || [ "$STATUS" = "running" ] || break
  sleep 2
done

echo
echo "== result (summary; full JSON is at /api/jobs/$JOB)"
curl -sf "http://localhost:7070/api/jobs/$JOB" | python3 - <<'PYEOF'
import json, sys
job = json.load(sys.stdin)
print("status:", job["status"])
if job.get("error"):
    print("error:", job["error"])
    sys.exit(1)
r = job["result"]
print(f"goal_size            {r['goal_size']}")
print(f"combined_recovered   {r['combined_recovered']} ({r['combined_coverage']*100:.1f}% of goal)")
print(f"permutations_scored  {r['permutations_scored']}")
print(f"total_runtime        {r['total_runtime_s']:.1f}s")
print()
for a in r["attacks"]:
    print(f"  {a['label']:<8} recovered {a['recovered']}  in {a['duration_s']:.1f}s"
          f"  exclusive {a['exclusive']}")
print()
print("best   ", " -> ".join(r["best"]["order"]), f"  score {r['best']['efficiency']*100:.1f}%")
print("greedy ", " -> ".join(r["greedy"]["order"]),
      "  optimal" if r["greedy"]["is_optimal"] else f"  beaten by {r['greedy']['beaten_by']}")
print("worst  ", " -> ".join(r["worst"]["order"]), f"  score {r['worst']['efficiency']*100:.1f}%")
print()
print("milestones (best vs worst):")
wm = {m["fraction"]: m for m in r["worst"]["milestones"]}
for m in r["best"]["milestones"]:
    w = wm[m["fraction"]]["time_s"]
    print(f"  {m['fraction']*100:5.0f}% of haul ({m['target']:>2} pw)  best {m['time_s']:7.1f}s"
          f"   worst {w:7.1f}s   after {m['after']}")
print()
print("who finds what:")
for s in r["signatures"]:
    print(f"  {'+'.join(s['labels']):<22} {s['count']}")
PYEOF

cat <<'EOF'

== expected
  status               done
  goal_size            6
  cheap recovered      3      (password, hunter2, abcdef)
  brute recovered      2      (zzzzzz, abcdef)
  subset recovered     1      (abcdef) — exclusive 0, it adds nothing to anything
  combined_recovered   4      (password, hunter2, abcdef, zzzzzz) = 66.7% of goal
  permutations_scored  6      (3!)
  best order           cheap first; subset last
  worst order          starts with the slow brute force
  best score > worst score, and greedy never beats best
EOF
