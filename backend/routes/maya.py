"""GET /api/maya/curves — published crack-rate curves from MAYA's rq1.csv.

Returns per (model, training_dataset) the (n_samples, crack_pct) points
MAYA reports in their paper. Used by the Verdict scene to surface DL-
based models (FLA, PassGAN, PassGPT, PassFlow, PLRGAN, VGPT2) against
the same 8 reference corpora — without local training.

Caveat: these are MAYA's `all-8-100-80` test setup (chars ≤ 8, 80%
train/test split). Not directly comparable to crack rates against an
arbitrary user-supplied target. If the user wants FLA against THEIR
target hashlist, they need a locally-trained model (see fla.md).
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from backend.pipeline import maya_mergeability, maya_results
from backend.models import StrictModel

router = APIRouter()


class CurvePoint(StrictModel):
    n_samples: int
    crack_pct: float


class ModelCurves(StrictModel):
    model: str
    training_dataset: str
    points: list[CurvePoint]


class CurveList(StrictModel):
    available: bool
    models: list[str]
    curves: list[ModelCurves]


@router.get("/api/maya/curves", response_model=CurveList)
def get_curves(
    model: str | None = Query(None, description="Filter to one model (e.g. 'fla')."),
    training_dataset: str | None = Query(None, description="Filter to one training corpus."),
) -> CurveList:
    if not maya_results.is_available():
        return CurveList(available=False, models=[], curves=[])

    models = maya_results.models()
    curves: list[ModelCurves] = []
    for m in models:
        if model and m != model:
            continue
        for td in maya_results.training_datasets(m):
            if training_dataset and td != training_dataset:
                continue
            pts = maya_results.curve(m, td)
            curves.append(ModelCurves(
                model=m,
                training_dataset=td,
                points=[CurvePoint(n_samples=n, crack_pct=p) for n, p in pts],
            ))
    return CurveList(available=True, models=models, curves=curves)


# ── RQ6.1 mergeability index ────────────────────────────────────────────────

class MergePair(StrictModel):
    combo: str
    model_a: str
    model_b: str
    train_dataset: str
    test_settings: str
    n_samples: int
    mergeability_index: float


class MergeabilityList(StrictModel):
    available: bool
    models: list[str]
    datasets: list[str]
    pairs: list[MergePair]


@router.get("/api/maya/mergeability", response_model=MergeabilityList)
def get_mergeability(
    training_dataset: str | None = Query(None, description="Filter to one training corpus."),
    model: str | None = Query(None, description="Filter to pairs involving this model (e.g. 'fla')."),
) -> MergeabilityList:
    """MAYA RQ6.1 mergeability index: how complementary two guessing models are.

    ``(|A ∪ B| − max(|A|,|B|)) / max(|A|,|B|)`` over each model's cracked-password
    set — the fractional coverage gain from merging the weaker model into the
    stronger. 0 ⇒ redundant; higher ⇒ combining is worthwhile.
    """
    if not maya_mergeability.is_available():
        return MergeabilityList(available=False, models=[], datasets=[], pairs=[])

    pairs: list[MergePair] = []
    for p in maya_mergeability.pairs(dataset=training_dataset):
        if model and model not in (p.model_a, p.model_b):
            continue
        pairs.append(MergePair(
            combo=p.combo,
            model_a=p.model_a,
            model_b=p.model_b,
            train_dataset=p.train_dataset,
            test_settings=p.test_settings,
            n_samples=p.n_samples,
            mergeability_index=p.mergeability_index,
        ))
    return MergeabilityList(
        available=True,
        models=maya_mergeability.models(),
        datasets=maya_mergeability.datasets(),
        pairs=pairs,
    )
