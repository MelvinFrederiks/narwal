"""Scoring every ordering of a set of attacks by how early it recovers passwords.

The question this answers: given attacks A, B, C, … that you intend to run
anyway, in what sequence should you run them so that the cracked count climbs
as steeply as possible? Two sequences of the same attacks make the same number
of guesses for the same total — but one of them may have found 80% of its haul
early while the other is still working through a brute force that adds nothing
the wordlist run would have found later anyway.

## Why guesses and not seconds

Cost is counted in guesses: the candidates hashcat tried, as reported by its
status-json `progress` (see worker/hashcat.py). A guess count belongs to the
attack; a duration also depends on the machine, the device and whether the
kernel cache was warm, any of which can reorder a time-based ranking without
the attacks changing. Durations are still recorded and shown, and are only
ranked against when guess counts are missing — see `_cost_axis`.

## Why this costs N hashcat runs and not N!

An attack's recovered set and its guess count do not depend on where it sits
in the sequence. That is not an approximation — it is the same property the
mergeability measurement already relies on: `--potfile-disable` means every
attack is run against the *full* goal list and never sees what another attack
cracked (see worker/hashcat.py). So the worker runs each attack exactly once,
and every permutation's cracked-over-guesses curve is then a pure function of
the N recovered sets and the N guess counts. Up to EXACT_ENUM_MAX attacks all
N! orderings get scored here, exhaustively and exactly, in milliseconds. Above
that, N! is infeasible — ordering is min-sum set cover, which is NP-hard — so a
fixed-width beam search (`beam_search`) finds a near-optimal order in O(width·N²)
and the result is flagged `approximate`. See `beam_search` and `summarise`.

## How all N! orderings get scored without touching the sets N! times

Scoring an ordering needs the cumulative union size after each prefix. Doing
that with real set unions would be |goal| work per prefix — billions of
operations for 8 attacks. Instead every recovered password is reduced to an
N-bit *coverage signature*: which attacks find it. There are at most 2^N − 1
distinct signatures, so the whole corpus collapses to a table of at most 255
counts, and

    |S_a1 ∪ … ∪ S_aj|  =  Σ over signatures that intersect {a1…aj} of count

depends only on that table. `union_table` precomputes the answer for all 2^N
subsets up front with a subset-sum (zeta) transform — n·2^N = 2048 additions
for 8 attacks — after which scoring one ordering is N array lookups. Total
cost for 8 attacks: 40,320 orderings × 8 lookups. The signature table is also
worth showing on its own; "1,247 passwords that only attack C finds" is the
concrete reason an ordering wins.

## The score

With cumulative recovery C_j after the j-th attack (C_0 = 0), per-attack
guess counts g_j and cumulative guesses G_j:

    auc        = Σ_j g_j · (C_{j−1} + C_j) / 2      — area under cracked-vs-guesses
    efficiency = auc / (C_N · G_N)

`efficiency` is in (0, 1): 1 would be "everything found at once", 0.5 is
roughly "recovery grew linearly with guesses", and above 0.5 means
front-loaded. Both C_N and G_N are the same for every ordering, so ranking by auc and ranking
by efficiency are the same ranking — the normalisation only exists to make the
number readable.

The one modelling assumption is inside an attack: hashcat tells us how many
goal entries an attack recovered and how many guesses it made, but not *which*
entry was found at which guess, so recovery is taken to accrue uniformly over
the attack's run (the trapezoid above). It affects the exact score, not the
ranking's broad shape — an attack that recovers a lot per guess sorts early
either way. The milestones ("with this order you are at 50% of the total haul
after 40M guesses") only ever interpolate inside the one attack that crosses
the milestone.

Greedy — repeatedly take whichever attack adds the most new passwords per
guess — is computed too, and compared against the exhaustive optimum. It is
*not* always optimal (marginal gain is not additive: an attack can look poor
until the attack that would have duplicated it has been removed from the pool),
which is the honest justification for enumerating everything.

Lives in backend/jobs/ beside metrics.py for the same reason: the API needs
these definitions to describe a result, and the tests import it without
hashcat installed.
"""

from __future__ import annotations

import heapq
import random
from itertools import permutations

from backend.jobs.result import (
    MilestoneStat,
    OrderingAttackResult,
    OrderingDistribution,
    OrderingFirstChoice,
    OrderingResult,
    OrderingSignature,
    OrderingSingleRun,
    OrderingStep,
)

