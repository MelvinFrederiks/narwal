#!/bin/bash
# Submits a real rule-based job against the configured library and waits for it.
#
# Guessing English words with a Dutch wordlist, plain versus run through
# best64. Doubles as the demonstration case for why mergeability and Jaccard
# are not the same measurement: best64 contains the do-nothing rule `:`, so the
# ruled attack is a strict superset of the plain one. Jaccard says the two are
# only ~60% similar; mergeability correctly says adding the plain list on top
# buys you exactly nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== submitting"
RESP=$(curl -s -w '\n%{http_code}' -X POST http://localhost:7070/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{
        "name": "nl vs nl+best64",
        "spec": {
          "goal": "en_full.txt",
          "max_runtime_s": 300,
          "attacks": [
            {"label": "nl",         "mode": "wordlist", "wordlist": "nl_full.txt"},
            {"label": "nl+best64",  "mode": "wordlist", "wordlist": "nl_full.txt",
             "rules": ["best64.rule"]}
          ]
        }
      }')
CODE=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | head -n -1)
echo "  HTTP $CODE — $BODY"
[ "$CODE" = "201" ] || { echo "FAIL: job rejected"; exit 1; }
JOB=$(printf '%s' "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

echo "== waiting (rules make this a few million candidates on CPU)"
for _ in $(seq 1 200); do
  S=$(curl -sf "http://localhost:7070/api/jobs/$JOB" | python3 -c '
import json, sys
d = json.load(sys.stdin)
p = d.get("progress") or {}
st = p.get("status") or {}
extra = ""
if st.get("total"):
    extra = "  %.1f%% of attack %s" % (st["fraction"] * 100, (p.get("attack_index") or 0) + 1)
print(d["status"] + extra)')
  echo "  $S"
  case "$S" in queued*|running*) sleep 5 ;; *) break ;; esac
done

echo
echo "== result"
curl -sf "http://localhost:7070/api/jobs/$JOB" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d["status"] != "done":
    print("status:", d["status"]); print(d.get("error") or ""); raise SystemExit(1)
r = d["result"]
print("goal            : %s  (%s distinct, %s rejected)" % (r["goal"], f"{r[\"goal_size\"]:,}", r["goal_rejected"]))
print("hashcat         : %s in %.1fs   partial=%s" % (r["hashcat_version"], r["duration_s"], r["partial"]))
for a in r["attacks"]:
    print("  %-12s %9s recovered  %5.1f%% coverage  (%s%s)" % (
        a["label"], f"{a[\"recovered\"]:,}", a["coverage"] * 100,
        a["wordlist"] or a["mask"], " +" + ",".join(a["rules"]) if a["rules"] else ""))
for p in r["pairs"]:
    print("  %s vs %s: shared %s | jaccard %.1f%% | MERGEABILITY %.1f%%" % (
        p["a"], p["b"], f"{p[\"shared\"]:,}", p["jaccard"] * 100, p["mergeability"] * 100))
    print("    only %s adds: %s" % (p["b"], ", ".join(p["sample_only_b"][:8])))
print("combined        : %s (%.1f%%)" % (f"{r[\"combined_recovered\"]:,}", r["combined_coverage"] * 100))
'
echo
echo "view at: http://localhost:7070/#mergeability/$JOB"
