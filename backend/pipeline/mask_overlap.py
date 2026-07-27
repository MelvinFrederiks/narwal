"""Fast approximate overlap matrix via PACK-style mask histograms.

For each reference and each attack we compute a PACK mask histogram
(?l/?u/?d/?s tokens). Per-mask hits are approximated as
``min(attack_count, ref_count)`` and aggregated to a Jaccard estimate.

Attack mask distributions
-------------------------
For an attack's "shape" we use the **base wordlist's** mask histogram
(for wordlist / wordlist+rules) or the literal single mask (for mask).
A first attempt sampled ``hashcat --stdout`` and classified the first
N candidates, but that's a sampling artifact: best64 (77 rules) and
d3ad0ne (34k rules) traverse very different word prefixes when capped
at 1M candidates, producing wildly different mask distributions for
two attacks that share the same base wordlist. The wordlist itself is
what fundamentally determines what an attack can crack on a corpus, so
it's a much more honest proxy.
"""

from __future__ import annotations

import gzip
import json
import logging
import threading
import time
from pathlib import Path

from backend.models import AttackDef, JaccardCell, OverlapMatrix
from backend.pipeline.mask_histogram import classify, iter_passwords

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_CLEAN = _REPO / "data" / "clean"
_RAW = _REPO / "data" / "raw"
_DATASET_CACHE = _REPO / "data" / "cache" / "dataset_masks"
_WORDLIST_CACHE = _REPO / "data" / "cache" / "wordlist_masks"
_DATASET_CACHE.mkdir(parents=True, exist_ok=True)
_WORDLIST_CACHE.mkdir(parents=True, exist_ok=True)

_SIMULATABLE = {"wordlist", "wordlist+rules", "mask"}
_lock = threading.Lock()


def _read_json(path: Path) -> dict[str, int] | None:
    if not path.exists():
        return None
    with path.open() as fh:
        return json.load(fh)


def _write_json(path: Path, data: dict[str, int]) -> None:
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w") as fh:
        json.dump(data, fh)
    tmp.replace(path)


def _scan_passwords(path: Path, *, max_length: int) -> dict[str, int]:
    counts: dict[str, int] = {}
    iterator = (
        iter_passwords(path) if path.suffix == ".gz" else _iter_plain(path)
    )
    for pwd in iterator:
        if not pwd or len(pwd) > max_length:
            continue
        m = classify(pwd)
        if m is not None:
            counts[m] = counts.get(m, 0) + 1
    return counts


def _iter_plain(path: Path):
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line:
                yield line


# ── Dataset mask histogram ────────────────────────────────────────────────────


def dataset_mask_distribution(dataset_id: str, *, max_length: int = 12) -> dict[str, int]:
    clean = _CLEAN / f"{dataset_id}.txt.gz"
    if not clean.exists():
        raise FileNotFoundError(f"cleaned corpus missing: {clean}")
    cache = _DATASET_CACHE / f"{dataset_id}.json"
    if (c := _read_json(cache)) is not None and cache.stat().st_mtime >= clean.stat().st_mtime:
        return c
    with _lock:
        if (c := _read_json(cache)) is not None and cache.stat().st_mtime >= clean.stat().st_mtime:
            return c
        log.info("mask_overlap: scanning dataset %s", dataset_id)
        t0 = time.time()
        counts = _scan_passwords(clean, max_length=max_length)
        _write_json(cache, counts)
        log.info("mask_overlap: dataset %s scanned in %.1fs (%d masks)",
                 dataset_id, time.time() - t0, len(counts))
        return counts


# ── Wordlist mask histogram (shared across attacks with same wordlist) ───────


def _wordlist_path(name: str) -> Path:
    for c in [_CLEAN / f"{name}.txt.gz", _RAW / f"{name}.txt"]:
        if c.exists():
            return c
    raise FileNotFoundError(f"wordlist not found: {name}")


def wordlist_mask_distribution(name: str, *, max_length: int = 12) -> dict[str, int]:
    path = _wordlist_path(name)
    cache = _WORDLIST_CACHE / f"{name}.json"
    if (c := _read_json(cache)) is not None and cache.stat().st_mtime >= path.stat().st_mtime:
        return c
    with _lock:
        if (c := _read_json(cache)) is not None and cache.stat().st_mtime >= path.stat().st_mtime:
            return c
        log.info("mask_overlap: scanning wordlist %s", name)
        t0 = time.time()
        counts = _scan_passwords(path, max_length=max_length)
        _write_json(cache, counts)
        log.info("mask_overlap: wordlist %s scanned in %.1fs (%d masks)",
                 name, time.time() - t0, len(counts))
        return counts


# ── Attack mask distribution ──────────────────────────────────────────────────


def attack_mask_distribution(attack: AttackDef, *, max_length: int = 12) -> dict[str, int]:
    if attack.type == "mask":
        if not attack.mask:
            return {}
        # Single-mask attack: 100% of its candidates classify into one bucket.
        # The absolute count doesn't matter — only ratios between attacks
        # against the same reference do. Use 1 as a sentinel.
        return {attack.mask: 1}
    if attack.type in {"wordlist", "wordlist+rules"}:
        if not attack.wordlist:
            return {}
        return wordlist_mask_distribution(attack.wordlist, max_length=max_length)
    return {}


# ── Overlap estimation ────────────────────────────────────────────────────────


def estimate_overlap(attacks: list[AttackDef], reference: str) -> OverlapMatrix:
    ref = dataset_mask_distribution(reference)
    hits: dict[str, dict[str, int]] = {}
    for atk in attacks:
        if atk.type not in _SIMULATABLE:
            continue
        try:
            dist = attack_mask_distribution(atk)
        except (FileNotFoundError, RuntimeError) as exc:
            log.warning("estimate_overlap: skip %s: %s", atk.id, exc)
            continue
        # For mask attacks the sentinel count 1 vs ref's huge counts under-
        # represents them. Scale a mask attack up to the reference's count
        # in its mask so it competes meaningfully in the overlap math.
        if atk.type == "mask" and atk.mask:
            ref_in_mask = ref.get(atk.mask, 0)
            hits[atk.id] = {atk.mask: ref_in_mask} if ref_in_mask > 0 else {}
        else:
            hits[atk.id] = {m: min(c, ref[m]) for m, c in dist.items() if ref.get(m, 0) > 0}

    keys = list(hits)
    cells = [
        _pair_cell(a, b, hits[a], hits[b])
        for i, a in enumerate(keys)
        for b in keys[i + 1:]
    ]
    return OverlapMatrix(
        reference=reference,
        attacks=keys,
        cells=cells,
        set_sizes={a: sum(h.values()) for a, h in hits.items()},
    )


def _pair_cell(a: str, b: str, ha: dict[str, int], hb: dict[str, int]) -> JaccardCell:
    masks = set(ha) | set(hb)
    intersect = sum(min(ha.get(m, 0), hb.get(m, 0)) for m in masks)
    union = sum(max(ha.get(m, 0), hb.get(m, 0)) for m in masks)
    jacc = intersect / union if union else 0.0
    size_a, size_b = sum(ha.values()), sum(hb.values())
    max_single = max(size_a, size_b) or 1
    gain = ((union - max_single) / max_single) * 100.0 if union > max_single else 0.0
    verdict = "redundant" if jacc >= 0.6 else "complementary" if jacc < 0.3 else "judgment"
    return JaccardCell(
        a=a, b=b,
        jaccard=round(jacc, 4),
        verdict=verdict,
        marginal_gain_pct=round(gain, 2),
        only_a=size_a - intersect,
        only_b=size_b - intersect,
        intersect=intersect,
        union=union,
    )