# Up to EXACT_ENUM_MAX attacks every permutation is scored exactly (10! = 3.6M
# is ~1s; 12! never finishes). Above it, a fixed-width beam search finds a
# near-optimal ordering in O(width·N^2) — ordering is min-sum set cover, which
# is NP-hard, so exact enumeration was never going to scale and a beam (which
# generalises the greedy heuristic) is the principled way up. MAX_ORDER_ATTACKS
# is the beam's ceiling; the 2^N union table is only 65,536 entries at 16.
MAX_ORDER_ATTACKS = 16
EXACT_ENUM_MAX = 10
BEAM_WIDTH = 1000       # partial orderings kept per depth above EXACT_ENUM_MAX
SAMPLE_SIZE = 50_000    # random orderings scored for the spread when approximate

# Fractions of the *achievable* total (not of the goal list) that the milestone
# table reports points for. 1.0 is "everything these attacks will ever find".
MILESTONES = (0.25, 0.5, 0.75, 0.9, 1.0)

TOP_K = 20  # orderings returned in full ranking order
DIST_BINS = 20  # buckets in the score histogram
MAX_SIGNATURES = 16  # coverage signatures returned, largest first
# Points in a per-step recovery profile. Mirrors worker/hashcat.py::PROFILE_BUCKETS
# (the bucket a crack lands in is assigned there); kept as its own constant so
# this module stays importable without the worker / hashcat.
PROFILE_BUCKETS = 64


class OrderingError(ValueError):
    """An ordering analysis that cannot be scored. Safe to show the user."""


# ── coverage signatures ─────────────────────────────────────────────────────


def signature_counts(recovered: dict[str, set[bytes]], labels: list[str]) -> dict[int, int]:
    """Collapse the recovered sets into {bitmask: how many passwords have it}.

    The bit for `labels[i]` is `1 << i`. A password recovered by attacks 0 and
    2 gets signature 0b101. Signature 0 cannot occur: a password only appears
    here because some attack found it.
    """
    sig: dict[bytes, int] = {}
    for i, label in enumerate(labels):
        bit = 1 << i
        for pw in recovered[label]:
            sig[pw] = sig.get(pw, 0) | bit

    counts: dict[int, int] = {}
    for mask in sig.values():
        counts[mask] = counts.get(mask, 0) + 1
    return counts


def union_table(n: int, counts: dict[int, int]) -> tuple[list[int], int]:
    """`table[S] = |union of the attacks in S|` for every subset S, plus the
    grand total.

    Computed through the complement: a password is *outside* the union of S
    exactly when its signature is a subset of S's complement. So

        table[S] = total − (number of passwords whose signature ⊆ ~S)

    and the bracketed term for all 2^N subsets at once is the standard
    subset-sum (zeta) transform of `counts` — n·2^N additions.
    """
    size = 1 << n
    z = [0] * size
    for mask, c in counts.items():
        z[mask] += c
    for i in range(n):
        bit = 1 << i
        for m in range(size):
            if m & bit:
                z[m] += z[m ^ bit]

    full = size - 1
    total = z[full]
    return [total - z[full ^ s] for s in range(size)], total


# ── scoring one ordering ────────────────────────────────────────────────────


def _auc(order: tuple[int, ...], table: list[int], cost: list[float]) -> float:
    """Area under the cracked-vs-cost curve. The hot loop — `table` lookups
    only, no set operations."""
    mask = 0
    prev = 0
    auc = 0.0
    for i in order:
        mask |= 1 << i
        cur = table[mask]
        auc += cost[i] * (prev + cur) * 0.5
        prev = cur
    return auc


