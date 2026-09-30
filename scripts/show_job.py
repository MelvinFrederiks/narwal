"""Pretty-print one mergeability job, reading the API's JSON on stdin.

    curl -sf localhost:7070/api/jobs/<id> | python3 scripts/show_job.py

Used by scripts/show_job.sh. Kept as a real file rather than a `python3 -c`
one-liner because quoting it through bash was more trouble than it was worth.
"""

from __future__ import annotations

import json
import sys


def n(v: int) -> str:
    return format(v, ",")


def main() -> int:
    d = json.load(sys.stdin)

    print("job {}  [{}]  {}".format(d["id"], d["status"], d.get("name") or ""))
    if d["status"] != "done":
        if d.get("error"):
            print(d["error"])
        return 1 if d["status"] == "failed" else 0

    r = d["result"]
    print("goal      : {}  ({} distinct entries, {} rejected)".format(
        r["goal"], n(r["goal_size"]), r["goal_rejected"]))
    print("hashcat   : {}   ran {:.1f}s   partial={}".format(
        r["hashcat_version"], r["duration_s"], r["partial"]))
    if r.get("partial_note"):
        print("  ! " + r["partial_note"])

    print("\nattacks")
    for a in r["attacks"]:
        src = a["wordlist"] or a["mask"] or "?"
        if a["rules"]:
            src += " + " + ",".join(a["rules"])
        print("  {:<12} {:>10} recovered   {:5.1f}% of goal   [{}]".format(
            a["label"], n(a["recovered"]), a["coverage"] * 100, src))

    print("\npairs (most complementary first)")
    for p in r["pairs"]:
        print("  {} vs {}".format(p["a"], p["b"]))
        print("    only {:<12} {:>10}".format(p["a"], n(p["only_a"])))
        print("    shared            {:>10}".format(n(p["shared"])))
        print("    only {:<12} {:>10}".format(p["b"], n(p["only_b"])))
        print("    jaccard {:.1f}%   MERGEABILITY {:.1f}%   together {:.1f}% of goal".format(
            p["jaccard"] * 100, p["mergeability"] * 100, p["union_coverage"] * 100))
        if p["sample_only_b"]:
            print("    e.g. only {} finds: {}".format(p["b"], ", ".join(p["sample_only_b"][:8])))

    print("\ncombined  : {} ({:.1f}% of goal)".format(
        n(r["combined_recovered"]), r["combined_coverage"] * 100))
    return 0


if __name__ == "__main__":
    sys.exit(main())
