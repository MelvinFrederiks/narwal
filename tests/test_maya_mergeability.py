"""MAYA RQ6.1 mergeability index — loader unit test + endpoint integration.

The metric is ``(|A ∪ B| − max(|A|,|B|)) / max(|A|,|B|)`` over each model's
cracked-password set: the fractional coverage gain from merging the weaker
model into the stronger. Tests auto-skip if MAYA's results CSV is absent
(third_party/maya is gitignored, per fla.md).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.pipeline import maya_mergeability
from backend.pipeline.maya_mergeability import MergePair


def test_formula_matches_maya_definition():
    """Reproduce MAYA's _compute_mergeability by hand on two toy sets."""
    def merge(a: set, b: set) -> float:
        return (len(a | b) - max(len(a), len(b))) / max(len(a), len(b))

    # Weaker set fully contained in stronger → 0 (nothing gained by merging).
    assert merge({1, 2, 3}, {1, 2}) == 0.0
    # Fully disjoint, equal size → 1.0 (merging doubles coverage).
    assert merge({1, 2}, {3, 4}) == 1.0
    # Partial overlap: |A∪B|=4, max=3 → (4-3)/3.
    assert merge({1, 2, 3}, {3, 4}) == pytest.approx(1 / 3)


@pytest.mark.skipif(not maya_mergeability.is_available(), reason="MAYA rq6.1 CSV absent")
def test_loader_parses_pairs():
    pairs = maya_mergeability.pairs()
    assert pairs, "expected mergeability rows"
    assert all(isinstance(p, MergePair) for p in pairs)
    # combo derives from the two model ids.
    p = pairs[0]
    assert p.combo == f"{p.model_a}-{p.model_b}"
    assert p.model_a != p.model_b
    assert 0.0 <= p.mergeability_index <= 1.0
    # dataset filter is a strict subset.
    ds = maya_mergeability.datasets()[0]
    assert all(q.train_dataset == ds for q in maya_mergeability.pairs(dataset=ds))

    # MAYA's CSV appends duplicate re-runs; the loader must collapse them so
    # each (combo, dataset, test-settings, n_samples) key appears once.
    keys = [(q.combo, q.train_dataset, q.test_settings, q.n_samples) for q in pairs]
    assert len(keys) == len(set(keys)), "loader returned duplicate mergeability keys"


@pytest.mark.skipif(not maya_mergeability.is_available(), reason="MAYA rq6.1 CSV absent")
def test_endpoint_returns_valid_schema_and_filters():
    client = TestClient(app)
    resp = client.get("/api/maya/mergeability")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    assert body["pairs"]
    assert "fla" in body["models"]

    # model filter keeps only pairs involving that model.
    resp = client.get("/api/maya/mergeability", params={"model": "fla"})
    assert resp.status_code == 200
    fla_pairs = resp.json()["pairs"]
    assert fla_pairs
    assert all("fla" in (p["model_a"], p["model_b"]) for p in fla_pairs)


def test_endpoint_graceful_when_unavailable(monkeypatch):
    """With the CSV absent the endpoint reports available=False, not a 500."""
    monkeypatch.setattr(maya_mergeability, "is_available", lambda: False)
    resp = TestClient(app).get("/api/maya/mergeability")
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "models": [], "datasets": [], "pairs": []}
