"""Integration: GET /api/coverage end-to-end against the FastAPI app.

Uses a temporary cleaned corpus seeded with Table O.1's mask shape so the
test runs without a real RockYou dump in data/clean/.
"""

from __future__ import annotations

import csv
import gzip
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.models import CoverageResponse

_REPO = Path(__file__).resolve().parents[1]
_FIXTURE_CSV = _REPO / "data" / "fixtures" / "table_o1.csv"
_CLEAN_DIR = _REPO / "data" / "clean"


@pytest.fixture
def synthetic_rockyou(tmp_path_factory):
    """Seed data/clean/rockyou.txt.gz with a small synthetic corpus that
    matches Table O.1's per-mask coverage. Restores prior state on teardown.
    """
    target = _CLEAN_DIR / "rockyou.txt.gz"
    backup = target.with_suffix(".gz.bak") if target.exists() else None
    if backup is not None:
        target.rename(backup)

    _CLEAN_DIR.mkdir(parents=True, exist_ok=True)
    with _FIXTURE_CSV.open() as fh:
        rows = list(csv.DictReader(fh))

    samples = {
        "?l": "a",
        "?u": "A",
        "?d": "1",
        "?s": "!",
    }

    def example(mask: str) -> str:
        return "".join(samples[mask[i : i + 2]] for i in range(0, len(mask), 2))

    with gzip.open(target, "wb") as gz:
        for row in rows:
            n = max(1, round(float(row["percentage"]) * 100))
            line = (example(row["mask"]) + "\n").encode()
            for _ in range(n):
                gz.write(line)

    yield target

    target.unlink(missing_ok=True)
    if backup is not None:
        backup.rename(target)


def test_coverage_endpoint_returns_valid_schema(synthetic_rockyou):
    client = TestClient(app)
    resp = client.get("/api/coverage", params={"dataset": "rockyou", "top_n": 30})
    assert resp.status_code == 200, resp.text
    parsed = CoverageResponse.model_validate(resp.json())
    assert parsed.dataset == "rockyou"
    assert parsed.cluster_hashrate_ghs == 840.0  # 8 × 105 GH/s NTLM
    assert len(parsed.masks) > 0
    for row in parsed.masks:
        assert row.coverage_pct >= 0
        assert row.cumulative_pct >= row.coverage_pct
        assert row.cumulative_crack_time_seconds >= row.crack_time_seconds


def test_coverage_endpoint_404_for_unknown_dataset(synthetic_rockyou):
    client = TestClient(app)
    resp = client.get("/api/coverage", params={"dataset": "nonexistent_corpus"})
    assert resp.status_code == 404


def test_coverage_endpoint_409_when_dataset_not_cleaned():
    """If a registered dataset has no cleaned file, the endpoint returns 409
    with a clear message instead of crashing. We simulate this by moving the
    cleaned libero aside for the duration of the test (same filesystem so
    rename is atomic).
    """
    from backend.routes import coverage as coverage_route

    clean = coverage_route._CLEAN / "libero.txt.gz"
    if not clean.exists():
        resp = TestClient(app).get("/api/coverage", params={"dataset": "libero"})
        assert resp.status_code == 409
        assert "cleaned" in resp.text
        return

    stash = clean.with_suffix(".gz.test_stash")
    clean.rename(stash)
    try:
        resp = TestClient(app).get("/api/coverage", params={"dataset": "libero"})
        assert resp.status_code == 409
        assert "cleaned" in resp.text
    finally:
        stash.rename(clean)


def test_datasets_endpoint_lists_registry_entries():
    client = TestClient(app)
    resp = client.get("/api/datasets")
    assert resp.status_code == 200
    ids = {d["id"] for d in resp.json()["datasets"]}
    assert {"rockyou", "linkedin", "taobao", "hibp_top10m"}.issubset(ids)
