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
    """`fast` finds 9 of the 10 in one guess; `slow` needs 100 guesses to add
    1. Running `fast` first has to win."""
    recovered = {
        "fast": b(*[f"p{i}" for i in range(9)]),
        "slow": b("p9"),
    }
    r = ordering.summarise(recovered, 10, guesses={"fast": 1.0, "slow": 100.0})

    assert r["best"]["order"] == ["fast", "slow"]
    assert r["worst"]["order"] == ["slow", "fast"]
    assert r["best"]["efficiency"] > r["worst"]["efficiency"]
    assert r["permutations_scored"] == 2


def test_every_permutation_is_scored():
    recovered = {name: b(f"only-{name}") for name in "abcde"}
    r = ordering.summarise(recovered, 5, guesses={name: 1.0 for name in "abcde"})
    assert r["permutations_scored"] == 120  # 5!


def test_strictly_redundant_and_slow_attack_is_pushed_last():
    """`dup` is a subset of `big` *and* costlier per find than everything, so
    there is no reading under which it should run early.

    Note the mirror case is not a bug: a subset attack that is much *cheaper*
    than the one containing it does belong early, because it buys most of that
    attack's haul for a fraction of the guesses. The ranking has to distinguish
    the two, which is why "redundant" alone is not the criterion.
    """
    big = b(*[f"p{i}" for i in range(20)])
    recovered = {"big": big, "dup": set(sorted(big)[:15]), "tail": b("p20", "p21")}
    r = ordering.summarise(recovered, 22, guesses={"big": 10.0, "dup": 60.0, "tail": 1.0})
    assert r["best"]["order"][-1] == "dup"
    assert r["attacks"][1]["exclusive"] == 0  # dup contributes nothing of its own


def test_total_guesses_and_total_recovered_are_order_invariant():
    """What makes the comparison fair: only the shape of the curve changes."""
    recovered = {"a": b("p1", "p2"), "b": b("p2", "p3"), "c": b("p4")}
    r = ordering.summarise(recovered, 4, guesses={"a": 3, "b": 7, "c": 1})

    assert r["cost_axis"] == "guesses"
    assert r["total_guesses"] == 11
    assert r["combined_recovered"] == 4
    for entry in r["top"]:
        assert entry["milestones"][-1]["guesses"] == 11
        assert entry["milestones"][-1]["cost"] == pytest.approx(11.0)


def test_efficiency_is_the_normalised_area_under_the_curve():
    """Hand-checked. a: 2 found in 1 guess; b: 2 more in 1 guess. Trapezoid
    area is 1·(0+2)/2 + 1·(2+4)/2 = 1 + 3 = 4, over total·guesses = 4·2 = 8."""
    r = ordering.summarise({"a": b("p1", "p2"), "b": b("p3", "p4")}, 4, guesses={"a": 1.0, "b": 1.0})
    assert r["best"]["auc"] == pytest.approx(4.0)
    assert r["best"]["efficiency"] == pytest.approx(0.5)


def test_steps_report_marginal_gain_not_raw_recovery():
    """The second attack's `gain` is what it adds, not what it found."""
    r = ordering.summarise({"a": b("p1", "p2", "p3"), "b": b("p3", "p4")}, 4, guesses={"a": 1, "b": 1})
    steps = {s["label"]: s for s in r["best"]["steps"]}
    assert steps["a"]["gain"] == 3
    assert steps["b"]["gain"] == 1  # p3 was already found
    assert r["best"]["steps"][-1]["cumulative"] == 4


# ── milestones ──────────────────────────────────────────────────────────────

def test_milestones_interpolate_inside_the_crossing_attack():
    """100 passwords over 1000 guesses, then nothing. 50% of the total is
    reached halfway through the first attack: 500 guesses, and with durations
    alongside, 5s."""
    recovered = {"a": b(*[f"p{i}" for i in range(100)]), "b": b("p0")}
    r = ordering.summarise(
        recovered, 100, guesses={"a": 1000, "b": 1000}, durations={"a": 10.0, "b": 10.0}
    )
    ms = {m["fraction"]: m for m in r["best"]["milestones"]}

    assert r["best"]["order"] == ["a", "b"]
    assert ms[0.5]["guesses"] == 500
    assert ms[0.5]["time_s"] == pytest.approx(5.0)
    assert ms[0.5]["after"] == "a"
    assert ms[1.0]["guesses"] == 1000  # b adds nothing new


def test_milestone_is_unreached_rather_than_guessed():
    """An ordering can hit its own 100% early; later milestones still resolve."""
    r = ordering.summarise({"a": b("p1"), "b": b("p1")}, 1, guesses={"a": 1.0, "b": 1.0})
    for m in r["best"]["milestones"]:
        assert m["cost"] is not None


# ── greedy vs exhaustive ────────────────────────────────────────────────────

