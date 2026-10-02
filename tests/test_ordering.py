"""Exhaustive attack-ordering scoring, on sets small enough to check by hand.

The two things worth guarding are the ones that are easy to get subtly wrong:
the coverage-signature shortcut (union_table must agree with real set unions
for every subset, or every score is wrong in a way nothing else would catch),
and the direction of the score (front-loaded orderings must rank higher).
"""

from __future__ import annotations

from itertools import combinations, permutations

import pytest

from backend.jobs import ordering


def b(*items) -> set[bytes]:
    return {x.encode() for x in items}


# ── the signature/union shortcut ────────────────────────────────────────────

def test_union_table_agrees_with_real_set_unions_for_every_subset():
    """The whole feature rests on this equivalence."""
    recovered = {
        "a": b("p1", "p2", "p3", "p4"),
        "b": b("p3", "p4", "p5"),
        "c": b("p5", "p6"),
        "d": b("p1", "p7", "p8", "p9"),
    }
    labels = list(recovered)
    counts = ordering.signature_counts(recovered, labels)
    table, total = ordering.union_table(len(labels), counts)

    assert total == len(set().union(*recovered.values()))
    assert table[0] == 0

    for size in range(1, len(labels) + 1):
        for subset in combinations(range(len(labels)), size):
            mask = sum(1 << i for i in subset)
            expected = set().union(*(recovered[labels[i]] for i in subset))
            assert table[mask] == len(expected), (subset, table[mask], len(expected))


def test_signature_counts_bucket_by_which_attacks_find_a_password():
    recovered = {"a": b("x", "y"), "b": b("y", "z")}
    counts = ordering.signature_counts(recovered, ["a", "b"])
    assert counts == {0b01: 1, 0b11: 1, 0b10: 1}  # x only a, y both, z only b


def test_signature_counts_never_records_an_unfound_password():
    """Signature 0 would mean "recovered by nobody", which cannot be in the
    table — union_table's complement arithmetic relies on it."""
    counts = ordering.signature_counts({"a": b("x"), "b": b("y")}, ["a", "b"])
    assert 0 not in counts


# ── the score ───────────────────────────────────────────────────────────────

def test_cheap_productive_attack_goes_first():
    """`fast` finds 9 of the 10 in a second; `slow` grinds for 100s to add 1.
    Running `fast` first has to win."""
    recovered = {
        "fast": b(*[f"p{i}" for i in range(9)]),
        "slow": b("p9"),
    }
    r = ordering.summarise(recovered, {"fast": 1.0, "slow": 100.0}, goal_size=10)

    assert r["best"]["order"] == ["fast", "slow"]
    assert r["worst"]["order"] == ["slow", "fast"]
    assert r["best"]["efficiency"] > r["worst"]["efficiency"]
    assert r["permutations_scored"] == 2


def test_every_permutation_is_scored():
    recovered = {name: b(f"only-{name}") for name in "abcde"}
    r = ordering.summarise(recovered, {name: 1.0 for name in "abcde"}, goal_size=5)
    assert r["permutations_scored"] == 120  # 5!


def test_strictly_redundant_and_slow_attack_is_pushed_last():
    """`dup` is a subset of `big` *and* slower than everything per second, so
    there is no reading under which it should run early.

    Note the mirror case is not a bug: a subset attack that is much *cheaper*
    than the one containing it does belong early, because it buys most of that
    attack's haul for a fraction of the time. The ranking has to distinguish
    the two, which is why "redundant" alone is not the criterion.
    """
    big = b(*[f"p{i}" for i in range(20)])
    recovered = {"big": big, "dup": set(sorted(big)[:15]), "tail": b("p20", "p21")}
    r = ordering.summarise(
        recovered, {"big": 10.0, "dup": 60.0, "tail": 1.0}, goal_size=22
    )
    assert r["best"]["order"][-1] == "dup"
    assert r["attacks"][1]["exclusive"] == 0  # dup contributes nothing of its own


def test_total_runtime_and_total_recovered_are_order_invariant():
    """What makes the comparison fair: only the shape of the curve changes."""
    recovered = {"a": b("p1", "p2"), "b": b("p2", "p3"), "c": b("p4")}
    dur = {"a": 3.0, "b": 7.0, "c": 1.0}
    r = ordering.summarise(recovered, dur, goal_size=4)

    assert r["total_runtime_s"] == pytest.approx(11.0)
    assert r["combined_recovered"] == 4
    for entry in r["top"]:
        assert entry["milestones"][-1]["time_s"] == pytest.approx(11.0)


def test_efficiency_is_the_normalised_area_under_the_curve():
    """Hand-checked. a: 2 found in 1s; b: 2 more in 1s. Trapezoid area is
    1·(0+2)/2 + 1·(2+4)/2 = 1 + 3 = 4, over total·runtime = 4·2 = 8."""
    r = ordering.summarise(
        {"a": b("p1", "p2"), "b": b("p3", "p4")}, {"a": 1.0, "b": 1.0}, goal_size=4
    )
    assert r["best"]["auc"] == pytest.approx(4.0)
    assert r["best"]["efficiency"] == pytest.approx(0.5)


