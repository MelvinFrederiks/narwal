"""GET /api/datasets — lists reference corpora from backend/config/datasets.toml,
flags which are already cleaned and cached.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from fastapi import APIRouter

from backend.models import DatasetList, DatasetSummary

router = APIRouter()

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent
_REGISTRY_PATH = _BACKEND / "config" / "datasets.toml"
_CLEAN_DIR = _REPO / "data" / "clean"


def _load_registry() -> dict:
    with _REGISTRY_PATH.open("rb") as fh:
        return tomllib.load(fh)


@router.get("/api/datasets", response_model=DatasetList)
def list_datasets() -> DatasetList:
    out: list[DatasetSummary] = []
    for ds_id, entry in _load_registry().items():
        label = entry.get("id_label", ds_id)
        cleaned = (_CLEAN_DIR / f"{ds_id}.txt.gz").exists()
        out.append(
            DatasetSummary(
                id=ds_id,
                label=label,
                size=int(entry["size"]),
                unique=int(entry["unique"]) if "unique" in entry else None,
                year=int(entry["year"]),
                origin=str(entry["origin"]),
                language=str(entry["language"]),
                service=str(entry["service"]),
                policy=str(entry["policy"]),
                cleaned=cleaned,
            )
        )
    return DatasetList(datasets=out)
