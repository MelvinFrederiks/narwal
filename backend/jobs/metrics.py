"""Mergeability and Jaccard indices over the sets of goal passwords that
each attack recovered.

Lives under backend/jobs/ rather than worker/ because the API needs the same
definitions to describe a result, and the tests import it without hashcat
installed.

Definitions, for attacks A and B run against goal set G, where S_A, S_B ⊆ G
are the goal entries each attack recovered:

    coverage_i   = |S_i| / |G|
    jaccard      = |S_A ∩ S_B| / |S_A ∪ S_B|
    mergeability = (|S_A ∪ S_B| − max(|S_A|, |S_B|)) / max(|S_A|, |S_B|)

Mergeability is the marginal gain from combining the two attacks, measured
against whichever attack was better on its own. 0 means the weaker attack adds
nothing the stronger one did not already find; 1 means they recovered disjoint
sets of equal size, i.e. combining them doubles the yield. It is not symmetric
in what it tells you but it *is* symmetric in value — swapping A and B gives
the same number.

Source: "The Mergeability Index" (arXiv:2504.16651). The paper's Eq. 4 sits in
Appendix C, which the arXiv HTML render does not expose; this implements the
definition given in the body — "the ratio between the marginal gain achieved
by combining the outputs of M1 and M2 over the best performance between M1 and
M2" — which agrees with the paper's stated 0-to-1 reading. If the appendix
turns out to normalise differently, `mergeability` below is the only thing
that needs to change.
"""

from __future__ import annotations

from itertools import combinations


def jaccard(a: set, b: set) -> float:
    """|A ∩ B| / |A ∪ B|. Two empty sets are defined as 0, not 1/0 — an attack
    pair that recovered nothing has no measurable similarity."""
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def mergeability(a: set, b: set) -> float:
    """Marginal gain of merging A and B, relative to the better of the two.

    Undefined when both attacks recovered nothing (the denominator is the best
    single result); reported as 0.0, matching "merging buys you nothing".
    """
    best = max(len(a), len(b))
    if best == 0:
        return 0.0
    return (len(a | b) - best) / best


def pair_stats(label_a: str, a: set, label_b: str, b: set, goal_size: int) -> dict:
    """Everything the UI shows for one pair, in one place.

    `only_a`/`only_b`/`shared` are what the Venn needs, and they are consistent
    by construction: each side's own region plus the shared region equals that
    side's total.
    """
    shared = len(a & b)
    union = len(a | b)
    return {
        "a": label_a,
        "b": label_b,
        "recovered_a": len(a),
        "recovered_b": len(b),
        "shared": shared,
        "only_a": len(a) - shared,
        "only_b": len(b) - shared,
        "union": union,
        "jaccard": jaccard(a, b),
        "mergeability": mergeability(a, b),
        # What the merged pair covers of the whole goal list — the number that
        # answers "is it worth running both?"
        "union_coverage": union / goal_size if goal_size else 0.0,
    }


def summarise(recovered: dict[str, set], goal_size: int) -> dict:
    """Per-attack coverage plus every pair, given each attack's recovered set.

    Pairs are emitted in descending mergeability so the most complementary
    combination is the first thing the user reads.
    """
    per_attack = [
        {
            "label": label,
            "recovered": len(s),
            "coverage": len(s) / goal_size if goal_size else 0.0,
        }
        for label, s in recovered.items()
    ]
    pairs = [
        pair_stats(la, recovered[la], lb, recovered[lb], goal_size)
        for la, lb in combinations(recovered, 2)
    ]
    pairs.sort(key=lambda p: p["mergeability"], reverse=True)

    all_union = set().union(*recovered.values()) if recovered else set()
    return {
        "goal_size": goal_size,
        "attacks": per_attack,
        "pairs": pairs,
        # Ceiling for the whole job: what every attack together covers.
        "combined_recovered": len(all_union),
        "combined_coverage": len(all_union) / goal_size if goal_size else 0.0,
    }