def _milestones(steps: list[OrderingStep], total: int) -> list[MilestoneStat]:
    """When this ordering crosses each MILESTONE fraction of its own total.

    Interpolates linearly *within* the single attack that crosses the
    milestone, which is the only place the uniform-recovery assumption gets
    used — every other point on the curve is measured. The point is given on
    the ranking's cost axis and, where measured, in guesses and seconds.
    """
    out = []
    for frac in MILESTONES:
        target = frac * total
        if target <= 0:
            out.append(
                MilestoneStat(
                    fraction=frac, target=0, cost=0.0, guesses=0, time_s=0.0, after=None
                )
            )
            continue
        cost = guesses = time_s = None
        after = None
        prev_c, prev_cost, prev_g, prev_t = 0, 0.0, 0, 0.0
        for step in steps:
            if step["cumulative"] >= target:
                span = step["cumulative"] - prev_c
                part = (target - prev_c) / span if span else 1.0
                cost = prev_cost + step["cost"] * part
                if "guesses" in step:
                    guesses = round(prev_g + step["guesses"] * part)
                if "duration_s" in step:
                    time_s = prev_t + step["duration_s"] * part
                after = step["label"]
                break
            prev_c, prev_cost = step["cumulative"], step["cumulative_cost"]
            prev_g = step.get("cumulative_guesses", 0)
            prev_t = step.get("elapsed_s", 0.0)
        out.append(
            MilestoneStat(
                fraction=frac,
                target=int(round(target)),
                cost=cost,
                guesses=guesses,
                time_s=time_s,
                # Which attack is running when the milestone is reached — the
                # actionable half of the number.
                after=after,
            )
        )
    return out


def describe(
    order: tuple[int, ...],
    labels: list[str],
    table: list[int],
    cost: list[float],
    total: int,
    goal_size: int,
    guesses: list[int] | None = None,
    durations: list[float] | None = None,
) -> OrderingSingleRun:
    """One ordering in full: per-step curve, area, efficiency, milestones.

    `cost` is what the ordering is scored against; `guesses` and `durations`
    ride along per step so the result can show both.
    """
    steps: list[OrderingStep] = []
    mask = 0
    prev = 0
    spent = 0.0
    n_guesses = 0
    elapsed = 0.0
    auc = 0.0
    for i in order:
        mask |= 1 << i
        cur = table[mask]
        c = cost[i]
        auc += c * (prev + cur) * 0.5
        spent += c
        step = OrderingStep(
            label=labels[i],
            cost=c,
            cumulative_cost=spent,
            # New passwords this attack contributes *given everything before
            # it* — the number that makes an ordering good or bad.
            gain=cur - prev,
            gain_per_cost=(cur - prev) / c if c > 0 else 0.0,
            cumulative=cur,
            cumulative_coverage=cur / goal_size if goal_size else 0.0,
            cumulative_share=cur / total if total else 0.0,
        )
        if guesses is not None:
            n_guesses += guesses[i]
            step["guesses"] = guesses[i]
            step["cumulative_guesses"] = n_guesses
        if durations is not None:
            elapsed += durations[i]
            step["duration_s"] = durations[i]
            step["elapsed_s"] = elapsed
        steps.append(step)
        prev = cur

    return OrderingSingleRun(
        order=[labels[i] for i in order],
        auc=auc,
        efficiency=auc / (total * spent) if total and spent else 0.0,
        steps=steps,
        milestones=_milestones(steps, total),
    )


def _attach_step_profiles(
    run: OrderingSingleRun,
    recovered: dict[str, set[bytes]],
    crack_buckets: dict[str, dict[bytes, int]],
    crack_bases: dict[str, str] | None,
    buckets: int = PROFILE_BUCKETS,
) -> None:
    """Set each step's order-aware within-attack recovery profile, in place.

    The uniform-accrual assumption `describe` makes is that an attack's *new*
    passwords arrive evenly across its run. This measures them instead, from the
    per-plain crack_pos bucket (worker/hashcat.py::_crack_buckets): walking the
    steps in order and keeping the running union of everything already recovered,
    `profile[j]` is the cumulative count of this attack's cracks that fell in
    bucket ≤ j **and were not already found by an earlier step**.

    That "not already found" is what makes it order-aware — the same attack in a
    later slot shows only what it uniquely adds there, in the keyspace positions
    where it adds them. Because a single-step attack's bucket map covers exactly
    its clean recovered set, `profile[-1]` equals the step's `gain`, so the curve
    lands on the measured node with no rescaling. A step whose attack has no
    bucket map (--increment / no crack_pos) gets None and the UI draws it
    straight, as before.
    """
    seen: set[bytes] = set()
    for step in run["steps"]:
        label = step["label"]
        cb = crack_buckets.get(label)
        if cb is None:
            step["recovery_profile"] = None
            step["recovery_profile_basis"] = None
        else:
            profile = [0] * buckets
            for plain, b in cb.items():
                if plain not in seen:
                    profile[b] += 1
            running = 0
            for i, count in enumerate(profile):
                running += count
                profile[i] = running
            step["recovery_profile"] = profile
            step["recovery_profile_basis"] = (crack_bases or {}).get(label)
        seen |= recovered[label]


