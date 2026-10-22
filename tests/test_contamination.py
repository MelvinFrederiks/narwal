"""Setting aside verbatim dictionary contamination — worker/hashcat.py.

A suspect dictionary may contain goal passwords verbatim, so a "crack" of such a
word is just set membership, not guessing. hashcat's debug file (base word per
crack, one line per crack in outfile order) lets the worker tell a verbatim hit
(base == plain) from a genuine rule derivation (base != plain). These tests pin
that logic down without running hashcat, by writing the two files by hand.
"""

from __future__ import annotations

from types import SimpleNamespace

from worker import hashcat as hc


def _attack(suspect=True, rules=("best64.rule",)):
    # Only the two fields _contaminated reads.
    return SimpleNamespace(suspect=suspect, rules=tuple(rules), label="dict")


def _write(path, lines: list[bytes]):
    path.write_bytes(b"".join(l + b"\n" for l in lines))


def test_verbatim_only_hit_is_set_aside_but_derivations_are_kept(tmp_path):
    """The crux. `secret` is cracked only as itself (base == plain) → set aside.
    `password123` is reachable both as itself *and* via `password12`+rule → kept,
    because the derivation path proves it is not purely a dictionary leak.
    `hello!` is a pure derivation → kept."""
    out = tmp_path / "a.out"
    dbg = tmp_path / "a.debug"
    _write(out, [b"password123", b"secret", b"password123", b"hello!", b"secret"])
    _write(dbg, [b"password123", b"secret", b"password12", b"hello", b"secret"])

    recovered = hc.read_recovered(out)
    contaminated = hc._contaminated(_attack(), recovered, out, dbg, used_debug=True)

    assert contaminated == {b"secret"}
    assert recovered - contaminated == {b"password123", b"hello!"}


def test_no_derivations_means_nothing_set_aside(tmp_path):
    out = tmp_path / "a.out"
    dbg = tmp_path / "a.debug"
    _write(out, [b"password123", b"hello!"])
    _write(dbg, [b"password12", b"hello"])

    recovered = hc.read_recovered(out)
    assert hc._contaminated(_attack(), recovered, out, dbg, used_debug=True) == set()


def test_non_suspect_attack_sets_nothing_aside(tmp_path):
    out = tmp_path / "a.out"
    _write(out, [b"password", b"123456"])
    recovered = hc.read_recovered(out)
    contaminated = hc._contaminated(
        _attack(suspect=False), recovered, out, tmp_path / "none.debug", used_debug=False
    )
    assert contaminated == set()


def test_suspect_without_rules_treats_every_hit_as_verbatim(tmp_path):
    """A no-rule dictionary can only crack words it contains, so on a suspect
    dictionary every hit is verbatim — no debug file is read."""
    out = tmp_path / "a.out"
    _write(out, [b"password", b"123456"])
    recovered = hc.read_recovered(out)
    contaminated = hc._contaminated(
        _attack(rules=()), recovered, out, tmp_path / "none.debug", used_debug=False
    )
    assert contaminated == recovered


def test_mismatched_lengths_fall_back_to_all_verbatim(tmp_path):
    """If the debug and outfile disagree on line count, stay conservative and
    credit nothing from the suspect dictionary rather than risk a leak."""
    out = tmp_path / "a.out"
    dbg = tmp_path / "a.debug"
    _write(out, [b"password123", b"hello!"])
    _write(dbg, [b"password12"])  # short a line

    recovered = hc.read_recovered(out)
    assert hc._contaminated(_attack(), recovered, out, dbg, used_debug=True) == recovered


def test_read_lines_ordered_keeps_duplicates_and_order(tmp_path):
    """read_recovered dedups; the ordered reader must not, or the positional zip
    with the debug file breaks."""
    out = tmp_path / "a.out"
    _write(out, [b"a", b"b", b"a"])
    assert hc._read_lines_ordered(out) == [b"a", b"b", b"a"]
    assert hc._read_lines_ordered(tmp_path / "missing") == []
