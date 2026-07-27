"""Scene 6 — verdict panel + attack recommendation (REAL).

POST /api/verdict — run the verdict_engine against the user's target spec
+ cluster + budget. Returns the recommended chain plus strongest/weakest
reference. Numbers come from cached attack simulations.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from fastapi import APIRouter

from backend.models import Verdict, VerdictRequest
from backend.pipeline import verdict_engine

router = APIRouter()

_REGISTRY = Path(__file__).resolve().parents[1] / "config" / "datasets.toml"


def _registry_ids() -> list[str]:
    with _REGISTRY.open("rb") as fh:
        return [k for k, v in tomllib.load(fh).items() if k != "hibp_top10m"]


@router.post("/api/verdict", response_model=Verdict)
def get_verdict(req: VerdictRequest) -> Verdict:
    refs = req.candidate_refs if req.candidate_refs else _registry_ids()
    return verdict_engine.recommend(
        target=req.target,
        cluster=req.cluster,
        budget_hours=req.budget_hours,
        candidate_refs=refs,
    )
