#!/bin/bash
# Sanity check that .env points at a library the running stack can actually see.
# Prints what the Mergeability scene will offer you.
set -euo pipefail
cd "$(dirname "$0")/.."

for _ in $(seq 1 60); do
  curl -sf http://localhost:7070/healthz >/dev/null && break
  sleep 1
done
curl -sf http://localhost:7070/healthz >/dev/null || { echo "API not reachable on :7070"; exit 1; }

echo "=== /api/jobs/config ==="
curl -sf http://localhost:7070/api/jobs/config | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("  enabled       :", d["enabled"])
print("  attack modes  :", ", ".join(d["modes"]))
print("  max attacks   :", d["max_attacks"])
print("  rule files    :", len(d["rules"]), "->", ", ".join(d["rules"][:6]) or "(none)")
'

echo
echo "=== /api/wordlists (what the dropdown will list) ==="
curl -sf http://localhost:7070/api/wordlists | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d["enabled"]:
    print("  NOT CONFIGURED — NARWAL_WORDLISTS_DIR is unset or missing on disk")
    raise SystemExit(1)
for f in d["files"]:
    print("  %8.1f MB  %s" % (f["size"] / 1e6, f["path"]))
print("  %d file(s)" % len(d["files"]))
'

echo
echo "=== worker ==="
docker compose logs narwal-worker 2>/dev/null | tail -4
