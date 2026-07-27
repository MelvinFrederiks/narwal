"""GET /api/coverage?dataset=<id> — the Scene 3 headline endpoint.

Reads the cleaned corpus from data/clean/<dataset>.txt.gz, builds a mask
histogram, ranks by yield-per-cost, and accumulates crack-time for the
configured cluster. See wiki/methodology.md "Cumulative mask coverage".
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from backend.models import ClusterSpec, CoverageResponse, HashType
from backend.pipeline import coverage_cache, hashrates as hr
from backend.pipeline.mask_histogram import coverage, histogram, iter_passwords

router = APIRouter()

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent
_REGISTRY = _BACKEND / "config" / "datasets.toml"
_CLEAN = _REPO / "data" / "clean"


def _registry() -> dict:
    with _REGISTRY.open("rb") as fh:
        return tomllib.load(fh)


@router.get("/api/coverage", response_model=CoverageResponse)
def get_coverage(
    dataset: str = Query("rockyou"),
    hash_type: HashType = Query("ntlm"),
    gpu_count: int = Query(8, ge=1, le=64),
    max_length: int = Query(12, ge=4, le=32),
    top_n: int = Query(30, ge=5, le=200),
) -> CoverageResponse:
    registry = _registry()
    if dataset not in registry:
        raise HTTPException(404, f"unknown dataset: {dataset}")

    clean_path = _CLEAN / f"{dataset}.txt.gz"
    if not clean_path.exists():
        raise HTTPException(
            409,
            f"dataset {dataset!r} is not cleaned yet — run demeuk; "
            f"expected {clean_path}",
        )

    cached = coverage_cache.get(
        dataset, hash_type, gpu_count, max_length, top_n, source_path=clean_path
    )
    if cached is not None:
        return cached

    cluster = ClusterSpec(gpu_count=gpu_count, hash_type=hash_type)
    cluster_ghs = hr.cluster_ghs(cluster)
    entry = registry[dataset]
    dataset_size = int(entry.get("unique") or entry["size"])

    counts, total = histogram(iter_passwords(clean_path), max_length=max_length)
    resp = coverage(
        counts,
        total,
        dataset=dataset,
        dataset_size=dataset_size,
        cluster_hashrate_ghs=cluster_ghs,
        hash_type=hash_type,
        top_n=top_n,
    )
    coverage_cache.put(
        resp,
        dataset=dataset,
        hash_type=hash_type,
        gpu_count=gpu_count,
        max_length=max_length,
        top_n=top_n,
    )
    return resp