def greedy_order(
    n: int, table: list[int], cost: list[float], first: int | None = None
) -> tuple[int, ...]:
    """Take whichever attack adds the most new passwords per guess, repeat.

    The obvious heuristic, computed so the result can say whether exhaustive
    search actually bought anything. Ties break on absolute gain, then on the
    attack's own position, so the answer is deterministic. `first` forces the
    opening attack (used to fill the per-opener "what to run first" table when
    the full set of orderings is not enumerated).
    """
    chosen: list[int] = []
    remaining = list(range(n))
    mask = 0
    prev = 0
    if first is not None:
        chosen.append(first)
        remaining.remove(first)
        mask = 1 << first
        prev = table[mask]
    while remaining:
        best_key = None
        best_i = remaining[0]
        best_cur = prev
        for i in remaining:
            cur = table[mask | (1 << i)]
            gain = cur - prev
            c = cost[i]
            rate = gain / c if c > 0 else (float("inf") if gain > 0 else 0.0)
            key = (rate, gain, -i)
            if best_key is None or key > best_key:
                best_key, best_i, best_cur = key, i, cur
        chosen.append(best_i)
        remaining.remove(best_i)
        mask |= 1 << best_i
        prev = best_cur
    return tuple(chosen)


def beam_search(n: int, table: list[int], cost: list[float], width: int) -> tuple[int, ...]:
    """Near-optimal ordering without enumerating all N!.

    Keeps the `width` best partial sequences at each depth (greedy is width 1,
    full enumeration is unbounded width). Because the future of a partial
    depends only on *which* attacks are already chosen — not their order — nodes
    are deduplicated by their chosen-set bitmask, keeping the lowest-latency path
    to each set, so the beam explores distinct subsets rather than reshuffles of
    the same one.

    Ranking minimises an optimistic min-sum-latency completion:

        key = latency_so_far + (total − covered) · cost_spent

    `latency` is Σ gain·(cost spent before the step + the step's cost / 2), the
    same uniform-accrual model `describe` integrates; at full depth the second
    term is zero and the key equals `total·total_cost − auc`, so minimising it
    maximises the area. The second term penalises a partial that has burned cost
    without covering much — the trap a raw partial-area ranking would fall into.
    """
    full = (1 << n) - 1
    total = table[full]

    def key(latency: float, cov: int, spent: float) -> float:
        return latency + (total - cov) * spent

    # node: (mask, cov, spent, latency, order)
    beam: list[tuple[int, int, float, float, tuple[int, ...]]] = []
    for i in range(n):
        mask = 1 << i
        cov = table[mask]
        latency = cov * (cost[i] * 0.5)
        beam.append((mask, cov, cost[i], latency, (i,)))
    beam.sort(key=lambda nd: key(nd[3], nd[1], nd[2]))
    beam = beam[:width]

    for _ in range(1, n):
        # Best (lowest-latency) path to each reachable chosen-set.
        best_by_mask: dict[int, tuple[int, int, float, float, tuple[int, ...]]] = {}
        for mask, cov, spent, latency, order in beam:
            for j in range(n):
                bit = 1 << j
                if mask & bit:
                    continue
                nmask = mask | bit
                ncov = table[nmask]
                nlat = latency + (ncov - cov) * (spent + cost[j] * 0.5)
                prev = best_by_mask.get(nmask)
                if prev is None or nlat < prev[3]:
                    best_by_mask[nmask] = (nmask, ncov, spent + cost[j], nlat, order + (j,))
        beam = sorted(best_by_mask.values(), key=lambda nd: key(nd[3], nd[1], nd[2]))[:width]

    # Full-set nodes now; lowest key (== highest auc) wins.
    best = min(beam, key=lambda nd: key(nd[3], nd[1], nd[2]))
    return best[4]


# ── the whole analysis ──────────────────────────────────────────────────────


