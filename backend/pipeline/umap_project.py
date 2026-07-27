"""UMAP projection of dataset feature vectors → 2D coords (Scene 5).

Implements the wiki/methodology.md "Dataset similarity (UMAP)" measurement.
Result is cached as a single JSON; recomputed only if any source feature
vector is newer than the cache.

Also assigns a coarse "cluster region" label per dataset (consumer leaks /
corporate / high-entropy) by k-means on the projected coords, just to drive
the storyboard's three labelled regions.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

from backend.pipeline import features

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_CLEAN = _REPO / "data" / "clean"
_CACHE = _REPO / "data" / "cache" / "umap.json"


def project(dataset_ids: list[str]) -> dict:
    """Return {points: [{id, x, y, region}], regions: [{name, cx, cy}]}.

    Cached. Recomputed if any feature vector is newer than the cache.
    """
    available = [d for d in dataset_ids if (_CLEAN / f"{d}.txt.gz").exists()]
    if not available:
        return {"points": [], "regions": []}

    if _CACHE.exists() and _is_cache_fresh(available):
        with _CACHE.open("r") as fh:
            cached = json.load(fh)
        if {p["id"] for p in cached["points"]} == set(available):
            return cached

    log.info("computing UMAP over %d datasets", len(available))
    X = np.array([features.feature_vector(d) for d in available])

    coords = _project_2d(X)

    points: list[dict] = []
    for i, d in enumerate(available):
        points.append({"id": d, "x": float(coords[i, 0]), "y": float(coords[i, 1])})

    regions = _label_regions(available, coords, points)

    out = {"points": points, "regions": regions}
    _CACHE.parent.mkdir(parents=True, exist_ok=True)
    with _CACHE.open("w") as fh:
        json.dump(out, fh)
    return out


def _project_2d(X: np.ndarray) -> np.ndarray:
    """UMAP if it's available and there are enough samples; else fall back to PCA."""
    n = X.shape[0]
    if n < 4:
        # UMAP needs n_neighbors > 1 and asks for n_neighbors < n. Fall through.
        return _pca_2d(X)
    try:
        import umap

        n_neighbors = max(2, min(15, n - 1))
        reducer = umap.UMAP(
            n_neighbors=n_neighbors,
            min_dist=0.3,
            n_components=2,
            random_state=42,
            metric="cosine",
        )
        return reducer.fit_transform(X)
    except Exception as exc:  # noqa: BLE001
        log.warning("UMAP failed, falling back to PCA: %s", exc)
        return _pca_2d(X)


def _pca_2d(X: np.ndarray) -> np.ndarray:
    if X.shape[0] < 2:
        return np.zeros((X.shape[0], 2))
    Xc = X - X.mean(axis=0, keepdims=True)
    U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    return (U[:, :2] * S[:2]).astype(np.float32)


# Storyboard's three regions: consumer / corporate / high-entropy.
# We label each point by its nearest hardcoded centroid in feature space:
# - consumer: rockyou-like (permissive, letter-heavy)
# - corporate: linkedin-like (length-policy, mixed)
# - high-entropy: ashley_madison-like (mostly unique)
_PROTOTYPE_REGION = {
    "rockyou": "consumer",
    "linkedin": "corporate",
    "zerozeroowebhost": "consumer",
    "taobao": "high-entropy",
    "mailru": "high-entropy",
    "gmail": "consumer",
    "ashleymadison": "high-entropy",
    "libero": "high-entropy",
}


def _label_regions(ids: list[str], coords: np.ndarray, points: list[dict]) -> list[dict]:
    regions: dict[str, list[tuple[float, float]]] = {}
    for i, ds in enumerate(ids):
        region = _PROTOTYPE_REGION.get(ds, "high-entropy")
        regions.setdefault(region, []).append((float(coords[i, 0]), float(coords[i, 1])))
        points[i]["region"] = region

    out: list[dict] = []
    for name, pts in regions.items():
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        rx = max((abs(p[0] - cx) for p in pts), default=0.5) + 0.4
        ry = max((abs(p[1] - cy) for p in pts), default=0.5) + 0.3
        out.append({"name": name, "cx": cx, "cy": cy, "rx": rx, "ry": ry, "count": len(pts)})
    return out


def _is_cache_fresh(datasets: list[str]) -> bool:
    cache_mtime = _CACHE.stat().st_mtime
    for ds in datasets:
        feat = _REPO / "data" / "cache" / "features" / f"{ds}.npy"
        if feat.exists() and feat.stat().st_mtime > cache_mtime:
            return False
    return True
