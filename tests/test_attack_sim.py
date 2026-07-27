"""Tests for the attack simulator.

These don't actually run hashcat — they test the cache + Jaccard math
against pre-seeded fixture hit sets. The real hashcat path is covered by
the integration tests once a warmup pass has populated the cache.
"""

from __future__ import annotations

import pickle
from pathlib import Path

import pytest

from backend.pipeline import attack_sim


@pytest.fixture
def seeded_cache(tmp_path, monkeypatch):
    """Redirect the sim cache to a tmpdir and pre-populate it with two
    overlapping hit sets so jaccard math has something to chew on."""
    cache = tmp_path / "sim"
    cache.mkdir()
    monkeypatch.setattr(attack_sim, "_CACHE", cache)

    a = frozenset(["alice", "bob", "carol", "dave"])
    b = frozenset(["bob", "carol", "eve", "frank"])
    for aid, hits in [("atk_a", a), ("atk_b", b)]:
        with (cache / f"{aid}__rockyou.pkl").open("wb") as fh:
            pickle.dump(hits, fh)
    return cache, a, b


def test_get_cached_hits_returns_stored_set(seeded_cache, monkeypatch):
    cache, a, _ = seeded_cache
    # Patch _CLEAN to a non-existent path so freshness check passes by absence.
    monkeypatch.setattr(attack_sim, "_CLEAN", Path("/nonexistent"))
    got = attack_sim.get_cached_hits("atk_a", "rockyou")
    assert got == a


def test_get_cached_hits_returns_none_when_missing(seeded_cache, monkeypatch):
    monkeypatch.setattr(attack_sim, "_CLEAN", Path("/nonexistent"))
    assert attack_sim.get_cached_hits("never_run", "rockyou") is None


def test_jaccard_basic():
    a = frozenset(["alice", "bob", "carol", "dave"])
    b = frozenset(["bob", "carol", "eve", "frank"])
    # |a∩b| = 2, |a∪b| = 6, J = 1/3
    assert attack_sim.jaccard(a, b) == pytest.approx(1 / 3, abs=1e-6)


def test_jaccard_identical_sets_equals_one():
    a = frozenset(["x", "y", "z"])
    assert attack_sim.jaccard(a, a) == 1.0


def test_jaccard_disjoint_equals_zero():
    a = frozenset(["x"])
    b = frozenset(["y"])
    assert attack_sim.jaccard(a, b) == 0.0


def test_jaccard_empty_sets():
    assert attack_sim.jaccard(frozenset(), frozenset()) == 0.0
