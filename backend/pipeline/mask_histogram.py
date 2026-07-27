"""PACK-style mask histogram and cumulative coverage.

For each password we compute a hashcat character-class mask
(`?l` lowercase, `?u` uppercase, `?d` digit, `?s` special) and aggregate.
Masks are then ranked by `(coverage_pct / log10(keyspace))` so the
cheapest-per-yield masks come first — this is the ordering that produces
the visible "budget kink" in Van Heijningen 2013 Appendix O.2.

Crack time per mask = `keyspace / cluster_hashrate`. Accumulated to give
the dashed amber line on the headline chart.

See wiki/methodology.md "Cumulative mask coverage".
"""

from __future__ import annotations

import gzip
import math
from collections.abc import Iterable, Iterator
from pathlib import Path

from backend.models import CoverageResponse, MaskRow

_LOWER = set("abcdefghijklmnopqrstuvwxyz")
_UPPER = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_DIGIT = set("0123456789")

_KEYSPACE = {"?l": 26, "?u": 26, "?d": 10, "?s": 33}


def classify(pwd: str) -> str | None:
    """Return the hashcat mask for `pwd`, or None if every char is unclassifiable."""
    parts: list[str] = []
    for ch in pwd:
        if ch in _LOWER:
            parts.append("?l")
        elif ch in _UPPER:
            parts.append("?u")
        elif ch in _DIGIT:
            parts.append("?d")
        elif ch.isprintable() and not ch.isspace():
            parts.append("?s")
        else:
            return None
    return "".join(parts) if parts else None


def keyspace(mask: str) -> int:
    if not mask:
        return 1
    out = 1
    for i in range(0, len(mask), 2):
        token = mask[i : i + 2]
        out *= _KEYSPACE.get(token, 1)
    return out


def iter_passwords(clean_gz: Path) -> Iterator[str]:
    with gzip.open(clean_gz, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line:
                yield line


def histogram(
    passwords: Iterable[str],
    *,
    max_length: int = 12,
) -> tuple[dict[str, int], int]:
    """Return `(counts_by_mask, total_classified)` for passwords ≤ max_length."""
    counts: dict[str, int] = {}
    total = 0
    for pwd in passwords:
        if len(pwd) > max_length or not pwd:
            continue
        mask = classify(pwd)
        if mask is None:
            continue
        counts[mask] = counts.get(mask, 0) + 1
        total += 1
    return counts, total


def _rank_score(coverage_pct: float, mask: str) -> float:
    ks = keyspace(mask)
    if ks <= 1:
        return float("inf")
    return coverage_pct / math.log10(ks)


def _detect_budget_kink(rows: list[MaskRow], *, min_cum_seconds: float = 60.0) -> int | None:
    """Index where the cracking-time curve goes near-vertical.

    Heuristic: walk the ranked masks; the kink is the first row where
    *both* the marginal cost-per-yield jumps 10× over the prior row AND
    the cumulative crack time has already crossed a meaningful budget
    floor (default 60 s on the cluster). The floor prevents triggering
    on the sub-millisecond noise at the head of the ranking, where
    every row's crack time is a tiny multiple of the previous one.
    """
    if len(rows) < 4:
        return None
    prev_ratio: float | None = None
    for i, row in enumerate(rows):
        if row.coverage_pct <= 0:
            continue
        ratio = row.crack_time_seconds / row.coverage_pct
        if (
            prev_ratio is not None
            and prev_ratio > 0
            and ratio > 10 * prev_ratio
            and row.cumulative_crack_time_seconds >= min_cum_seconds
        ):
            return i
        prev_ratio = ratio
    return None


def coverage(
    counts: dict[str, int],
    total: int,
    *,
    dataset: str,
    dataset_size: int,
    cluster_hashrate_ghs: float,
    hash_type: str,
    top_n: int = 30,
) -> CoverageResponse:
    if total <= 0:
        return CoverageResponse(
            dataset=dataset,
            dataset_size=dataset_size,
            cluster_hashrate_ghs=cluster_hashrate_ghs,
            hash_type=hash_type,
            masks=[],
            budget_kink_index=None,
        )

    enriched = []
    for mask, n in counts.items():
        coverage_pct = (n / total) * 100.0
        enriched.append((mask, coverage_pct, keyspace(mask)))

    enriched.sort(key=lambda row: _rank_score(row[1], row[0]), reverse=True)
    enriched = enriched[:top_n]

    hashes_per_second = cluster_hashrate_ghs * 1e9
    cum_pct = 0.0
    cum_time = 0.0
    rows: list[MaskRow] = []
    for mask, coverage_pct, ks in enriched:
        crack_time = ks / hashes_per_second
        cum_pct += coverage_pct
        cum_time += crack_time
        rows.append(
            MaskRow(
                mask=mask,
                coverage_pct=round(coverage_pct, 4),
                cumulative_pct=round(cum_pct, 4),
                keyspace=ks,
                crack_time_seconds=crack_time,
                cumulative_crack_time_seconds=cum_time,
            )
        )

    return CoverageResponse(
        dataset=dataset,
        dataset_size=dataset_size,
        cluster_hashrate_ghs=cluster_hashrate_ghs,
        hash_type=hash_type,
        masks=rows,
        budget_kink_index=_detect_budget_kink(rows),
    )
