"""Precompute attack_sim.simulate() for every (attack, reference) pair.

Walks attacks.toml × datasets.toml (cleaned only) and calls
`attack_sim.simulate`. Hits are pickled to data/cache/sim/<attack>__<ref>.pkl.
Reuses anything already cached.

Run from repo root:
    PYTHONPATH=. /mnt/llm-shared/.venv/bin/python tools/warm_sim.py
"""

from __future__ import annotations

import logging
import sys
import time
import tomllib
from pathlib import Path

from backend.models import AttackDef
from backend.pipeline import attack_sim

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("warm_sim")

REPO = Path(__file__).resolve().parents[1]
ATTACKS_TOML = REPO / "backend" / "config" / "attacks.toml"
DATASETS_TOML = REPO / "backend" / "config" / "datasets.toml"
CLEAN_DIR = REPO / "data" / "clean"

SIMULATABLE = {"wordlist", "wordlist+rules", "mask"}

# References that don't fit a Python set with this host's RAM+swap budget.
# LinkedIn at 60M unique strings needs ~5 GB just for the str hashtable.
# We'll handle these later with a disk-based streaming intersect.
_OVERSIZE_REFS = {"linkedin"}


def load_attacks() -> list[AttackDef]:
    with ATTACKS_TOML.open("rb") as fh:
        data = tomllib.load(fh)
    return [AttackDef(**a) for a in data["attack"] if a["type"] in SIMULATABLE]


def load_cleaned_references() -> list[str]:
    with DATASETS_TOML.open("rb") as fh:
        data = tomllib.load(fh)
    return [
        k for k in data
        if (CLEAN_DIR / f"{k}.txt.gz").exists() and k not in _OVERSIZE_REFS
    ]


def main() -> None:
    attacks = load_attacks()
    refs = load_cleaned_references()
    total = len(attacks) * len(refs)
    log.info("warming %d attacks × %d references = %d pairs", len(attacks), len(refs), total)

    t_total = time.time()
    i = 0
    # Outer loop = reference. After each ref we drop its plaintext set so
    # we never hold more than one ref + the wordlist caches in memory.
    for ref in refs:
        for atk in attacks:
            i += 1
            cached = attack_sim.get_cached_hits(atk.id, ref) is not None
            tag = "cached" if cached else "computing"
            log.info("[%d/%d] %s %s × %s", i, total, tag, atk.id, ref)
            t0 = time.time()
            try:
                hits, _ = attack_sim.simulate(atk, ref)
            except Exception as exc:  # noqa: BLE001
                log.error("[%d/%d] %s × %s FAILED: %s", i, total, atk.id, ref, exc)
                continue
            log.info("[%d/%d] %s × %s: %d hits in %.1fs",
                     i, total, atk.id, ref, len(hits), time.time() - t0)
        attack_sim._REF_SET_CACHE.pop(ref, None)
        import gc; gc.collect()
        log.info("freed reference plaintext set: %s", ref)

    log.info("done — %d pairs in %.1f min", total, (time.time() - t_total) / 60)


if __name__ == "__main__":
    main()
