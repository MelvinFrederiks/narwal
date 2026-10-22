"""Parsing crack_pos and building the per-attack recovery profile — worker/hashcat.py.

hashcat writes `--outfile-format 2,4` lines (`plain:crack_pos`), and the worker
turns the positions into a bounded cumulative recovery curve per attack. Both are
pure functions, so these pin the behaviour down without running hashcat — the
outfile is written by hand.
"""

from __future__ import annotations

from worker import hashcat as hc


def _write(path, lines: list[bytes]):
    path.write_bytes(b"".join(l + b"\n" for l in lines))


# ── _split_crackpos ──────────────────────────────────────────────────────────

def test_split_crackpos_plain_and_position():
    assert hc._split_crackpos(b"password:123") == (b"password", 123)


def test_split_crackpos_plain_containing_colon_keeps_only_last_field():
    # crack_pos is always last, so a plain with its own ':' survives intact.
    assert hc._split_crackpos(b"admin:8080:456") == (b"admin:8080", 456)


def test_split_crackpos_hex_escaped_plain():
    assert hc._split_crackpos(b"$HEX[00ff]:7") == (b"$HEX[00ff]", 7)


def test_split_crackpos_no_position_returns_whole_line():
    # An old plain-only outfile, or a plain that happens to end in ':'.
    assert hc._split_crackpos(b"password") == (b"password", None)
    assert hc._split_crackpos(b"weird:") == (b"weird:", None)
    assert hc._split_crackpos(b"not:anint") == (b"not:anint", None)


# ── _recovery_profile ────────────────────────────────────────────────────────

def test_profile_front_loaded_vs_uniform(tmp_path):
    """Two attacks, same guess total: one finds everything in the first 10% of
    its keyspace, the other spreads cracks evenly. The cumulative profiles show
    the difference — front-loaded saturates early, uniform climbs linearly."""
    k = hc.PROFILE_BUCKETS
    front = tmp_path / "front.out"
    _write(front, [f"w{i}:{i}".encode() for i in range(10)])
    clean = {f"w{i}".encode() for i in range(10)}
    prof, basis = hc._recovery_profile(front, clean, guesses=1000, multistep=False)
    assert basis == "guesses"
    assert prof[-1] == 10                       # every crack counted
    assert prof == sorted(prof)                 # non-decreasing
    assert prof[0] == 10                         # all in the first bucket (pos < 1000/64)

    uniform = tmp_path / "uniform.out"
    # One crack in the middle of each bucket → one more per bucket, cumulatively.
    _write(uniform, [f"u{j}:{int((j + 0.5) * 1000 / k)}".encode() for j in range(k)])
    uclean = {f"u{j}".encode() for j in range(k)}
    uprof, _ = hc._recovery_profile(uniform, uclean, guesses=1000, multistep=False)
    assert uprof == list(range(1, k + 1))


def test_profile_multistep_is_none(tmp_path):
    out = tmp_path / "a.out"
    _write(out, [b"a:1", b"b:2"])
    assert hc._recovery_profile(out, {b"a", b"b"}, guesses=10, multistep=True) == (None, None)


def test_profile_empty_is_none(tmp_path):
    out = tmp_path / "a.out"
    assert hc._recovery_profile(out, set(), guesses=10, multistep=False) == (None, None)


def test_profile_no_crackpos_is_none(tmp_path):
    # An outfile with no positions at all (e.g. pre-feature) yields no profile.
    out = tmp_path / "a.out"
    _write(out, [b"a", b"b"])
    assert hc._recovery_profile(out, {b"a", b"b"}, guesses=10, multistep=False) == (None, None)


def test_profile_falls_back_to_crackpos_basis_without_guesses(tmp_path):
    out = tmp_path / "a.out"
    _write(out, [b"a:10", b"b:20"])
    prof, basis = hc._recovery_profile(out, {b"a", b"b"}, guesses=None, multistep=False)
    assert basis == "crackpos"
    assert prof[-1] == 2


def test_profile_counts_only_clean_cracks(tmp_path):
    # A contaminated plain present in the outfile but absent from `clean` is
    # excluded, so the profile total matches the credited recovered count.
    out = tmp_path / "a.out"
    _write(out, [b"keep:1", b"drop:2", b"keep2:3"])
    prof, _ = hc._recovery_profile(out, {b"keep", b"keep2"}, guesses=100, multistep=False)
    assert prof[-1] == 2


def test_profile_clamps_position_past_denominator(tmp_path):
    # A crack_pos larger than the guess total lands in the last bucket, not out
    # of range.
    out = tmp_path / "a.out"
    _write(out, [b"a:5000"])
    prof, _ = hc._recovery_profile(out, {b"a"}, guesses=1000, multistep=False)
    assert prof[-1] == 1
    assert prof[-2] == 0