def _cost_axis(
    labels: list[str],
    guesses: dict[str, int | None] | None,
    durations: dict[str, float] | None,
) -> tuple[str, list[float], list[int] | None, list[float] | None]:
    """Pick what the orderings are scored against.

    Guesses when every attack has a count: they belong to the attack, not to
    the machine it ran on. Seconds when any count is missing (hashcat never
    printed a status line) — mixing the two units would rank nonsense. Equal
    weights when there is neither, so the union structure is still described.

    Returns (axis, cost per attack, guesses or None, durations or None).
    """
    g = [(guesses or {}).get(label) for label in labels]
    guess_list = [int(x) for x in g if x is not None and x > 0]
    if len(guess_list) != len(labels):
        guess_list = None
    d = [max(0.0, float((durations or {}).get(label) or 0.0)) for label in labels]
    dur_list = d if sum(d) > 0 else None

    if guess_list is not None:
        return "guesses", [float(x) for x in guess_list], guess_list, dur_list
    if dur_list is not None:
        return "time", list(dur_list), None, dur_list
    return "equal", [1.0] * len(labels), None, None


def summarise(
    recovered: dict[str, set[bytes]],
    goal_size: int,
    *,
    guesses: dict[str, int | None] | None = None,
    durations: dict[str, float] | None = None,
    crack_buckets: dict[str, dict[bytes, int]] | None = None,
    crack_bases: dict[str, str] | None = None,
) -> OrderingResult:
    """Score every ordering of these attacks. The worker's entry point.

    `recovered` maps attack label → the goal entries it recovered (raw bytes,
    as read back from hashcat's outfile); `guesses` maps the same labels to the
    candidates hashcat tried, and `durations` to measured wall-clock seconds.
    Guesses are what gets ranked against — see `_cost_axis`.

    `crack_buckets` (label → {plain: keyspace bucket}, from
    worker/hashcat.py::_crack_buckets) is optional; when given, the best, greedy
    and worst orderings carry an order-aware within-attack recovery profile per
    step — see `_attach_step_profiles`. `crack_bases` labels each attack's x axis
    ("guesses"/"crackpos"). Neither affects scoring.
    """
    labels = list(recovered)
    n = len(labels)
    if n < 2:
        raise OrderingError("an ordering analysis needs at least 2 attacks")
    if n > MAX_ORDER_ATTACKS:
        raise OrderingError(
            f"ordering analysis is capped at {MAX_ORDER_ATTACKS} attacks ({n} given)"
        )

    counts = signature_counts(recovered, labels)
    table, total = union_table(n, counts)

    axis, cost, guess_list, dur_list = _cost_axis(labels, guesses, durations)
    norm = total * sum(cost)

    greedy = greedy_order(n, table, cost)

    # Above EXACT_ENUM_MAX, scoring every one of the N! orderings is infeasible,
    # so beam search finds `best` and the reported spread (distribution, worst,
    # the per-opener table) comes from a random sample plus the beam's own best
    # and a greedy completion of each opener. Below it, the candidate set *is*
    # every permutation and the numbers are exact.
    approximate = n > EXACT_ENUM_MAX
    if approximate:
        beam_best = beam_search(n, table, cost, BEAM_WIDTH)
        rng = random.Random(0)  # deterministic: a re-run must score identically
        base = list(range(n))
        candidates: set[tuple[int, ...]] = set()
        for _ in range(SAMPLE_SIZE):
            rng.shuffle(base)
            candidates.add(tuple(base))
        candidates.add(beam_best)
        candidates.add(greedy)
        candidates.update(greedy_order(n, table, cost, first=i) for i in range(n))
        candidate_iter: object = candidates
    else:
        candidate_iter = permutations(range(n))

    # One pass over the candidate orderings. Only the scalar score is kept per
    # ordering; the full description is rebuilt afterwards for the handful of
    # orderings that are actually reported.
    top: list[tuple[float, tuple[int, ...]]] = []  # min-heap, size TOP_K
    effs: list[float] = []
    worst = (float("inf"), None)
    best_from: list[tuple[float, tuple[int, ...]] | None] = [None] * n

    for order in candidate_iter:  # type: ignore[attr-defined]
        eff = _auc(order, table, cost) / norm if norm else 0.0
        effs.append(eff)

        if len(top) < TOP_K:
            heapq.heappush(top, (eff, order))
        elif eff > top[0][0]:
            heapq.heapreplace(top, (eff, order))

        if eff < worst[0]:
            worst = (eff, order)

        head = order[0]
        if best_from[head] is None or eff > best_from[head][0]:
            best_from[head] = (eff, order)

    ranked = sorted(top, key=lambda p: (-p[0], p[1]))
    best_order = ranked[0][1]

    def detail(o: tuple[int, ...]) -> OrderingSingleRun:
        return describe(o, labels, table, cost, total, goal_size, guess_list, dur_list)

    best = detail(best_order)
    greedy_detail = detail(greedy)
    # If there is only one element, the worst is the best.
    worst_run = detail(worst[1]) if worst[1] is not None else best
    # How many orderings beat greedy — 0 means the heuristic was optimal here.
    greedy_beaten_by = sum(1 for e in effs if e > greedy_detail["efficiency"] + 1e-12)

    # Order-aware within-attack recovery: measured per-step, only for the three
    # orderings the UI draws (each is 3·N·PROFILE_BUCKETS ints). Scoring is done
    # and untouched; this only enriches the step curves. De-dup by identity so a
    # job with a single ordering (worst_run is best) is not processed twice.
    if crack_buckets:
        for run in {id(best): best, id(greedy_detail): greedy_detail,
                    id(worst_run): worst_run}.values():
            _attach_step_profiles(run, recovered, crack_buckets, crack_bases)

    def per_attack(i: int, label: str) -> OrderingAttackResult:
        found = len(recovered[label])
        g = guess_list[i] if guess_list else None
        d = dur_list[i] if dur_list else None
        return OrderingAttackResult(
            label=label,
            recovered=found,
            coverage=found / goal_size if goal_size else 0.0,
            guesses=g,
            # Recovered per guess in isolation: the first-order reason an
            # attack belongs early or late, before overlap is accounted for.
            rate_per_guess=found / g if g else None,
            duration_s=d,
            rate_per_s=found / d if d else None,
            # Passwords only this attack finds. Whatever the ordering, these
            # are not recovered until it runs.
            exclusive=counts.get(1 << i, 0),
        )

    signatures = sorted(
        (
            OrderingSignature(
                labels=[labels[i] for i in range(n) if mask & (1 << i)],
                count=c,
                share=c / total if total else 0.0,
            )
            for mask, c in counts.items()
        ),
        key=lambda s: (-s["count"], len(s["labels"])),
    )[:MAX_SIGNATURES]

    return OrderingResult(
        goal_size=goal_size,
        attacks=[per_attack(i, label) for i, label in enumerate(labels)],
        combined_recovered=total,
        combined_coverage=total / goal_size if goal_size else 0.0,
        cost_axis=axis,
        total_guesses=sum(guess_list) if guess_list else None,
        total_runtime_s=sum(dur_list) if dur_list else None,
        # Exact: N!. Approximate: the beam + sampled orderings actually scored.
        permutations_scored=len(effs),
        # True when `best` is from beam search and the spread is sampled rather
        # than exhaustive — the UI labels the result accordingly.
        approximate=approximate,
        beam_width=BEAM_WIDTH if approximate else None,
        timing_available=dur_list is not None,
        milestone_fractions=list(MILESTONES),
        best=best,
        worst=worst_run,
        greedy={
            **greedy_detail,
            "is_optimal": greedy == best_order or greedy_beaten_by == 0,
            "beaten_by": greedy_beaten_by,
        },
        # Compact ranking — order and milestones only, no per-step curve.
        top=[{k: v for k, v in detail(o).items() if k != "steps"} for _, o in ranked],
        # Best achievable score per opening move: the "what do I run first?"
        # table, and the cheapest thing to act on if you only reorder a bit.
        first_choice=sorted(
            (
                OrderingFirstChoice(
                    label=labels[i],
                    efficiency=best_from[i][0],
                    order=[labels[j] for j in best_from[i][1]],
                )
                for i in range(n)
                if best_from[i] is not None
            ),
            key=lambda e: -e["efficiency"],
        ),
        distribution=_distribution(effs),
        signatures=signatures,
    )


def _distribution(effs: list[float]) -> OrderingDistribution:
    """Histogram of every ordering's score.

    This is what says whether the ranking is worth acting on: a tight spread
    means the order barely matters for these attacks, a wide one means the
    difference between best and worst is real work saved.
    """
    lo, hi = min(effs), max(effs)
    bins = [0] * DIST_BINS
    width = (hi - lo) / DIST_BINS
    for e in effs:
        idx = DIST_BINS - 1 if width <= 0 else min(DIST_BINS - 1, int((e - lo) / width))
        bins[idx] += 1
    return {
        "min": lo,
        "max": hi,
        "mean": sum(effs) / len(effs),
        "bin_min": lo,
        "bin_width": width,
        "bins": bins,
    }
