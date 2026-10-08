#!/usr/bin/env python3
"""Build a demo corpus for the Attack order and Mergeability scenes.

Writes everything into a `demo/` subdirectory of the configured wordlist
library and touches nothing that is already there. Delete that one directory to
undo it.

The only library file this needs is `rockyou.txt` — earlier versions also
required `rockyou.parsed.txt`, `en_full.txt` and `nl_full.txt`, which not
every configured library carries. Everything attack-side is either derived
from that one file or needs no file at all:

  · `goal_rockyou.txt` is the point of the whole thing: there is no realistic
    goal list in the library (`goal.txt` is 15 hand-typed lines). A random
    sample of real rockyou passwords gives one. rockyou.txt itself is
    deliberately never used as an attack, since it would recover the goal by
    construction.
  · `demo/common_rockyou.txt` is the COMMON_SIZE most frequent lines in
    rockyou.txt — rockyou.txt is the raw leak, duplicates and all, so a
    frequency count over it *is* a "most common passwords" list, the same way
    a real one would be built.
  · `demo/rockyou_alpha.txt` is every distinct all-lowercase-letters line in
    rockyou.txt. Built from the same source as the goal sample, so by
    construction it is a superset of every lowercase-alpha password the goal
    list contains — see scripts/demo_ordering.sh's "full lineup" job, which
    relies on that to make one of its attacks completely redundant.
  · `demo/cracklib_small.txt` is cracklib's own small dictionary
    (`/usr/share/dict/cracklib-small`, shipped by the `cracklib-runtime` /
    `dictionaries-common` packages on Debian and Ubuntu) — the one piece that
    is *not* derived from rockyou, so an attack built from it is testing
    something other than "does rockyou contain rockyou". Copied rather than
    read in place because an attack wordlist has to live under
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

rockyou.txt is read once and shared across the three rockyou-derived outputs
above, rather than once per output — it's a 100MB+ file, so that's the
difference between one pass and three.

Deterministic: same seed, same sample, so two runs produce the same numbers.
"""

from __future__ import annotations

import random
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config  # noqa: E402

SEED = 20261002
GOAL_SIZE = 50_000
COMMON_SIZE = 815
MAX_GOAL_LINE = 256  # hashcat -m 99999 Password.Len.Max
ALPHA = re.compile(rb"^[a-z]+$")

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

    # ── everything derived from rockyou.txt, in one pass ────────────────────
    goal_path = demo / "goal_rockyou.txt"
    common_path = demo / "common_rockyou.txt"
    alpha_path = demo / "rockyou_alpha.txt"

    if goal_path.exists():
        print(f"  goal_rockyou.txt already there ({sum(1 for _ in goal_path.open('rb')):,} lines)")
    if common_path.exists():
        print("  common_rockyou.txt already there")
    if alpha_path.exists():
        print("  rockyou_alpha.txt already there")

    if not (goal_path.exists() and common_path.exists() and alpha_path.exists()):
        print("  reading rockyou.txt …")
        raw = read_lines(root / "rockyou.txt")

        if not goal_path.exists():
            rock = sorted({line for line in raw if line and len(line) <= MAX_GOAL_LINE})
            print(f"    {len(rock):,} distinct usable passwords")
            random.seed(SEED)
            write_lines(goal_path, sorted(random.sample(rock, GOAL_SIZE)))
            print(f"  goal_rockyou.txt — {GOAL_SIZE:,} sampled passwords")

        if not common_path.exists():
            counts = Counter(line for line in raw if line)
            common = [line for line, _ in counts.most_common(COMMON_SIZE)]
            write_lines(common_path, common)
            print(f"  common_rockyou.txt — {len(common):,} most frequent passwords")

        if not alpha_path.exists():
            alpha = sorted({line for line in raw if ALPHA.match(line)})
            write_lines(alpha_path, alpha)
            print(f"  rockyou_alpha.txt — {len(alpha):,} distinct all-lowercase passwords")

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
