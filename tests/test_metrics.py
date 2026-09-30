"""The mergeability and Jaccard indices, on sets small enough to check by hand."""

from __future__ import annotations

import pytest

from backend.jobs import metrics


def s(*items) -> set:
    return set(items)


# ── mergeability ────────────────────────────────────────────────────────────

def test_identical_attacks_merge_to_nothing():
    """The defining case: B finds exactly what A found, so merging adds 0."""
    a = s("a", "b", "c")
    assert metrics.mergeability(a, set(a)) == 0.0


def test_disjoint_equal_sets_merge_to_one():
    """The other end of the scale: B doubles the yield."""
    assert metrics.mergeability(s("a", "b"), s("c", "d")) == 1.0


def test_partial_overlap():
    # A={a,b,c} B={c,d,e}: union={a,b,c,d,e}=5, best=3  ->  (5-3)/3
    assert metrics.mergeability(s("a", "b", "c"), s("c", "d", "e")) == pytest.approx(2 / 3)


def test_subset_adds_nothing():
    """B ⊂ A: everything B found, A already had."""
    assert metrics.mergeability(s("a", "b", "c"), s("a", "b")) == 0.0


def test_normalised_by_the_better_attack_not_the_worse():
    """A finds 10, B finds 1 that A missed. The gain is measured against 10,
    so it stays small — this is what separates mergeability from Jaccard."""
    a = s(*range(10))
    b = s("new")
    assert metrics.mergeability(a, b) == pytest.approx(0.1)


def test_symmetric_in_value():
    a, b = s("a", "b", "c"), s("c", "d")
    assert metrics.mergeability(a, b) == metrics.mergeability(b, a)


def test_both_empty_is_zero_not_a_crash():
    assert metrics.mergeability(set(), set()) == 0.0


def test_one_empty():
    """A found nothing, B found 4 — merging is a total win over the best
    single attack, which was B itself. Gain over B is 0."""
    assert metrics.mergeability(set(), s(1, 2, 3, 4)) == 0.0


# ── jaccard ─────────────────────────────────────────────────────────────────

def test_jaccard_basics():
    assert metrics.jaccard(s("a", "b"), s("a", "b")) == 1.0
    assert metrics.jaccard(s("a"), s("b")) == 0.0
    assert metrics.jaccard(s("a", "b", "c"), s("c", "d", "e")) == pytest.approx(1 / 5)


def test_jaccard_of_two_empty_sets_is_zero():
    """Defined as 0 rather than 1: two attacks that found nothing are not
    'perfectly similar', they are unmeasured."""
    assert metrics.jaccard(set(), set()) == 0.0


# ── summarise ───────────────────────────────────────────────────────────────

def test_summarise_shapes_and_coverage():
    recovered = {
        "dict": s("a", "b", "c", "d"),
        "mask": s("c", "d", "e"),
        "hybrid": s("z"),
    }
    out = metrics.summarise(recovered, goal_size=10)

    assert out["goal_size"] == 10
    assert {a["label"] for a in out["attacks"]} == {"dict", "mask", "hybrid"}
    assert next(a for a in out["attacks"] if a["label"] == "dict")["coverage"] == 0.4

    # union of all three = a,b,c,d,e,z
    assert out["combined_recovered"] == 6
    assert out["combined_coverage"] == 0.6

    # 3 attacks -> 3 pairs, sorted most-complementary first
    assert len(out["pairs"]) == 3
    mergeabilities = [p["mergeability"] for p in out["pairs"]]
    assert mergeabilities == sorted(mergeabilities, reverse=True)


def test_pair_regions_are_internally_consistent():
    """only_a + shared == recovered_a, and likewise for b. The Venn in the UI
    relies on this."""
    out = metrics.summarise({"a": s(1, 2, 3), "b": s(3, 4)}, goal_size=10)
    p = out["pairs"][0]
    assert p["only_a"] + p["shared"] == p["recovered_a"]
    assert p["only_b"] + p["shared"] == p["recovered_b"]
    assert p["union"] == p["only_a"] + p["shared"] + p["only_b"]


def test_summarise_with_zero_goal_size_does_not_divide_by_zero():
    out = metrics.summarise({"a": set(), "b": set()}, goal_size=0)
    assert out["combined_coverage"] == 0.0
    assert out["attacks"][0]["coverage"] == 0.0
