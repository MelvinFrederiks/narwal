"""Throughput numbers loaded from backend/config/hashrates.toml.

Nothing else in the codebase hardcodes a hashrate — everything routes here.
"""

from __future__ import annotations

import tomllib
from functools import cache
from pathlib import Path

from backend.models import ClusterSpec, HashType

_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "hashrates.toml"


@cache
def _load() -> dict:
    with _CONFIG_PATH.open("rb") as fh:
        return tomllib.load(fh)


def per_card_ghs(hash_type: HashType) -> float:
    return float(_load()[hash_type]["per_card_ghs"])


def hashcat_mode(hash_type: HashType) -> int:
    return int(_load()[hash_type]["hashcat_mode"])


def cluster_ghs(spec: ClusterSpec) -> float:
    if spec.hashrate_ghs_override is not None:
        return spec.hashrate_ghs_override
    return per_card_ghs(spec.hash_type) * spec.gpu_count
