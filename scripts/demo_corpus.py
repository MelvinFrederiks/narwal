#!/usr/bin/env python3
"""Build a demo corpus for the Attack order and Mergeability scenes.

Writes everything into a `demo/` subdirectory of the configured wordlist
library and touches nothing that is already there. Delete that one directory to
undo it.

The only library file this needs is `rockyou.txt` — earlier versions also
required `rockyou.parsed.txt`, `en_full.txt` and `nl_full.txt`, which not
every configured library carries. The attack side comes from elsewhere on the
box instead:

  · `goal_rockyou.txt` is the point of the whole thing: there is no realistic
    goal list in the library (`goal.txt` is 15 hand-typed lines). A random
    sample of real rockyou passwords gives one. rockyou.txt itself is
    deliberately never used as an attack, since it would recover the goal by
    construction.
  · `demo/cracklib_small.txt` is cracklib's own small dictionary
    (`/usr/share/dict/cracklib-small`, shipped by the `cracklib-runtime` /
    `dictionaries-common` packages on Debian and Ubuntu) — a real, independent
    word list rather than another slice of rockyou, so an attack built from it
    is testing something other than "does rockyou contain rockyou". Copied
    rather than read in place because an attack wordlist has to live under
    `NARWAL_WORDLISTS_DIR`.
  · Masks and rules need no file at all: a mask is a literal string in the
    attack spec (see scripts/demo_ordering.sh for a small handful — single
    character classes a few positions deep, cheap enough to run in a demo),
    and a ruleset is just a name from whatever hashcat NARWAL_HASHCAT_BIN
    points at (e.g. `best64.rule`/`best66.rule`, picked up from
    NARWAL_RULES_DIR — see config.rules_root).

Lines hashcat would silently drop from a goal file (blank, or over its
256-byte limit for -m 99999) are filtered out here instead, so the goal size
the UI reports is exactly the number of lines in the file.

Deterministic: same seed, same sample, so two runs produce the same numbers.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config  # noqa: E402

SEED = 20261002
GOAL_SIZE = 50_000
MAX_GOAL_LINE = 256  # hashcat -m 99999 Password.Len.Max

# cracklib's small dictionary — not part of the wordlist library, just a file
# the box already has. Install `cracklib-runtime` (Debian/Ubuntu) if missing.
CRACKLIB_SMALL = Path("/usr/share/dict/cracklib-small")


def read_lines(path: Path) -> list[bytes]:
    with path.open("rb") as fh:
        return [line.rstrip(b"\r\n") for line in fh]


def write_lines(path: Path, lines) -> None:
    with path.open("wb") as fh:
        for line in lines:
            fh.write(line + b"\n")


def main() -> int:
    root = config.wordlists_root
    if root is None:
        print("NARWAL_WORDLISTS_DIR is not set or does not exist — see .env.example")
        return 1

    demo = root / "demo"
    demo.mkdir(exist_ok=True)
    print(f"building demo corpus in {demo}")

    if not (root / "rockyou.txt").is_file():
        print("  missing rockyou.txt — this demo is built around the stock library")
        return 1
    if not CRACKLIB_SMALL.is_file():
        print(f"  missing {CRACKLIB_SMALL} — install cracklib-runtime (Debian/Ubuntu)")
        return 1

    # ── goal: a random sample of real passwords ─────────────────────────────
    goal_path = demo / "goal_rockyou.txt"
    if goal_path.exists():
        print(f"  goal_rockyou.txt already there ({sum(1 for _ in goal_path.open('rb')):,} lines)")
    else:
        print("  reading rockyou.txt …")
        rock = sorted({
            line for line in read_lines(root / "rockyou.txt")
            if line and len(line) <= MAX_GOAL_LINE
        })
        print(f"    {len(rock):,} distinct usable passwords")
        random.seed(SEED)
        write_lines(goal_path, sorted(random.sample(rock, GOAL_SIZE)))
        print(f"  goal_rockyou.txt — {GOAL_SIZE:,} sampled passwords")

    # ── attack dictionary: cracklib's own word list ─────────────────────────
    cracklib_path = demo / "cracklib_small.txt"
    if cracklib_path.exists():
        print("  cracklib_small.txt already there")
    else:
        words = sorted({line for line in read_lines(CRACKLIB_SMALL) if line})
        write_lines(cracklib_path, words)
        print(f"  cracklib_small.txt — {len(words):,} words from {CRACKLIB_SMALL}")

    print("done. `rm -rf " + str(demo) + "` to undo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
