"""POST /profile — coarse aggregator over the per-scene endpoints.

Kept per the wiki's original endpoint list (wiki/architecture.md). Fans
out to coverage/overlap/cluster/heatmap/verdict so a single client call
returns the whole analysis blob.
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.models import (
    ClusterSpec,
    HashType,
    ProfileRequest,
    ProfileResponse,
    VerdictRequest,
)

from . import cluster as cluster_route
from . import coverage as coverage_route
from . import heatmap as heatmap_route
from . import overlap as overlap_route
from . import verdict as verdict_route

router = APIRouter()


@router.post("/profile", response_model=ProfileResponse)
def profile(req: ProfileRequest) -> ProfileResponse:
    coverage = coverage_route.get_coverage(
        dataset=req.dataset,
        hash_type=req.target.hash_type,
        gpu_count=req.cluster.gpu_count,
        max_length=12,
        top_n=30,
    )
    overlap = overlap_route.get_overlap(datasets=req.dataset)
    cluster_map = cluster_route.get_cluster()
    heatmap = heatmap_route.get_heatmap(dataset=req.dataset)
    verdict = verdict_route.get_verdict(
        VerdictRequest(target=req.target, cluster=req.cluster, budget_hours=24.0)
    )
    return ProfileResponse(
        coverage=coverage,
        overlap=overlap,
        cluster_map=cluster_map,
        heatmap=heatmap,
        verdict=verdict,
    )