def test_steps_report_marginal_gain_not_raw_recovery():
    """The second attack's `gain` is what it adds, not what it found."""
    r = ordering.summarise(
        {"a": b("p1", "p2", "p3"), "b": b("p3", "p4")},
        {"a": 1.0, "b": 1.0},
        goal_size=4,
    )
    steps = {s["label"]: s for s in r["best"]["steps"]}
    assert steps["a"]["gain"] == 3
    assert steps["b"]["gain"] == 1  # p3 was already found
    assert r["best"]["steps"][-1]["cumulative"] == 4


# ── milestones ──────────────────────────────────────────────────────────────

def test_milestones_interpolate_inside_the_crossing_attack():
    """100 passwords over 10s, then nothing. 50% of the total is reached
    halfway through the first attack, i.e. at 5s."""
    recovered = {"a": b(*[f"p{i}" for i in range(100)]), "b": b("p0")}
    r = ordering.summarise(recovered, {"a": 10.0, "b": 10.0}, goal_size=100)
    ms = {m["fraction"]: m for m in r["best"]["milestones"]}

    assert r["best"]["order"] == ["a", "b"]
    assert ms[0.5]["time_s"] == pytest.approx(5.0)
    assert ms[0.5]["after"] == "a"
    assert ms[1.0]["time_s"] == pytest.approx(10.0)  # b adds nothing new


def test_milestone_is_unreached_rather_than_guessed():
    """An ordering can hit its own 100% early; later milestones still resolve."""
    r = ordering.summarise(
        {"a": b("p1"), "b": b("p1")}, {"a": 1.0, "b": 1.0}, goal_size=1
    )
    for m in r["best"]["milestones"]:
        assert m["time_s"] is not None


# ── greedy vs exhaustive ────────────────────────────────────────────────────

def test_greedy_is_reported_and_never_beats_the_optimum():
    recovered = {
        "a": b("p1", "p2", "p3"),
        "b": b("p3", "p4"),
        "c": b("p4", "p5", "p6", "p7"),
    }
    dur = {"a": 2.0, "b": 1.0, "c": 5.0}
    r = ordering.summarise(recovered, dur, goal_size=7)

    assert r["greedy"]["efficiency"] <= r["best"]["efficiency"] + 1e-12
    assert r["greedy"]["is_optimal"] == (r["greedy"]["beaten_by"] == 0)
    assert len(r["greedy"]["order"]) == 3


def test_greedy_can_be_suboptimal_which_is_why_we_enumerate():
    """Greedy's blind spot, in the smallest instance that has one.

    `quick` has the better recovery rate (3/s against 2.5/s) so greedy opens
    with it — but everything it finds, `broader` finds too, so once `broader`
    has run, `quick`'s one second bought nothing. Opening with `broader`
    instead reaches the full haul sooner:

        quick → broader:  1·(0+3)/2 + 2·(3+5)/2 = 9.5
        broader → quick:  2·(0+5)/2 + 1·(5+5)/2 = 10.0

    Greedy cannot see this, because it compares rates before knowing what the
    rest of the pool will make redundant. That is the justification for
    enumerating every permutation, so if it ever stops holding, this test is
    the place that says so.
    """
    recovered = {"quick": b("p0", "p1", "p2"), "broader": b("p0", "p1", "p2", "p3", "p4")}
    dur = {"quick": 1.0, "broader": 2.0}
    r = ordering.summarise(recovered, dur, goal_size=5)

    assert r["greedy"]["order"] == ["quick", "broader"]
    assert r["best"]["order"] == ["broader", "quick"]
    assert r["best"]["auc"] == pytest.approx(10.0)
    assert r["greedy"]["auc"] == pytest.approx(9.5)
    assert r["greedy"]["beaten_by"] == 1
    assert not r["greedy"]["is_optimal"]


# ── reported shape ──────────────────────────────────────────────────────────

def test_first_choice_covers_every_opening_move():
    recovered = {name: b(f"only-{name}", "shared") for name in "abc"}
    r = ordering.summarise(recovered, {n: 1.0 for n in "abc"}, goal_size=4)

    assert {e["label"] for e in r["first_choice"]} == set("abc")
    # Each entry's best order really does open with that attack.
    for e in r["first_choice"]:
        assert e["order"][0] == e["label"]
    # And the best opener matches the overall optimum.
    assert r["first_choice"][0]["efficiency"] == pytest.approx(r["best"]["efficiency"])


