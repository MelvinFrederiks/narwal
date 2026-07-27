"""Scene 5 — UMAP dataset cluster (REAL).

GET /api/cluster — projects every cleaned dataset's feature vector to 2D
via UMAP (with PCA fallback). Returns coords + region labels for the
storyboard's three labelled cluster regions.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from fastapi import APIRouter, Query

from backend.models import ClusterMap, ClusterPoint, ClusterRegion
from backend.pipeline import features, umap_project

router = APIRouter()

_REGISTRY = Path(__file__).resolve().parents[1] / "config" / "datasets.toml"


def _registry_ids() -> list[str]:
    with _REGISTRY.open("rb") as fh:
        return list(tomllib.load(fh).keys())


@router.get("/api/cluster", response_model=ClusterMap)
def get_cluster(
    datasets: str | None = Query(
        None,
        description="Comma-separated dataset ids to project. Defaults to every registered dataset.",
    ),
) -> ClusterMap:
    if datasets:
        ids = [d.strip() for d in datasets.split(",") if d.strip()]
        registry = set(_registry_ids())
        ids = [d for d in ids if d in registry]
    else:
        ids = _registry_ids()
    if not ids:
        return ClusterMap(points=[], feature_dim=features.DIM, regions=[], method="umap")
    proj = umap_project.project(ids)
    sizes = _dataset_sizes()
    points = [
        ClusterPoint(
            id=p["id"],
            x=p["x"],
            y=p["y"],
            region=p.get("region"),
            size=sizes.get(p["id"]),
        )
        for p in proj["points"]
    ]
    regions = [ClusterRegion(**r) for r in proj["regions"]]
    return ClusterMap(points=points, feature_dim=features.DIM, regions=regions, method="umap")


def _dataset_sizes() -> dict[str, int]:
    with _REGISTRY.open("rb") as fh:
        data = tomllib.load(fh)
    return {k: int(v.get("unique") or v.get("size", 0)) for k, v in data.items()}
