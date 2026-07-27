"""Scene 3b — per-position character-frequency heatmap (REAL).

GET /api/heatmap?dataset=<id>

Special dataset id `english_ref` returns Mayzner-revisited per-position
letter frequencies (a non-corpus reference for "how natural-language is
this corpus shaped?"). See heatmap_calc for the source numbers.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from backend.models import HeatmapGrid
from backend.pipeline import heatmap_calc

router = APIRouter()


@router.get("/api/heatmap", response_model=HeatmapGrid)
def get_heatmap(dataset: str = Query("rockyou")) -> HeatmapGrid:
    if dataset == "english_ref":
        grid = heatmap_calc.english_reference()
    else:
        try:
            grid = heatmap_calc.compute(dataset)
        except FileNotFoundError as exc:
            raise HTTPException(409, str(exc)) from exc

    # attach narrative profile
    return grid.model_copy(update={"profile": heatmap_calc.profile_for(dataset)})
