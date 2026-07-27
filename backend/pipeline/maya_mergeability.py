"""Parser for MAYA's published rq6.1 mergeability-index results.

MAYA RQ6.1 quantifies how *complementary* two password-guessing models are.
Given the sets of passwords each model successfully cracked on the same test
set, A and B, the mergeability index is

    (|A ∪ B| − max(|A|, |B|)) / max(|A|, |B|)

i.e. the fractional gain in unique cracked passwords you get by merging the
weaker (smaller) model's hits into the stronger (larger) model's, relative to
the stronger model alone. 0 ⇒ the weaker set is fully contained in the
stronger one (no point combining them); higher ⇒ the two models crack
disjoint passwords, so an ensemble/merge is worthwhile. Symmetric in A, B and
bounded in [0, 1].

It is the sibling metric of RQ6.1's Jaccard index. For Narwal the useful slice
is the ``fla-*`` pairs: whether adding another DL guesser to FLA would
meaningfully expand coverage, or just re-crack the same passwords.

MAYA ships the computed values as
``third_party/maya/results/rq6.1-mergeability/rq6.1-mergeability.csv`` — one
row per (model-pair, train-dataset) at their ``all-12-100-80`` / 500M-sample
setting. The CSV row format is:

    combo,train-dataset,test-settings,n_samples,mergeability-index

where ``combo`` is ``<modelA>-<modelB>`` (model ids are hyphen-free).

Train-dataset ids are passed through verbatim as MAYA writes them (e.g.
``000webhost``), matching the sibling ``maya_results`` loader — the UI/registry
layer owns display-label mapping (``zerozeroowebhost`` ↔ ``000webhost``).

We expose:
- ``is_available()``
- ``models()`` -> distinct model ids appearing in any pair, sorted
- ``datasets()`` -> train-datasets present, sorted
- ``pairs(dataset=None)`` -> list[MergePair], optionally filtered by train-dataset
"""

from __future__ import annotations

import csv
import functools
from pathlib import Path
from typing import NamedTuple

_REPO = Path(__file__).resolve().parents[2]
_CSV = _REPO / "third_party" / "maya" / "results" / "rq6.1-mergeability" / "rq6.1-mergeability.csv"


class MergePair(NamedTuple):
    model_a: str
    model_b: str
    train_dataset: str
    test_settings: str
    n_samples: int
    mergeability_index: float

    @property
    def combo(self) -> str:
        return f"{self.model_a}-{self.model_b}"


@functools.cache
def _rows() -> list[MergePair]:
    """Parse the CSV, de-duplicating byte-identical rows.

    MAYA's shipped CSV appends re-runs of some (pair, dataset) combinations, so
    ~1/3 of rows are exact duplicates (330 lines → 224 unique). We collapse them
    by full-tuple identity, preserving first-seen order.
    """
    if not _CSV.exists():
        return []
    out: list[MergePair] = []
    seen: set[MergePair] = set()
    with _CSV.open() as fh:
        for r in csv.DictReader(fh):
            model_a, model_b = r["combo"].split("-", 1)
            pair = MergePair(
                model_a=model_a,
                model_b=model_b,
                train_dataset=r["train-dataset"],
                test_settings=r["test-settings"],
                n_samples=int(r["n_samples"]),
                mergeability_index=float(r["mergeability-index"]),
            )
            if pair not in seen:
                seen.add(pair)
                out.append(pair)
    return out


def is_available() -> bool:
    return _CSV.exists() and len(_rows()) > 0


def models() -> list[str]:
    return sorted({m for p in _rows() for m in (p.model_a, p.model_b)})


def datasets() -> list[str]:
    return sorted({p.train_dataset for p in _rows()})


def pairs(dataset: str | None = None) -> list[MergePair]:
    """All (model-pair, dataset) mergeability rows, optionally filtered.

    Sorted by (train_dataset, combo) for a stable, deterministic order.
    """
    rows = [p for p in _rows() if dataset is None or p.train_dataset == dataset]
    return sorted(rows, key=lambda p: (p.train_dataset, p.combo))
