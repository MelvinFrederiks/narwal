"""Scene 2 — attack composer.

GET  /api/compose/library     — returns the attack library from attacks.toml
POST /api/compose/estimate    — returns per-step estimates for a pipeline.
                                 If `?simulate=1` and the (attack, reference)
                                 pair is in the cache, uses real hashcat-stdout
                                 sim numbers; otherwise falls back to a
                                 keyspace+heuristic estimate.

See wiki/methodology.md "What we simulate vs. what we run".
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from backend.models import (
    AttackDef,
    AttackLibrary,
    PipelineEstimate,
    PipelineEstimateRequest,
    PipelineStep,
)
from backend.pipeline import attack_sim, hashrates as hr
from backend.pipeline.mask_histogram import keyspace as mask_keyspace

router = APIRouter()

_ATTACKS_TOML = Path(__file__).resolve().parents[1] / "config" / "attacks.toml"


def _load_attacks() -> list[AttackDef]:
    with _ATTACKS_TOML.open("rb") as fh:
        data = tomllib.load(fh)
    return [AttackDef(**a) for a in data["attack"]]


@router.get("/api/compose/library", response_model=AttackLibrary)
def attack_library() -> AttackLibrary:
    return AttackLibrary(attacks=_load_attacks())


@router.post("/api/compose/estimate", response_model=PipelineEstimate)
def estimate_pipeline(
    req: PipelineEstimateRequest,
    simulate: int = Query(0, ge=0, le=1, description="1 = use cached hashcat sim if available"),
    reference: str = Query("rockyou"),
) -> PipelineEstimate:
    by_id = {a.id: a for a in _load_attacks()}
    cluster_ghs = hr.cluster_ghs(req.cluster)
    hashes_per_second = cluster_ghs * 1e9

    steps: list[PipelineStep] = []
    cum_hits: set[str] = set()
    total_ref_size = 0

    for attack_id in req.attack_ids:
        if attack_id not in by_id:
            raise HTTPException(404, f"unknown attack: {attack_id}")
        attack = by_id[attack_id]
        keyspace = _keyspace_for(attack)
        seconds = keyspace / hashes_per_second
        yield_pct = _yield_for(attack, reference, simulate, cum_hits)
        if simulate and total_ref_size == 0:
            try:
                total_ref_size = attack_sim.reference_size(reference)
            except FileNotFoundError:
                total_ref_size = 0
        steps.append(
            PipelineStep(
                attack_id=attack.id,
                label=attack.label,
                estimated_keyspace=keyspace,
                estimated_seconds=seconds,
                expected_yield_pct=yield_pct,
            )
        )

    return PipelineEstimate(
        steps=steps,
        total_seconds=sum(s.estimated_seconds for s in steps),
        total_expected_yield_pct=round(sum(s.expected_yield_pct for s in steps), 2),
    )


def _keyspace_for(attack: AttackDef) -> int:
    if attack.type == "mask" and attack.mask:
        return mask_keyspace(attack.mask)
    if attack.type == "wordlist":
        return 10_000_000
    if attack.type == "wordlist+rules":
        # Wordlist size × rule count. Real numbers would parse the rule file.
        return 5_000_000_000
    return 1_000_000_000


def _yield_for(attack: AttackDef, reference: str, simulate: int, cum_hits: set[str]) -> float:
    """If simulate=1 and we have a cached sim for (attack, reference), use the
    real incremental yield. Otherwise heuristic by attack type."""
    if simulate:
        cached = attack_sim.get_cached_hits(attack.id, reference)
        if cached is not None:
            try:
                ref_size = attack_sim.reference_size(reference) or 1
                new_hits = cached - cum_hits
                cum_hits.update(cached)
                return round(len(new_hits) / ref_size * 100.0, 2)
            except FileNotFoundError:
                pass
    base = {
        "wordlist": 18.0,
        "wordlist+rules": 32.0,
        "mask": 8.0,
        "hybrid": 12.0,
        "omen": 22.0,
        "pcfg": 25.0,
    }.get(attack.type, 5.0)
    diminish = max(0.2, 1.0 - len(cum_hits) / 1_000_000)
    return round(base * diminish, 2)
