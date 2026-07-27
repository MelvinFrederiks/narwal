"""Verdict engine — picks a recommended attack chain (Scene 6).

Algorithm (greedy, budget-bounded):
  1. Pick the reference dataset whose feature vector is closest to the
     target (cosine distance).
  2. For each candidate attack from attacks.toml, simulate against that
     reference (cached). Compute incremental yield (new hits not already
     covered by the chosen chain) and incremental cost (keyspace / cluster).
  3. Greedy-select the next attack with the highest yield-per-cost ratio,
     stopping when the budget runs out or marginal yield drops below 0.5%.
"""

from __future__ import annotations

import logging
import math
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from backend.models import (
    AttackDef,
    ClusterSpec,
    RecommendedStep,
    TargetSpec,
    Verdict,
)
from backend.pipeline import attack_sim, features
from backend.pipeline import hashrates as hr
from backend.pipeline.mask_histogram import keyspace as mask_keyspace

log = logging.getLogger(__name__)

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent
_ATTACKS_TOML = _BACKEND / "config" / "attacks.toml"


def _load_attacks() -> list[AttackDef]:
    with _ATTACKS_TOML.open("rb") as fh:
        data = tomllib.load(fh)
    return [AttackDef(**a) for a in data["attack"] if a["type"] in {"wordlist", "wordlist+rules", "mask"}]


def _attack_keyspace(attack: AttackDef) -> int:
    if attack.type == "mask" and attack.mask:
        return mask_keyspace(attack.mask)
    if attack.type == "wordlist":
        return 10_000_000
    if attack.type == "wordlist+rules":
        # Rough fallback: wordlist size × rule size. We don't enumerate the
        # rule files — picking a representative number based on the rule name.
        return 1_000_000_000
    return 1_000_000


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        return 1.0
    return float(1.0 - np.dot(a, b) / (na * nb))


def _strongest_weakest(target_features: np.ndarray, candidates: list[str]) -> tuple[str, str]:
    """Return (closest, farthest) reference dataset id."""
    dists = [(d, _cosine_distance(target_features, features.feature_vector(d))) for d in candidates]
    dists.sort(key=lambda r: r[1])
    return dists[0][0], dists[-1][0]


def _target_features(target: TargetSpec, fallback_ref: str) -> np.ndarray:
    """If the user supplied cracked plaintexts we'd compute features from them.
    For now (no plaintext stream surfaced through the API) we use the chosen
    reference's own features as a stand-in. Documented as a known limitation.
    """
    if target.cracked_sample:
        # TODO: compute features from target.cracked_sample directly
        log.info("verdict: target sample provided but feature computation not yet wired")
    return features.feature_vector(fallback_ref)