def test_greedy_is_reported_and_never_beats_the_optimum():
    recovered = {
        "a": b("p1", "p2", "p3"),
        "b": b("p3", "p4"),
        "c": b("p4", "p5", "p6", "p7"),
    }
    dur = {"a": 2.0, "b": 1.0, "c": 5.0}
    r = ordering.summarise(recovered, 7, guesses=dur)

    assert r["greedy"]["efficiency"] <= r["best"]["efficiency"] + 1e-12
    assert r["greedy"]["is_optimal"] == (r["greedy"]["beaten_by"] == 0)
    assert len(r["greedy"]["order"]) == 3


def test_greedy_can_be_suboptimal_which_is_why_we_enumerate():
    """Greedy's blind spot, in the smallest instance that has one.

    `quick` has the better recovery rate (3 per guess against 2.5) so greedy
    opens with it — but everything it finds, `broader` finds too, so once
    `broader` has run, `quick`'s one guess bought nothing. Opening with `broader`
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
    r = ordering.summarise(recovered, 5, guesses=dur)

    assert r["greedy"]["order"] == ["quick", "broader"]
    assert r["best"]["order"] == ["broader", "quick"]
    assert r["best"]["auc"] == pytest.approx(10.0)
    assert r["greedy"]["auc"] == pytest.approx(9.5)
    assert r["greedy"]["beaten_by"] == 1
    assert not r["greedy"]["is_optimal"]


# ── reported shape ──────────────────────────────────────────────────────────

def test_first_choice_covers_every_opening_move():
    recovered = {name: b(f"only-{name}", "shared") for name in "abc"}
    r = ordering.summarise(recovered, 4, guesses={n: 1.0 for n in "abc"})

    assert {e["label"] for e in r["first_choice"]} == set("abc")
    # Each entry's best order really does open with that attack.
    for e in r["first_choice"]:
        assert e["order"][0] == e["label"]
    # And the best opener matches the overall optimum.
    assert r["first_choice"][0]["efficiency"] == pytest.approx(r["best"]["efficiency"])


def test_top_is_ranked_and_capped():
    recovered = {name: b(f"only-{name}") for name in "abcdef"}
    dur = {name: float(i + 1) for i, name in enumerate("abcdef")}
    r = ordering.summarise(recovered, 6, guesses=dur)

    assert len(r["top"]) == ordering.TOP_K
    effs = [e["efficiency"] for e in r["top"]]
    assert effs == sorted(effs, reverse=True)
    assert effs[0] == pytest.approx(r["best"]["efficiency"])
    # `top` is the compact ranking — the per-step curve stays on `best`.
    assert "steps" not in r["top"][0]


def test_distribution_spans_the_scores():
    recovered = {"a": b("p1", "p2"), "b": b("p3"), "c": b("p4", "p5", "p6")}
    r = ordering.summarise(recovered, 6, guesses={"a": 1.0, "b": 9.0, "c": 2.0})
    d = r["distribution"]

    assert sum(d["bins"]) == r["permutations_scored"]
    assert d["min"] == pytest.approx(r["worst"]["efficiency"])
    assert d["max"] == pytest.approx(r["best"]["efficiency"])
    assert d["min"] <= d["mean"] <= d["max"]


def test_signatures_describe_who_finds_what():
    recovered = {"a": b("x", "y"), "b": b("y", "z")}
    r = ordering.summarise(recovered, 3, guesses={"a": 1.0, "b": 1.0})
    by_labels = {tuple(s["labels"]): s["count"] for s in r["signatures"]}

    assert by_labels[("a",)] == 1
    assert by_labels[("b",)] == 1
    assert by_labels[("a", "b")] == 1
    assert sum(by_labels.values()) == r["combined_recovered"]


# ── degenerate input ────────────────────────────────────────────────────────

def test_attacks_that_found_nothing_do_not_divide_by_zero():
    r = ordering.summarise({"a": set(), "b": set()}, 10, guesses={"a": 1.0, "b": 2.0})
    assert r["combined_recovered"] == 0
    assert r["best"]["efficiency"] == 0.0
    assert r["combined_coverage"] == 0.0


def test_guesses_are_the_axis_even_when_the_clock_disagrees():
    """`a` is quicker in seconds but costs far more guesses, so `b` goes first;
    durations are still reported alongside."""
    recovered = {"a": b("p1", "p2"), "b": b("p3", "p4")}
    r = ordering.summarise(
        recovered, 4, guesses={"a": 1000, "b": 10}, durations={"a": 1.0, "b": 50.0}
    )
    assert r["cost_axis"] == "guesses"
    assert r["best"]["order"] == ["b", "a"]
    assert r["total_runtime_s"] == pytest.approx(51.0)
    step = r["best"]["steps"][0]
    assert (step["guesses"], step["duration_s"]) == (10, 50.0)
    assert r["attacks"][0]["rate_per_guess"] == pytest.approx(2 / 1000)


def test_a_missing_guess_count_falls_back_to_time():
    """Mixing units would rank nonsense, so one unknown count means seconds for
    every attack — and the result says which axis it used."""
    recovered = {"a": b("p1", "p2"), "b": b("p3", "p4")}
    r = ordering.summarise(
        recovered, 4, guesses={"a": 1000, "b": None}, durations={"a": 1.0, "b": 50.0}
    )
    assert r["cost_axis"] == "time"
    assert r["total_guesses"] is None
    assert r["best"]["order"] == ["a", "b"]
    assert "guesses" not in r["best"]["steps"][0]


def test_no_costs_at_all_fall_back_to_equal_weights_and_say_so():
    """Without guesses or durations there is no "earliest" to optimise; the
    union structure is still described, flagged as such."""
    r = ordering.summarise({"a": b("p1"), "b": b("p2")}, 2)
    assert r["cost_axis"] == "equal"
    assert r["timing_available"] is False
    assert r["total_runtime_s"] is None
    assert r["total_guesses"] is None
    assert r["attacks"][0]["duration_s"] is None
    assert r["attacks"][0]["guesses"] is None
    assert r["permutations_scored"] == 2


def test_an_empty_goal_list_leaves_coverage_at_zero():
    r = ordering.summarise({"a": b("p1"), "b": b("p2")}, 0, guesses={"a": 1.0, "b": 1.0})
    assert r["combined_coverage"] == 0.0
    assert r["best"]["steps"][0]["cumulative_coverage"] == 0.0


def test_too_few_or_too_many_attacks_are_refused():
    with pytest.raises(ordering.OrderingError):
        ordering.summarise({"a": b("p1")}, 1, guesses={"a": 1.0})

    many = {f"a{i}": b(f"p{i}") for i in range(ordering.MAX_ORDER_ATTACKS + 1)}
    with pytest.raises(ordering.OrderingError):
        ordering.summarise(many, len(many), guesses={k: 1 for k in many})


def test_the_largest_exact_size_is_actually_enumerable():
    """EXACT_ENUM_MAX! orderings scored exactly — the ceiling on exhaustive
    enumeration, worth running once to prove it stays fast."""
    n = ordering.EXACT_ENUM_MAX
    recovered = {f"a{i}": b(*[f"p{i}-{j}" for j in range(50)]) for i in range(n)}
    dur = {f"a{i}": float(i + 1) for i in range(n)}
    r = ordering.summarise(recovered, n * 50, guesses=dur)

    import math
    assert r["approximate"] is False
    assert r["permutations_scored"] == math.factorial(n)
    # All disjoint and equal size, so cheapest-first is the only right answer.
    assert r["best"]["order"] == [f"a{i}" for i in range(n)]


# ── beam search above the exact-enumeration cap ──────────────────────────────

def test_beam_matches_the_exact_optimum_on_a_small_instance():
    """With a wide beam the heuristic must recover the true optimum. Checked on
    a size the exact path can also solve, for a ground truth."""
    recovered = {
        "a": b("p1", "p2", "p5"),
        "b": b("p2", "p3"),
        "c": b("p3", "p4", "p5", "p6"),
        "d": b("p7"),
        "e": b("p1", "p8"),
    }
    cost = [4.0, 1.0, 7.0, 2.0, 3.0]
    labels = list(recovered)
    counts = ordering.signature_counts(recovered, labels)
    table, _ = ordering.union_table(len(labels), counts)

    exact = max(permutations(range(len(labels))),
                key=lambda o: ordering._auc(o, table, cost))
    beam = ordering.beam_search(len(labels), table, cost, width=1000)
    assert ordering._auc(beam, table, cost) == pytest.approx(ordering._auc(exact, table, cost))


def test_beam_is_at_least_as_good_as_greedy():
    recovered = {f"a{i}": b(*[f"p{i}-{j}" for j in range(i + 1)]) for i in range(12)}
    # overlap a few so order actually matters
    recovered["a3"] |= recovered["a1"]
    recovered["a7"] |= recovered["a2"]
    cost = [float(i % 4 + 1) for i in range(12)]
    labels = list(recovered)
    counts = ordering.signature_counts(recovered, labels)
    table, _ = ordering.union_table(len(labels), counts)

    greedy = ordering.greedy_order(12, table, cost)
    beam = ordering.beam_search(12, table, cost, width=200)
    assert ordering._auc(beam, table, cost) >= ordering._auc(greedy, table, cost) - 1e-9


def test_large_jobs_are_approximate_but_complete():
    """Above EXACT_ENUM_MAX the result is flagged approximate, carries a beam
    width, still ranks best ≥ greedy, and `first_choice` covers every opener."""
    n = 14
    recovered = {f"a{i}": b(*[f"p{i}-{j}" for j in range(20)]) for i in range(n)}
    # Make two attacks redundant so greedy can be beaten and order matters.
    recovered["a9"] = set(recovered["a0"])
    dur = {f"a{i}": float(i % 5 + 1) for i in range(n)}
    r = ordering.summarise(recovered, n * 20, guesses=dur)

    assert r["approximate"] is True
    assert r["beam_width"] == ordering.BEAM_WIDTH
    assert len(r["best"]["order"]) == n
    assert r["best"]["efficiency"] >= r["greedy"]["efficiency"] - 1e-9
    assert {e["label"] for e in r["first_choice"]} == {f"a{i}" for i in range(n)}
    # The sample is deterministic, so a re-run scores identically.
    assert ordering.summarise(recovered, n * 20, guesses=dur)["best"]["order"] == r["best"]["order"]


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
    r = ordering.summarise(recovered, 7, guesses=dur)

    assert r["best"]["auc"] == pytest.approx(reference(best_ref))
    assert r["best"]["auc"] == pytest.approx(reference(tuple(r["best"]["order"])))


# ── order-aware within-attack recovery profiles ──────────────────────────────

def test_attach_step_profiles_is_order_aware():
    """The same attack's within-attack curve depends on what ran before it.

    Attack b finds p3,p4 at the start of its keyspace (bucket 0) and p5,p6 at the
    end (last bucket). Run first, all four are new, so its profile is front-loaded.
    Run after a (which already found p3,p4), only the late p5,p6 are new, so the
    profile is back-loaded — the whole point of computing it per ordering.
    """
    last = ordering.PROFILE_BUCKETS - 1
    recovered = {"a": b("p1", "p2", "p3", "p4"), "b": b("p3", "p4", "p5", "p6")}
    crack_buckets = {
        "a": {b"p1": 0, b"p2": 0, b"p3": 0, b"p4": 0},
        "b": {b"p3": 0, b"p4": 0, b"p5": last, b"p6": last},
    }

    b_first = {"steps": [
        {"label": "b", "gain": 4, "cumulative": 4},
        {"label": "a", "gain": 2, "cumulative": 6},
    ]}
    ordering._attach_step_profiles(b_first, recovered, crack_buckets, None)
    bp = b_first["steps"][0]["recovery_profile"]
    assert bp[0] == 2 and bp[-1] == 4          # front-loaded: 2 of 4 new in bucket 0

    a_first = {"steps": [
        {"label": "a", "gain": 4, "cumulative": 4},
        {"label": "b", "gain": 2, "cumulative": 6},
    ]}
    ordering._attach_step_profiles(a_first, recovered, crack_buckets, None)
    bp2 = a_first["steps"][1]["recovery_profile"]
    assert bp2[0] == 0 and bp2[-2] == 0 and bp2[-1] == 2   # back-loaded: both new at the end


def test_attach_step_profiles_total_equals_gain_and_handles_missing():
    recovered = {"a": b("p1", "p2"), "b": b("p2", "p3")}
    # Only a has a bucket map; b's step must come out None.
    crack_buckets = {"a": {b"p1": 0, b"p2": 5}}
    run = {"steps": [
        {"label": "a", "gain": 2, "cumulative": 2},
        {"label": "b", "gain": 1, "cumulative": 3},
    ]}
    ordering._attach_step_profiles(run, recovered, crack_buckets, {"a": "guesses"})
    assert run["steps"][0]["recovery_profile"][-1] == run["steps"][0]["gain"]
    assert run["steps"][0]["recovery_profile_basis"] == "guesses"
    assert run["steps"][1]["recovery_profile"] is None
    assert run["steps"][1]["recovery_profile_basis"] is None


def test_summarise_attaches_profiles_to_displayed_orderings():
    recovered = {"a": b("p1", "p2", "p3"), "b": b("p3", "p4"), "c": b("p5")}
    crack_buckets = {
        "a": {b"p1": 0, b"p2": 1, b"p3": 2},
        "b": {b"p3": 0, b"p4": 10},
        "c": {b"p5": 0},
    }
    guesses = {"a": 100, "b": 100, "c": 100}
    r = ordering.summarise(recovered, 5, guesses=guesses, crack_buckets=crack_buckets)

    for run in (r["best"], r["worst"], r["greedy"]):
        for step in run["steps"]:
            prof = step["recovery_profile"]
            assert prof is not None
            assert prof == sorted(prof)               # non-decreasing
            assert prof[-1] == step["gain"]           # total new == measured gain


def test_summarise_without_crack_buckets_leaves_profiles_absent():
    recovered = {"a": b("p1", "p2"), "b": b("p2", "p3")}
    r = ordering.summarise(recovered, 3, guesses={"a": 10, "b": 10})
    assert all("recovery_profile" not in s for s in r["best"]["steps"])
