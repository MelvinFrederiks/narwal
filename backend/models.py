"""Wire-level pydantic v2 contracts for every Narwal API endpoint.

This module is the single source of truth for what crosses the FastAPI boundary.
Add a field here before adding it in a route or a scene module.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

HashType = Literal["ntlm", "md5", "bcrypt", "sha1", "sha256"]
AttackType = Literal["wordlist", "wordlist+rules", "mask", "hybrid", "omen", "pcfg", "fla"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# ── Cluster / target spec ──────────────────────────────────────────────────────


class ClusterSpec(StrictModel):
    gpu: str = "rtx_5080"
    gpu_count: int = Field(default=8, ge=1, le=64)
    hash_type: HashType = "ntlm"
    hashrate_ghs_override: float | None = Field(default=None, ge=0)


class TargetSpec(StrictModel):
    hash_type: HashType
    hash_count: int = Field(ge=1)
    length_distribution: dict[int, int] | None = None
    cracked_sample: list[str] | None = None


# ── Dataset registry (GET /api/datasets) ───────────────────────────────────────


class DatasetSummary(StrictModel):
    id: str
    label: str
    size: int
    unique: int | None = None
    year: int
    origin: str
    language: str
    service: str
    policy: str
    cleaned: bool


class DatasetList(StrictModel):
    datasets: list[DatasetSummary]


# ── Scene 3 — coverage (GET /api/coverage) ─────────────────────────────────────


class MaskRow(StrictModel):
    mask: str
    coverage_pct: float
    cumulative_pct: float
    keyspace: int
    crack_time_seconds: float
    cumulative_crack_time_seconds: float


class CoverageResponse(StrictModel):
    dataset: str
    dataset_size: int
    cluster_hashrate_ghs: float
    hash_type: HashType
    masks: list[MaskRow]
    budget_kink_index: int | None = Field(
        default=None,
        description="Index in `masks` where cracking-time slope inflects. UI annotates here.",
    )


# ── Scene 2 — composer (STUB) ──────────────────────────────────────────────────


class AttackDef(StrictModel):
    id: str
    type: AttackType
    label: str
    wordlist: str | None = None
    rules: str | None = None
    mask: str | None = None
    training: str | None = None
    guess_budget: int | None = None
    notes: str | None = None


class AttackLibrary(StrictModel):
    attacks: list[AttackDef]


class PipelineStep(StrictModel):
    attack_id: str
    label: str
    estimated_keyspace: int
    estimated_seconds: float
    expected_yield_pct: float


class PipelineEstimate(StrictModel):
    steps: list[PipelineStep]
    total_seconds: float
    total_expected_yield_pct: float


class PipelineEstimateRequest(StrictModel):
    attack_ids: list[str]
    target: TargetSpec
    cluster: ClusterSpec


# ── Scene 4 — overlap (STUB) ───────────────────────────────────────────────────


class JaccardCell(StrictModel):
    a: str
    b: str
    jaccard: float
    verdict: Literal["redundant", "complementary", "judgment"]
    marginal_gain_pct: float
    only_a: int = 0
    only_b: int = 0
    intersect: int = 0
    union: int = 0


class OverlapMatrix(StrictModel):
    reference: str
    attacks: list[str]
    cells: list[JaccardCell]
    set_sizes: dict[str, int] = Field(default_factory=dict)


# ── Scene 5 — cluster (STUB) ───────────────────────────────────────────────────


class ClusterPoint(StrictModel):
    id: str
    x: float
    y: float
    is_target: bool = False
    nearest_neighbour: str | None = None
    region: str | None = None
    size: int | None = None


class ClusterRegion(StrictModel):
    name: str
    cx: float
    cy: float
    rx: float
    ry: float
    count: int


class ClusterMap(StrictModel):
    points: list[ClusterPoint]
    method: Literal["umap", "pca"] = "umap"
    feature_dim: int
    regions: list[ClusterRegion] = Field(default_factory=list)


# ── Scene 6 — verdict (STUB) ───────────────────────────────────────────────────


class VerdictRequest(StrictModel):
    target: TargetSpec
    cluster: ClusterSpec
    budget_hours: float = Field(gt=0)
    candidate_refs: list[str] | None = None


class RecommendedStep(StrictModel):
    attack_id: str
    label: str
    estimated_seconds: float
    expected_yield_pct: float
    rationale: str


class Verdict(StrictModel):
    strongest_reference: str
    weakest_reference: str
    recommended_chain: list[RecommendedStep]
    total_expected_yield_pct: float
    total_seconds: float
    notes: list[str]


# ── Scene 3b — heatmap (STUB) ──────────────────────────────────────────────────


class HeatmapGrid(StrictModel):
    dataset: str
    positions: int = Field(default=8, ge=1, le=32)
    alphabet: str
    frequencies: list[list[float]]
    profile: str | None = None


# ── Bridge — Hashtopolis (STUB except auth) ────────────────────────────────────


class BridgeAuthRequest(StrictModel):
    base_url: str
    api_key: str


class BridgeAuthResult(StrictModel):
    ok: bool
    server_version: str | None = None
    detail: str | None = None


class TaskChainExportRequest(StrictModel):
    pipeline: list[PipelineStep]
    target: TargetSpec
    cluster: ClusterSpec
    name: str


class TaskChainExportResult(StrictModel):
    ok: bool
    supertask_id: int | None = None
    detail: str | None = None
    request: dict | None = None
    payload: dict | None = None
    metadata: dict | None = None


# ── /profile aggregator ───────────────────────────────────────────────────────


class ProfileRequest(StrictModel):
    target: TargetSpec
    cluster: ClusterSpec
    dataset: str = "rockyou"


class ProfileResponse(StrictModel):
    coverage: CoverageResponse
    overlap: OverlapMatrix
    cluster_map: ClusterMap
    heatmap: HeatmapGrid
    verdict: Verdict