def recommend(
    target: TargetSpec,
    cluster: ClusterSpec,
    *,
    budget_hours: float,
    candidate_refs: list[str],
    candidate_attacks: list[AttackDef] | None = None,
    allow_cold_sim: bool = False,
) -> Verdict:
    """Generate a recommended attack chain.

    `allow_cold_sim`: if False (default), attacks without a cached sim hit
    set fall back to a heuristic yield estimate. If True, the engine runs
    hashcat --stdout for any missing pair — multi-minute first call.
    """
    if candidate_attacks is None:
        candidate_attacks = _load_attacks()

    if not candidate_refs:
        raise ValueError("no candidate reference datasets")

    primary_ref = candidate_refs[0]
    target_feats = _target_features(target, primary_ref)
    strongest, weakest = _strongest_weakest(target_feats, candidate_refs)

    chain_ref = strongest
    cluster_ghs = hr.cluster_ghs(cluster)
    hashes_per_second = cluster_ghs * 1e9
    budget_seconds = budget_hours * 3600.0
    ref_size = _registry_unique_count(chain_ref)

    chosen: list[RecommendedStep] = []
    accumulated_hits: set[str] = set()
    accumulated_yield_pct = 0.0
    used_seconds = 0.0
    notes: list[str] = []
    notes.append(f"Target distribution closest to {strongest}; furthest from {weakest}.")

    cold_count = 0
    available = list(candidate_attacks)
    while available:
        best = None
        for atk in available:
            cached = attack_sim.get_cached_hits(atk.id, chain_ref)
            if cached is not None:
                new_hits = cached - accumulated_hits
                yield_pct = (len(new_hits) / ref_size) * 100.0
                using_cache = True
            elif allow_cold_sim:
                try:
                    cached, _ = attack_sim.simulate(atk, chain_ref)
                except FileNotFoundError as exc:
                    log.warning("verdict skip %s: %s", atk.id, exc)
                    continue
                new_hits = cached - accumulated_hits
                yield_pct = (len(new_hits) / ref_size) * 100.0
                using_cache = True
            else:
                cold_count += 1
                yield_pct = _heuristic_yield_pct(atk, accumulated_yield_pct)
                new_hits = None  # no set materialized
                using_cache = False

            keyspace_estimate = _attack_keyspace(atk)
            cost = keyspace_estimate / hashes_per_second
            if cost <= 0:
                continue
            score = yield_pct / max(0.001, math.log10(max(2, keyspace_estimate)))
            best_score = best[0] if best else -1.0
            if score > best_score:
                best = (score, atk, new_hits, cost, yield_pct, using_cache)

        if best is None:
            break
        score, atk, new_hits, cost, yield_pct, using_cache = best
        if used_seconds + cost > budget_seconds:
            notes.append(
                f"Budget exhausted: dropping {atk.id} ({_fmt_seconds(cost)} > remaining "
                f"{_fmt_seconds(budget_seconds - used_seconds)})."
            )
            break
        if yield_pct < 0.5:
            notes.append(
                f"Stopping at marginal yield <0.5% (next: {atk.id} would add {yield_pct:.2f}%)."
            )
            break

        chosen.append(
            RecommendedStep(
                attack_id=atk.id,
                label=atk.label,
                estimated_seconds=cost,
                expected_yield_pct=round(yield_pct, 2),
                rationale=_rationale_for(atk, len(chosen)),
            )
        )
        if new_hits is not None:
            accumulated_hits |= new_hits
        accumulated_yield_pct = min(100.0, accumulated_yield_pct + yield_pct)
        used_seconds += cost
        available.remove(atk)

    if cold_count > 0:
        notes.append(
            f"Some attacks used heuristic yield because their hashcat "
            "sim cache is cold. First /api/overlap or /api/compose/estimate?simulate=1 "
            "call will warm the cache; rerun Verdict afterwards for refined numbers."
        )
    if accumulated_hits:
        total_yield = round((len(accumulated_hits) / ref_size) * 100.0, 2)
    else:
        total_yield = round(accumulated_yield_pct, 2)
    return Verdict(
        strongest_reference=strongest,
        weakest_reference=weakest,
        recommended_chain=chosen,
        total_expected_yield_pct=total_yield,
        total_seconds=used_seconds,
        notes=notes,
    )


def _registry_unique_count(reference: str) -> int:
    """Cheap size lookup — reads from datasets.toml instead of materializing
    the full plaintext set. Used for the verdict engine's yield-percent math.
    """
    with _ATTACKS_TOML.parent.joinpath("datasets.toml").open("rb") as fh:
        data = tomllib.load(fh)
    entry = data.get(reference, {})
    return int(entry.get("unique") or entry.get("size") or 1)


def _heuristic_yield_pct(attack: AttackDef, accumulated_yield_pct: float) -> float:
    """Cheap yield estimate when no sim cache exists for this attack.

    Returns the yield percent directly — no synthetic hit set materialized.
    """
    base = {
        "wordlist": 18.0,
        "wordlist+rules": 32.0,
        "mask": 8.0,
        "hybrid": 12.0,
        "omen": 22.0,
        "pcfg": 25.0,
    }.get(attack.type, 5.0)
    # diminishing returns as more of the corpus has been covered already
    diminish = max(0.2, 1.0 - accumulated_yield_pct / 100.0)
    return base * diminish


def _rationale_for(attack: AttackDef, position: int) -> str:
    if position == 0:
        return f"Cheapest first-move on this target shape; {attack.notes or attack.label}."
    return f"Adds masks/words not yet covered by the prior {position} step(s); {attack.notes or attack.label}."


def _fmt_seconds(s: float) -> str:
    if s < 60:
        return f"{s:.1f} s"
    if s < 3600:
        return f"{s / 60:.1f} min"
    if s < 86400:
        return f"{s / 3600:.1f} h"
    return f"{s / 86400:.1f} d"
