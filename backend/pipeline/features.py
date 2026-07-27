"""Per-dataset feature vectors for similarity comparison (Scene 5 input).

Stacks: top-N mask histogram + length distribution + character-class
distribution into a single 1-D feature vector. Cached.
"""

from __future__ import annotations

import gzip
import json
import logging
from pathlib import Path

import numpy as np

from backend.pipeline.mask_histogram import classify, iter_passwords

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_CLEAN = _REPO / "data" / "clean"
_CACHE = _REPO / "data" / "cache" / "features"
_CACHE.mkdir(parents=True, exist_ok=True)

# Stable mask-vocabulary: the 30 masks Van Heijningen Table O.1 uses,
# plus a fixed set of additional common shapes. Keeps feature dimensions
# stable across datasets so PCA/UMAP receives a homogeneous matrix.
_MASK_VOCAB = [
    "?l?l?l?l", "?d?d?d?d?d?d", "?d?d?d?d?d?d?d", "?l?l?l?l?l", "?l?l?l?d?d?d",
    "?l?l?l?l?d?d", "?d?d?d?d?d?d?d?d", "?l?l?l?l?l?d", "?l?l?l?d?d?d?d",
    "?l?l?l?l?l?l", "?l?l?l?l?l?d?d", "?l?l?l?l?l?l?d", "?l?l?l?l?d?d?d?d",
    "?l?l?l?l?l?l?l", "?l?l?l?l?l?d?d?d", "?l?l?l?l?l?l?d?d",
    "?l?l?l?l?l?l?l?d", "?l?l?l?l?l?d?d?d?d", "?l?l?l?l?l?l?l?l",
    "?l?l?l?l?l?l?d?d?d", "?l?l?l?l?l?l?l?d?d", "?l?l?l?l?l?l?l?l?d",
    "?l?l?l?l?l?l?d?d?d?d", "?l?l?l?l?l?l?l?l?l", "?l?l?l?l?l?l?l?l?d?d",
    "?l?l?l?l?l?l?l?l?l?l", "?u?l?l?l?l?d?d", "?d?d?d?d?d?d?d?d?d?d",
    "?d?d?d?d?d?d?d?d?d", "?l?l?l?l?l?l?l?l?l?l?l",
]
_LENGTHS = list(range(4, 17))  # 4..16 inclusive
_CHAR_CLASSES = ["lower", "upper", "digit", "special"]

DIM = len(_MASK_VOCAB) + len(_LENGTHS) + len(_CHAR_CLASSES)


def feature_vector(dataset: str) -> np.ndarray:
    cache_p = _CACHE / f"{dataset}.npy"
    src = _CLEAN / f"{dataset}.txt.gz"
    if cache_p.exists() and src.exists() and cache_p.stat().st_mtime >= src.stat().st_mtime:
        return np.load(cache_p)
    if not src.exists():
        raise FileNotFoundError(f"cleaned corpus missing: {src}")

    log.info("computing feature vector for %s", dataset)
    mask_idx = {m: i for i, m in enumerate(_MASK_VOCAB)}
    mask_counts = np.zeros(len(_MASK_VOCAB))
    length_counts = np.zeros(len(_LENGTHS))
    class_counts = np.zeros(len(_CHAR_CLASSES))
    total = 0

    for pwd in iter_passwords(src):
        m = classify(pwd)
        if m is None:
            continue
        total += 1
        if m in mask_idx:
            mask_counts[mask_idx[m]] += 1
        L = len(pwd)
        if L in _LENGTHS:
            length_counts[_LENGTHS.index(L)] += 1
        for ch in pwd:
            if ch.islower():
                class_counts[0] += 1
            elif ch.isupper():
                class_counts[1] += 1
            elif ch.isdigit():
                class_counts[2] += 1
            else:
                class_counts[3] += 1

    if total == 0:
        return np.zeros(DIM)

    mask_freq = mask_counts / total
    length_freq = length_counts / total
    chars_total = class_counts.sum() or 1
    class_freq = class_counts / chars_total

    vec = np.concatenate([mask_freq, length_freq, class_freq]).astype(np.float32)
    np.save(cache_p, vec)
    log.info("feature vector for %s: dim=%d, top mask=%s",
             dataset, vec.shape[0], _MASK_VOCAB[int(mask_freq.argmax())])
    return vec
