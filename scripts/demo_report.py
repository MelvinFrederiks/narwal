#!/usr/bin/env python3
"""Print one ordering job's result as a few readable lines.

Reads the job JSON (as /api/jobs/<id> returns it) on stdin:

    curl -sf http://localhost:7070/api/jobs/<id> | scripts/demo_report.py

Kept as a file rather than a heredoc inside demo_ordering.sh because a
heredoc feeds the script on stdin, which is the same stdin the piped JSON
needs — they cannot both have it.
"""

from __future__ import annotations

import json
import sys


def half(order: dict) -> float:
    return next(m["time_s"] for m in order["milestones"] if m["fraction"] == 0.5)


def main() -> int:
    job = json.load(sys.stdin)
    result = job.get("result")
    print(f"== {job.get('name') or job['id']} — {job['status']}")
    if not result:
        print("  " + (job.get("error") or "no result")[:400])
        return 0

    print(f"  goal {result['goal_size']:,}   combined {result['combined_recovered']:,} "
          f"({result['combined_coverage']*100:.1f}%)   "
          f"{result['permutations_scored']:,} sequences from {len(result['attacks'])} "
          f"runs totalling {result['total_runtime_s']:.0f}s")
    for a in sorted(result["attacks"], key=lambda a: -a["recovered"]):
        print(f"    {a['label']:<18} {a['recovered']:>6,} in {a['duration_s']:>6.1f}s"
              f"   only-this {a['exclusive']:>6,}")

    best, worst, greedy = result["best"], result["worst"], result["greedy"]
    print(f"  best   {' -> '.join(best['order'])}")
    print(f"         score {best['efficiency']*100:.1f}%, half the haul by {half(best):.1f}s")
    print(f"  worst  {' -> '.join(worst['order'])}")
    print(f"         score {worst['efficiency']*100:.1f}%, half the haul by {half(worst):.1f}s")
    verdict = ("optimal" if greedy["is_optimal"]
               else f"beaten by {greedy['beaten_by']:,} sequences")
    print(f"  greedy {verdict}   ({' -> '.join(greedy['order'])})")
    print(f"  reordering is worth {half(worst) - half(best):.1f}s to the halfway point")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
