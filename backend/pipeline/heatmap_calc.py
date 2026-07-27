"""Per-position character frequency heatmap (Scene 3b).

Reproduces Van Heijningen 2013 Figure 5 / Appendix T:
for each position 0..N-1, count occurrence rate of each tracked char.

Cached per dataset under data/cache/heatmap/<dataset>.json. Mayzner's
English-language letter-frequency reference is hardcoded — it's a known
external benchmark that doesn't change.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from backend.models import HeatmapGrid
from backend.pipeline.mask_histogram import iter_passwords

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_CLEAN = _REPO / "data" / "clean"
_CACHE = _REPO / "data" / "cache" / "heatmap"
_CACHE.mkdir(parents=True, exist_ok=True)

# Storyboard alphabet — 20 cells covering vowels, common consonants, common digits.
ALPHABET = "aeiourns ltm c12 0 9 3 5 8 7".replace(" ", "")
POSITIONS = 8


def _cache_path(dataset: str) -> Path:
    return _CACHE / f"{dataset}.json"


def compute(dataset: str) -> HeatmapGrid:
    clean = _CLEAN / f"{dataset}.txt.gz"
    if not clean.exists():
        raise FileNotFoundError(f"cleaned corpus missing: {clean}")

    cached = _read_cache(dataset, clean)
    if cached is not None:
        return cached

    counts = [[0] * len(ALPHABET) for _ in range(POSITIONS)]
    per_pos_total = [0] * POSITIONS
    char_index = {c: i for i, c in enumerate(ALPHABET)}

    log.info("computing heatmap for %s", dataset)
    for pwd in iter_passwords(clean):
        for pos in range(min(POSITIONS, len(pwd))):
            per_pos_total[pos] += 1
            idx = char_index.get(pwd[pos].lower())
            if idx is not None:
                counts[pos][idx] += 1

    grid = [
        [
            (counts[p][c] / per_pos_total[p] * 100.0) if per_pos_total[p] else 0.0
            for c in range(len(ALPHABET))
        ]
        for p in range(POSITIONS)
    ]
    result = HeatmapGrid(
        dataset=dataset,
        positions=POSITIONS,
        alphabet=ALPHABET,
        frequencies=grid,
    )
    _write_cache(dataset, result)
    return result


def english_reference() -> HeatmapGrid:
    """Mayzner-revisited letter frequencies projected onto our alphabet.

    Source: Norvig's reanalysis of Mayzner's 1965 word-position table.
    Numbers below are word-positions 1..8 → letter frequency %. Digits are
    forced to 0 (English text has no positional digit pattern).
    """
    # Approximate per-position percentages from Norvig/Mayzner (English text).
    # Position-1..8 by letter. Letters not in ALPHABET get dropped.
    POS_LETTER = {
        "a": [11.7, 11.0, 9.1, 8.0, 7.0, 6.5, 6.0, 5.8],
        "e": [3.5, 14.0, 13.2, 12.6, 11.2, 10.5, 9.5, 9.0],
        "i": [4.0, 8.0, 11.5, 9.0, 8.0, 7.5, 7.0, 6.5],
        "o": [6.0, 9.5, 9.0, 8.5, 7.5, 6.8, 6.5, 6.0],
        "u": [1.5, 2.8, 4.0, 4.5, 4.0, 3.5, 3.2, 3.0],
        "r": [2.8, 5.5, 8.0, 7.0, 6.5, 6.0, 5.5, 5.0],
        "n": [2.0, 5.0, 7.5, 7.0, 6.5, 6.0, 5.5, 5.0],
        "s": [6.0, 3.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0],
        "l": [2.5, 4.5, 4.5, 5.0, 4.5, 4.0, 3.5, 3.0],
        "t": [11.0, 5.0, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5],
        "m": [2.5, 2.0, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5],
        "c": [3.5, 1.5, 2.0, 2.5, 2.5, 2.5, 2.5, 2.5],
    }
    grid = []
    for pos in range(POSITIONS):
        row = []
        for ch in ALPHABET:
            v = 0.0
            if ch in POS_LETTER:
                v = POS_LETTER[ch][pos]
            row.append(v)
        grid.append(row)
    return HeatmapGrid(dataset="english_ref", positions=POSITIONS, alphabet=ALPHABET, frequencies=grid)


# Narrative profile per dataset, derived from MAYA §4.2 + Van Heijningen.
PROFILES: dict[str, str] = {
    "rockyou": "English-like; vowels concentrated in early positions; digits dominate positions 7-8.",
    "zerozeroowebhost": "Like RockYou but stricter; digits in tail even more concentrated (2-class policy effect).",
    "taobao": "Almost entirely digit-driven across all positions. PIN-style behaviour — Chinese users typing numeric passwords.",
    "mailru": "Cyrillic-keyboard pattern; demeuk strips non-ASCII, leaving digit-tail-dominant residue.",
    "linkedin": "Stricter min-length policy. Letters predominate; trailing digits show up but later than RockYou.",
    "gmail": "Mixed English-like with some Cyrillic-keyboard traces; vowels early, digits at the tail.",
    "ashleymadison": "Small, mostly unique. Letters-only patterns dominate; few obvious common shapes.",
    "libero": "Italian language. Vowels appear more uniformly across positions than English.",
    "english_ref": "Reference distribution from Mayzner-revisited; English text only — no digits, vowel/consonant pattern only.",
}


def profile_for(dataset: str) -> str:
    return PROFILES.get(dataset, "no profile narrative for this dataset yet")


# ── Cache ────────────────────────────────────────────────────────────────────


def _read_cache(dataset: str, source: Path) -> HeatmapGrid | None:
    p = _cache_path(dataset)
    if not p.exists():
        return None
    if source.exists() and source.stat().st_mtime > p.stat().st_mtime:
        return None
    try:
        with p.open("r") as fh:
            return HeatmapGrid.model_validate(json.load(fh))
    except (OSError, ValueError, TypeError) as exc:
        log.warning("heatmap cache read failed for %s: %s", p, exc)
        return None


def _write_cache(dataset: str, grid: HeatmapGrid) -> None:
    p = _cache_path(dataset)
    tmp = p.with_suffix(".json.tmp")
    with tmp.open("w") as fh:
        json.dump(grid.model_dump(), fh)
    tmp.replace(p)