def test_top_is_ranked_and_capped():
    recovered = {name: b(f"only-{name}") for name in "abcdef"}
    dur = {name: float(i + 1) for i, name in enumerate("abcdef")}
    r = ordering.summarise(recovered, dur, goal_size=6)

    assert len(r["top"]) == ordering.TOP_K
    effs = [e["efficiency"] for e in r["top"]]
    assert effs == sorted(effs, reverse=True)
    assert effs[0] == pytest.approx(r["best"]["efficiency"])
    # `top` is the compact ranking — the per-step curve stays on `best`.
    assert "steps" not in r["top"][0]


def test_distribution_spans_the_scores():
    recovered = {"a": b("p1", "p2"), "b": b("p3"), "c": b("p4", "p5", "p6")}
    r = ordering.summarise(recovered, {"a": 1.0, "b": 9.0, "c": 2.0}, goal_size=6)
    d = r["distribution"]

    assert sum(d["bins"]) == r["permutations_scored"]
    assert d["min"] == pytest.approx(r["worst"]["efficiency"])
    assert d["max"] == pytest.approx(r["best"]["efficiency"])
    assert d["min"] <= d["mean"] <= d["max"]


def test_signatures_describe_who_finds_what():
    recovered = {"a": b("x", "y"), "b": b("y", "z")}
    r = ordering.summarise(recovered, {"a": 1.0, "b": 1.0}, goal_size=3)
    by_labels = {tuple(s["labels"]): s["count"] for s in r["signatures"]}

    assert by_labels[("a",)] == 1
    assert by_labels[("b",)] == 1
    assert by_labels[("a", "b")] == 1
    assert sum(by_labels.values()) == r["combined_recovered"]


# ── degenerate input ────────────────────────────────────────────────────────

def test_attacks_that_found_nothing_do_not_divide_by_zero():
    r = ordering.summarise({"a": set(), "b": set()}, {"a": 1.0, "b": 2.0}, goal_size=10)
    assert r["combined_recovered"] == 0
    assert r["best"]["efficiency"] == 0.0
    assert r["combined_coverage"] == 0.0


def test_missing_timings_fall_back_to_equal_weights_and_say_so():
    """A duration of zero everywhere means there is no "earliest" to optimise;
    the union structure is still described, flagged as untimed."""
    r = ordering.summarise({"a": b("p1"), "b": b("p2")}, {}, goal_size=2)
    assert r["timing_available"] is False
    assert r["total_runtime_s"] is None
    assert r["attacks"][0]["duration_s"] is None
    assert r["permutations_scored"] == 2


def test_an_empty_goal_list_leaves_coverage_at_zero():
    r = ordering.summarise({"a": b("p1"), "b": b("p2")}, {"a": 1.0, "b": 1.0}, goal_size=0)
    assert r["combined_coverage"] == 0.0
    assert r["best"]["steps"][0]["cumulative_coverage"] == 0.0


def test_too_few_or_too_many_attacks_are_refused():
    with pytest.raises(ordering.OrderingError):
        ordering.summarise({"a": b("p1")}, {"a": 1.0}, goal_size=1)

    many = {f"a{i}": b(f"p{i}") for i in range(ordering.MAX_ORDER_ATTACKS + 1)}
    with pytest.raises(ordering.OrderingError):
        ordering.summarise(many, {k: 1.0 for k in many}, goal_size=len(many))


def test_the_maximum_size_is_actually_enumerable():
    """8 attacks is 40,320 orderings — the cap exists because this has to stay
    fast, so it is worth running once."""
    n = ordering.MAX_ORDER_ATTACKS
    recovered = {f"a{i}": b(*[f"p{i}-{j}" for j in range(50)]) for i in range(n)}
    dur = {f"a{i}": float(i + 1) for i in range(n)}
    r = ordering.summarise(recovered, dur, goal_size=n * 50)

    import math
    assert r["permutations_scored"] == math.factorial(n)
    # All disjoint and equal size, so cheapest-first is the only right answer.
    assert r["best"]["order"] == [f"a{i}" for i in range(n)]


def test_score_matches_a_brute_force_reference_implementation():
    """Cross-check the signature shortcut end to end: score every ordering
    again with plain set unions and compare the winner."""
    recovered = {
        "a": b("p1", "p2", "p5"),
        "b": b("p2", "p3"),
        "c": b("p3", "p4", "p5", "p6"),
        "d": b("p7"),
    }
    dur = {"a": 4.0, "b": 1.0, "c": 7.0, "d": 2.0}
    labels = list(recovered)

    def reference(order: tuple[str, ...]) -> float:
        seen: set[bytes] = set()
        prev = 0
        auc = 0.0
        for label in order:
            seen |= recovered[label]
            auc += dur[label] * (prev + len(seen)) * 0.5
            prev = len(seen)
        return auc

    best_ref = max(permutations(labels), key=lambda o: (reference(o), o))
    r = ordering.summarise(recovered, dur, goal_size=7)

    assert r["best"]["auc"] == pytest.approx(reference(best_ref))
    assert r["best"]["auc"] == pytest.approx(reference(tuple(r["best"]["order"])))
