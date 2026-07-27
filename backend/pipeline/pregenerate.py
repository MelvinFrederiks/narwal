"""Warm-up: precompute /api/coverage for every cleaned dataset at the
default params so the first browser hit is instant.

Called from the FastAPI lifespan event in backend/main.py. Runs in a
background thread so server startup is not blocked.
"""

from __future__ import annotations

import logging
import threading
import time
import tomllib
from pathlib import Path

from backend.models import ClusterSpec
from backend.pipeline import coverage_cache, hashrates as hr
from backend.pipeline.mask_histogram import coverage, histogram, iter_passwords

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_REGISTRY = _REPO / "backend" / "config" / "datasets.toml"
_CLEAN = _REPO / "data" / "clean"

DEFAULT_HASH_TYPE = "ntlm"
DEFAULT_GPU_COUNT = 8
DEFAULT_MAX_LENGTH = 12
DEFAULT_TOP_N = 30


def _registry() -> dict:
    with _REGISTRY.open("rb") as fh:
        return tomllib.load(fh)


def warm_one(dataset_id: str) -> bool:
    """Compute + cache one dataset. Returns True on success, False on skip."""
    clean_path = _CLEAN / f"{dataset_id}.txt.gz"
    if not clean_path.exists():
        log.info("pregenerate skip %s: no cleaned corpus", dataset_id)
        return False

    cached = coverage_cache.get(
        dataset_id,
        DEFAULT_HASH_TYPE,
        DEFAULT_GPU_COUNT,
        DEFAULT_MAX_LENGTH,
        DEFAULT_TOP_N,
        source_path=clean_path,
    )
    if cached is not None:
        log.info("pregenerate hit %s: cache fresh", dataset_id)
        return True

    entry = _registry()[dataset_id]
    dataset_size = int(entry.get("unique") or entry["size"])
    cluster = ClusterSpec(gpu_count=DEFAULT_GPU_COUNT, hash_type=DEFAULT_HASH_TYPE)
    cluster_ghs = hr.cluster_ghs(cluster)

    t0 = time.time()
    counts, total = histogram(iter_passwords(clean_path), max_length=DEFAULT_MAX_LENGTH)
    resp = coverage(
        counts,
        total,
        dataset=dataset_id,
        dataset_size=dataset_size,
        cluster_hashrate_ghs=cluster_ghs,
        hash_type=DEFAULT_HASH_TYPE,
        top_n=DEFAULT_TOP_N,
    )
    coverage_cache.put(
        resp,
        dataset=dataset_id,
        hash_type=DEFAULT_HASH_TYPE,
        gpu_count=DEFAULT_GPU_COUNT,
        max_length=DEFAULT_MAX_LENGTH,
        top_n=DEFAULT_TOP_N,
    )
    log.info("pregenerate %s: %.1f s, %d masks", dataset_id, time.time() - t0, len(resp.masks))
    return True


def warm_all_blocking() -> None:
    for ds in _registry():
        try:
            warm_one(ds)
        except Exception as exc:  # noqa: BLE001
            log.warning("pregenerate %s failed: %s", ds, exc)


def warm_all_in_background() -> threading.Thread:
    t = threading.Thread(target=warm_all_blocking, name="coverage-warmup", daemon=True)
    t.start()
    return t


# ── Extra warmers for the non-coverage scenes ────────────────────────────────


def warm_heatmaps() -> None:
    from backend.pipeline import heatmap_calc

    for ds in _registry():
        if not (_CLEAN / f"{ds}.txt.gz").exists():
            continue
        try:
            heatmap_calc.compute(ds)
        except Exception as exc:  # noqa: BLE001
            log.warning("heatmap warmup %s failed: %s", ds, exc)


def warm_features_and_cluster() -> None:
    from backend.pipeline import features, umap_project

    ids = [d for d in _registry() if (_CLEAN / f"{d}.txt.gz").exists()]
    for d in ids:
        try:
            features.feature_vector(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("features warmup %s failed: %s", d, exc)
    try:
        umap_project.project(ids)
    except Exception as exc:  # noqa: BLE001
        log.warning("umap warmup failed: %s", exc)


def _attack_library() -> list:
    from backend.models import AttackDef

    attacks_toml = _REPO / "backend" / "config" / "attacks.toml"
    with attacks_toml.open("rb") as fh:
        data = tomllib.load(fh)
    return [AttackDef(**a) for a in data["attack"]]


def warm_dataset_masks() -> None:
    """Full per-dataset mask histograms (used by approximate Overlap)."""
    from backend.pipeline import mask_overlap

    for ds in _registry():
        if not (_CLEAN / f"{ds}.txt.gz").exists():
            continue
        try:
            mask_overlap.dataset_mask_distribution(ds)
        except Exception as exc:  # noqa: BLE001
            log.warning("mask_overlap dataset warmup %s failed: %s", ds, exc)


def warm_attack_masks() -> None:
    """Per-wordlist mask histograms — shared across all attacks that use them.

    Mask attacks need no precompute (their distribution is the literal mask).
    """
    from backend.pipeline import mask_overlap

    wordlists = {atk.wordlist for atk in _attack_library() if atk.wordlist}
    for wl in wordlists:
        try:
            mask_overlap.wordlist_mask_distribution(wl)
        except Exception as exc:  # noqa: BLE001
            log.warning("mask_overlap wordlist warmup %s failed: %s", wl, exc)


def warm_all_extras_blocking() -> None:
    warm_heatmaps()
    warm_features_and_cluster()
    warm_dataset_masks()
    warm_attack_masks()


def warm_all_extras_in_background() -> threading.Thread:
    t = threading.Thread(target=warm_all_extras_blocking, name="extras-warmup", daemon=True)
    t.start()
    return t
