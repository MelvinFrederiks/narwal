#!/usr/bin/env python3
"""Build a demo corpus for the Attack order and Mergeability scenes.

Writes everything into a `demo/` subdirectory of the configured wordlist
library and touches nothing that is already there. Delete that one directory to
undo it.

Why these files:

  · The library's `en_full.txt` / `nl_full.txt` / `en_nl_combined.txt` are
    *frequency lists* — "word<space>count" per line — so hashcat would try
    "you 22484400" as a candidate and recover nothing. `en_nl_words.txt` is the
    word column alone, which is what a dictionary attack actually needs.
  · `rockyou.parsed.txt` is a token-level parse with heavy duplication (19.9M
    lines, 330k distinct). Deduplicating it costs nothing and makes the attack's
    measured runtime mean what it looks like it means.
  · `goal_rockyou.txt` is the point of the whole thing: there is no realistic
    goal list in the library (`goal.txt` is 15 hand-typed lines). A random
    sample of real rockyou passwords gives one. The attacks below are *other*
    corpora, so coverage comes out partial and interesting on its own — no
    artificial hold-out needed. rockyou.txt itself is deliberately never used as
    an attack, since it would recover the goal by construction.

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
WORDS_PER_LANGUAGE = 150_000
MAX_GOAL_LINE = 256  # hashcat -m 99999 Password.Len.Max


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

    for required in ("rockyou.txt", "rockyou.parsed.txt", "en_full.txt", "nl_full.txt"):
        if not (root / required).is_file():
            print(f"  missing {required} — this demo is built around the stock library")
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

    # ── a real dictionary, out of the frequency lists ───────────────────────
    words_path = demo / "en_nl_words.txt"
    if words_path.exists():
        print("  en_nl_words.txt already there")
    else:
        words: set[bytes] = set()
        for name in ("en_full.txt", "nl_full.txt"):
            taken = 0
            for line in read_lines(root / name):
                word = line.split(b" ", 1)[0].strip()
                if word:
                    words.add(word)
                    taken += 1
                if taken >= WORDS_PER_LANGUAGE:
                    break
        write_lines(words_path, sorted(words))
        print(f"  en_nl_words.txt — {len(words):,} English + Dutch words")

    # ── the token list, deduplicated ────────────────────────────────────────
    tokens_path = demo / "rockyou_tokens.txt"
    if tokens_path.exists():
        print("  rockyou_tokens.txt already there")
    else:
        tokens = sorted({line for line in read_lines(root / "rockyou.parsed.txt") if line})
        write_lines(tokens_path, tokens)
        print(f"  rockyou_tokens.txt — {len(tokens):,} distinct tokens")

    print("done. `rm -rf " + str(demo) + "` to undo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
