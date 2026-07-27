"""Parser for MAYA's published rq1.csv crack-rate results.

MAYA ships the full benchmark output from their paper as
`third_party/maya/results/rq1/rq1.csv` — 1638 rows covering 6 generative
models (FLA, PassGAN, PassFlow, PassGPT, PLRGAN, VGPT2) × 8 training
datasets × multiple n_samples thresholds, all on their `all-8-100-80`
test settings (chars ≤ 8, 100% train chunk, 80% train/test split).

We use these directly as ground truth for crack rates. Actually
training FLA on this host (CPU, 4GB RAM) would take many hours and
wouldn't beat the paper-grade GPU run anyway.

The CSV row format is:
    model,train-dataset,test-settings,test-hash,test-size,n_samples,matches,match_percentage

We expose:
- ``models()`` -> available model ids
- ``training_datasets(model)`` -> training corpora benchmarked for a model
- ``curve(model, training_dataset)`` -> list[(n_samples, match_pct)] sorted by n_samples
"""

from __future__ import annotations

import csv
import functools
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_CSV = _REPO / "third_party" / "maya" / "results" / "rq1" / "rq1.csv"


@functools.cache
def _rows() -> list[dict[str, str]]:
    if not _CSV.exists():
        return []
    with _CSV.open() as fh:
        return list(csv.DictReader(fh))


def is_available() -> bool:
    return _CSV.exists() and len(_rows()) > 0


def models() -> list[str]:
    return sorted({r["model"] for r in _rows()})


def training_datasets(model: str) -> list[str]:
    return sorted({r["train-dataset"] for r in _rows() if r["model"] == model})


def curve(model: str, training_dataset: str) -> list[tuple[int, float]]:
    pts: list[tuple[int, float]] = []
    for r in _rows():
        if r["model"] != model or r["train-dataset"] != training_dataset:
            continue
        n = int(r["n_samples"])
        pct = float(r["match_percentage"].rstrip("%"))
        pts.append((n, pct))
    return sorted(pts, key=lambda x: x[0])


def crack_rate(model: str, training_dataset: str, n_samples: int) -> float | None:
    """Return the published crack rate (%) at the closest n_samples ≤ requested.

    None if no row matches.
    """
    pts = curve(model, training_dataset)
    if not pts:
        return None
    # Take the highest n_samples that doesn't exceed the requested budget.
    eligible = [(n, pct) for n, pct in pts if n <= n_samples]
    if eligible:
        return eligible[-1][1]
    # If even the smallest is above budget, return that one's rate at face value.
    return pts[0][1]
