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


def guesses(n: float | None) -> str:
    """Compact guess count: 456976 -> '457K', matching the web formatter."""
    if n is None:
        return "?"
    n = float(n)
    if n < 1000:
        return f"{round(n):,}"
    for base, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if n >= base:
            v = n / base
            return f"{round(v)}{suf}" if v >= 100 else f"{v:.1f}{suf}"
    return f"{round(n):,}"


def half(order: dict) -> float:
    """Cost at the 50% milestone, on whatever axis the job was scored (the
    milestone carries `cost`; `time_s` is the fallback for an old result)."""
    m = next(m for m in order["milestones"] if m["fraction"] == 0.5)
    return m.get("cost") if m.get("cost") is not None else m.get("time_s")


def main() -> int:
    job = json.load(sys.stdin)
    result = job.get("result")
    print(f"== {job.get('name') or job['id']} — {job['status']}")
    if not result:
        print("  " + (job.get("error") or "no result")[:400])
        return 0

    by_guesses = result.get("cost_axis") == "guesses"
    unit = " guesses" if by_guesses else "s"

    def cost(v: float | None) -> str:
        return guesses(v) if by_guesses else f"{(v or 0):.1f}"

    total = result.get("total_guesses") if by_guesses else result.get("total_runtime_s")
    print(f"  goal {result['goal_size']:,}   combined {result['combined_recovered']:,} "
          f"({result['combined_coverage']*100:.1f}%)   "
          f"{result['permutations_scored']:,} sequences from {len(result['attacks'])} "
          f"runs totalling {cost(total)}{unit}")
    for a in sorted(result["attacks"], key=lambda a: -a["recovered"]):
        spent = guesses(a.get("guesses")) if by_guesses else f"{a.get('duration_s') or 0:.1f}s"
        print(f"    {a['label']:<18} {a['recovered']:>6,} in {spent:>9}"
              f"   only-this {a['exclusive']:>6,}")

    best, worst, greedy = result["best"], result["worst"], result["greedy"]
    print(f"  best   {' -> '.join(best['order'])}")
    print(f"         score {best['efficiency']*100:.1f}%, half the haul by {cost(half(best))}{unit}")
    print(f"  worst  {' -> '.join(worst['order'])}")
    print(f"         score {worst['efficiency']*100:.1f}%, half the haul by {cost(half(worst))}{unit}")
    verdict = ("optimal" if greedy["is_optimal"]
               else f"beaten by {greedy['beaten_by']:,} sequences")
    print(f"  greedy {verdict}   ({' -> '.join(greedy['order'])})")
    print(f"  reordering is worth {cost(half(worst) - half(best))}{unit} to the halfway point")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
