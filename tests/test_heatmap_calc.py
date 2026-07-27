"""Tests for the per-position character-frequency heatmap.

Behavioural: each row sums to (at most) 100% — sum is < 100 when some
characters at that position are outside the tracked alphabet.
"""

from __future__ import annotations

import pytest

from backend.pipeline import heatmap_calc


def test_english_reference_shape():
    grid = heatmap_calc.english_reference()
    assert grid.dataset == "english_ref"
    assert grid.positions == 8
    assert len(grid.alphabet) > 0
    assert len(grid.frequencies) == grid.positions
    for row in grid.frequencies:
        assert len(row) == len(grid.alphabet)
        # English ref is hand-coded; per-position sum should be <= 100.
        assert sum(row) <= 100.5


def test_profile_returns_string_for_known_dataset():
    p = heatmap_calc.profile_for("rockyou")
    assert isinstance(p, str)
    assert len(p) > 10


def test_profile_returns_fallback_for_unknown_dataset():
    p = heatmap_calc.profile_for("nonexistent_corpus")
    assert isinstance(p, str)


def test_compute_raises_when_corpus_missing():
    with pytest.raises(FileNotFoundError):
        heatmap_calc.compute("definitely_not_a_real_corpus_name")
