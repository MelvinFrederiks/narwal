"""Scene 4 — Jaccard overlap viewer.

GET /api/overlap?attacks=a,b,c&reference=rockyou&mode=approx
  · mode=approx (default) — PACK mask-histogram approximation; values
    are pre-warmed at server startup so every cell answers in <50 ms.
  · mode=real — exact via attack_sim.simulate (hashcat --stdout +
    set-intersect). Slow on first hit per (attack, reference) pair,
    cached afterwards. Use to upgrade a specific cell when needed.

See wiki/methodology.md "Attack overlap (Jaccard)" and
backend/pipeline/mask_overlap.py for the approximation derivation.
"""

from __future__ import annotations

import hashlib
import json
import logging
import tomllib
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from backend.models import AttackDef, JaccardCell, OverlapMatrix
from backend.pipeline import attack_sim, mask_overlap

router = APIRouter()
log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_ATTACKS_TOML = Path(__file__).resolve().parents[1] / "config" / "attacks.toml"
_CACHE_DIR = _REPO / "data" / "cache" / "overlap"
_SIM_CACHE = _REPO / "data" / "cache" / "sim"
_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _load_attacks() -> dict[str, AttackDef]:
    with _ATTACKS_TOML.open("rb") as fh:
        data = tomllib.load(fh)
    return {a["id"]: AttackDef(**a) for a in data["attack"]}


def _cache_path(reference: str, mode: str, attack_ids: list[str]) -> Path:
    key = hashlib.sha1(",".join(sorted(attack_ids)).encode()).hexdigest()[:12]
    return _CACHE_DIR / f"{reference}__{mode}__{key}.json"


def _cache_valid(path: Path, attack_ids: list[str], reference: str, mode: str) -> bool:
    """Cache is valid if it exists and no underlying sim cache is newer than it."""
    if not path.exists():
        return False
    cache_mtime = path.stat().st_mtime
    if mode == "real":
        for aid in attack_ids:
            pkl = _SIM_CACHE / f"{aid}__{reference}.pkl"
            if pkl.exists() and pkl.stat().st_mtime > cache_mtime:
                return False
    return True


@router.get("/api/overlap", response_model=OverlapMatrix)
def get_overlap(
    attacks: str = Query(
        "rockyou_best64,rockyou_d3ad0ne,hibp_best64,mask_l8_d2,mask_d6,mask_u_l4_d2"
    ),
    reference: str = Query("rockyou"),
    mode: Literal["approx", "real"] = Query("real"),
) -> OverlapMatrix:
    library = _load_attacks()
    requested = [a.strip() for a in attacks.split(",") if a.strip()]
    missing = [a for a in requested if a not in library]
    if missing:
        raise HTTPException(404, f"unknown attacks: {missing}")

    requested_defs = [library[aid] for aid in requested]

    cache_path = _cache_path(reference, mode, requested)
    if _cache_valid(cache_path, requested, reference, mode):
        with cache_path.open() as fh:
            return OverlapMatrix(**json.load(fh))

    if mode == "approx":
        try:
            result = mask_overlap.estimate_overlap(requested_defs, reference)
        except FileNotFoundError as exc:
            raise HTTPException(
                409, f"reference {reference!r} not cleaned: {exc}"
            ) from exc
        tmp = cache_path.with_suffix(".json.tmp")
        with tmp.open("w") as fh:
            json.dump(result.model_dump(), fh)
        tmp.replace(cache_path)
        return result

    # mode == "real" — exact set intersection. Slow on cache miss.
    sets: dict[str, frozenset[str]] = {}
    for atk in requested_defs:
        if atk.type not in {"wordlist", "wordlist+rules", "mask"}:
            log.info("overlap: skip %s (type=%s not simulatable)", atk.id, atk.type)
            continue
        try:
            hits, _ = attack_sim.simulate(atk, reference)
        except FileNotFoundError as exc:
            raise HTTPException(
                409, f"reference {reference!r} not cleaned: {exc}"
            ) from exc
        sets[atk.id] = hits

    cells: list[JaccardCell] = []
    keys = list(sets.keys())
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            sa, sb = sets[a], sets[b]
            inter = len(sa & sb)
            union = len(sa | sb)
            jacc = (inter / union) if union else 0.0
            verdict = (
                "redundant"
                if jacc >= 0.6
                else ("complementary" if jacc < 0.3 else "judgment")
            )
            max_single = max(len(sa), len(sb)) or 1
            marginal_gain = (
                ((union - max_single) / max_single) * 100.0
                if union > max_single
                else 0.0
            )
            cells.append(
                JaccardCell(
                    a=a,
                    b=b,
                    jaccard=round(jacc, 4),
                    verdict=verdict,
                    marginal_gain_pct=round(marginal_gain, 2),
                    only_a=len(sa - sb),
                    only_b=len(sb - sa),
                    intersect=inter,
                    union=union,
                )
            )

    result = OverlapMatrix(
        reference=reference,
        attacks=keys,
        cells=cells,
        set_sizes={k: len(v) for k, v in sets.items()},
    )
    tmp = cache_path.with_suffix(".json.tmp")
    with tmp.open("w") as fh:
        json.dump(result.model_dump(), fh)
    tmp.replace(cache_path)
    return result
