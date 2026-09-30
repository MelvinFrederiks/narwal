#!/bin/bash
# Print a mergeability job's result in the terminal.
#   ./scripts/show_job.sh <job-id>        # or omit the id for the newest job
set -euo pipefail
cd "$(dirname "$0")/.."

JOB="${1:-}"
if [ -z "$JOB" ]; then
  JOB=$(curl -sf 'http://localhost:7070/api/jobs?limit=1' \
        | python3 -c 'import json,sys; js=json.load(sys.stdin)["jobs"]; print(js[0]["id"] if js else "")')
  [ -n "$JOB" ] || { echo "no jobs yet"; exit 1; }
fi

curl -sf "http://localhost:7070/api/jobs/$JOB" | python3 scripts/show_job.py
