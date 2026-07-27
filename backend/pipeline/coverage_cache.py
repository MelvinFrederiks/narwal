"""On-disk JSON cache for /api/coverage results.

Keyed on the full input tuple. Files land under data/cache/coverage/ and
are gitignored (data/cache/* is excluded by .gitignore alongside raw/clean/).

Invalidated implicitly: if the cleaned corpus's mtime is newer than the
cached JSON's mtime, the cache entry is treated as stale.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from backend.models import CoverageResponse, HashType

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_CACHE_DIR = _REPO / "data" / "cache" / "coverage"


def _key(
    dataset: str,
    hash_type: HashType,
    gpu_count: int,
    max_length: int,
    top_n: int,
) -> str:
    return f"{dataset}__{hash_type}__g{gpu_count}__L{max_length}__N{top_n}.json"


def _path(*args, **kw) -> Path:
    return _CACHE_DIR / _key(*args, **kw)


def get(
    dataset: str,
    hash_type: HashType,
    gpu_count: int,
    max_length: int,
    top_n: int,
    *,
    source_path: Path | None = None,
) -> CoverageResponse | None:
    p = _path(dataset, hash_type, gpu_count, max_length, top_n)
    if not p.exists():
        return None
    if source_path is not None and source_path.exists():
        if source_path.stat().st_mtime > p.stat().st_mtime:
            log.info("cache stale (source newer): %s", p)
            return None
    try:
        with p.open("r", encoding="utf-8") as fh:
            return CoverageResponse.model_validate(json.load(fh))
    except (OSError, ValueError, TypeError) as exc:
        log.warning("cache read failed for %s: %s", p, exc)
        return None


def put(
    resp: CoverageResponse,
    *,
    dataset: str,
    hash_type: HashType,
    gpu_count: int,
    max_length: int,
    top_n: int,
) -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _path(dataset, hash_type, gpu_count, max_length, top_n)
    tmp = p.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(resp.model_dump(), fh)
    tmp.replace(p)
    log.info("cached coverage: %s", p)
