"""Spec validation — the trust boundary between browser JSON and hashcat argv.

Most of these are containment tests: a job may choose among the operator's
files, and may not reach anything else.
"""

from __future__ import annotations

import re

import pytest

from backend import config
from backend.jobs import spec as spec_mod


@pytest.fixture
def library(tmp_path, monkeypatch):
    """A wordlist library with a secret sitting just outside it."""
    root = tmp_path / "lib"
    (root / "sub").mkdir(parents=True)
    (root / "goal.txt").write_text("password\n")
    (root / "rockyou.txt").write_text("password\n123456\n")
    (root / "sub" / "other.txt").write_text("hunter2\n")

    rules = tmp_path / "rules"
    rules.mkdir()
    (rules / "best64.rule").write_text(":\n")

    (tmp_path / "secret.txt").write_text("do not read me\n")

    monkeypatch.setattr(config, "wordlists_root", root.resolve())
    monkeypatch.setattr(config, "wordlists_pattern", None)
    monkeypatch.setattr(config, "rules_root", rules.resolve())
    return tmp_path


def base_spec(**over) -> dict:
    spec = {
        "goal": "goal.txt",
        "attacks": [
            {"label": "dict", "mode": "wordlist", "wordlist": "rockyou.txt"},
            {"label": "brute", "mode": "mask", "mask": "?l?l?l?l"},
        ],
    }
    spec.update(over)
    return spec


# ── happy path ──────────────────────────────────────────────────────────────

def test_valid_spec_resolves_to_absolute_contained_paths(library):
    out = spec_mod.validate(base_spec())
    assert out.goal == (config.wordlists_root / "goal.txt")
    assert out.attacks[0].attack_mode == 0
    assert out.attacks[1].attack_mode == 3
    assert out.attacks[1].mask == "?l?l?l?l"


def test_rules_resolve_against_the_rules_dir(library):
    out = spec_mod.validate(base_spec(attacks=[
        {"label": "a", "mode": "wordlist", "wordlist": "rockyou.txt", "rules": ["best64.rule"]},
        {"label": "b", "mode": "mask", "mask": "?d?d"},
    ]))
    assert out.attacks[0].rules[0].name == "best64.rule"


def test_hybrid_modes(library):
    out = spec_mod.validate(base_spec(attacks=[
        {"label": "wm", "mode": "hybrid-wm", "wordlist": "rockyou.txt", "mask": "?d?d"},
        {"label": "mw", "mode": "hybrid-mw", "wordlist": "rockyou.txt", "mask": "?d?d"},
    ]))
    assert [a.attack_mode for a in out.attacks] == [6, 7]


def test_custom_charsets(library):
    out = spec_mod.validate(base_spec(attacks=[
        {"label": "a", "mode": "mask", "mask": "?1?1?d", "charsets": {"1": "?l?u"}},
        {"label": "b", "mode": "mask", "mask": "?d?d"},
    ]))
    assert out.attacks[0].charsets == (("1", "?l?u"),)


# ── path containment ────────────────────────────────────────────────────────

@pytest.mark.parametrize("evil", [
    "../secret.txt",
    "sub/../../secret.txt",
    "./../secret.txt",
    "sub/../../../etc/passwd",
])
def test_traversal_out_of_the_library_is_refused(library, evil):
    with pytest.raises(spec_mod.SpecError, match="outside|not found"):
        spec_mod.validate(base_spec(goal=evil))


@pytest.mark.parametrize("evil", ["/etc/passwd", "C:\\Windows\\win.ini", "\\\\host\\share"])
def test_absolute_paths_are_refused(library, evil):
    with pytest.raises(spec_mod.SpecError, match="relative"):
        spec_mod.validate(base_spec(goal=evil))


def test_symlink_escape_is_refused(library):
    """resolve() follows the link before the containment check, so a symlink
    planted inside the library cannot point out of it."""
    link = config.wordlists_root / "escape.txt"
    try:
        link.symlink_to(library / "secret.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not permitted on this platform")
    with pytest.raises(spec_mod.SpecError, match="outside"):
        spec_mod.validate(base_spec(goal="escape.txt"))


def test_wordlist_paths_are_checked_too_not_just_the_goal(library):
    with pytest.raises(spec_mod.SpecError, match="outside|not found"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "wordlist", "wordlist": "../secret.txt"},
            {"label": "b", "mode": "mask", "mask": "?d?d"},
        ]))


def test_rule_paths_are_checked_too(library):
    with pytest.raises(spec_mod.SpecError):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "wordlist", "wordlist": "rockyou.txt",
             "rules": ["../../secret.txt"]},
            {"label": "b", "mode": "mask", "mask": "?d?d"},
        ]))


def test_null_byte_is_refused(library):
    with pytest.raises(spec_mod.SpecError):
        spec_mod.validate(base_spec(goal="goal.txt\x00.png"))


def test_wordlist_regex_is_enforced_not_just_used_for_listing(library, monkeypatch):
    """The operator's filter has to be a real boundary — otherwise guessing a
    filename would reach a file they meant to exclude."""
    monkeypatch.setattr(config, "wordlists_pattern", re.compile(r"^sub/"))
    with pytest.raises(spec_mod.SpecError, match="excluded"):
        spec_mod.validate(base_spec(goal="goal.txt"))
    # ...and the filter applies to attack wordlists as well as the goal.
    with pytest.raises(spec_mod.SpecError, match="excluded"):
        spec_mod.validate(base_spec(goal="sub/other.txt"))
    # Everything inside the filter still works.
    spec_mod.validate(base_spec(goal="sub/other.txt", attacks=[
        {"label": "a", "mode": "wordlist", "wordlist": "sub/other.txt"},
        {"label": "b", "mode": "mask", "mask": "?d?d"},
    ]))


def test_no_library_configured_refuses_everything(library, monkeypatch):
    monkeypatch.setattr(config, "wordlists_root", None)
    with pytest.raises(spec_mod.SpecError, match="no goal wordlist directory"):
        spec_mod.validate(base_spec())


# ── masks ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("mask", ["?l?u?d?s?a?b?h?H", "abc?d", "?d??", "literal"])
def test_valid_masks(library, mask):
    spec_mod.validate(base_spec(attacks=[
        {"label": "a", "mode": "mask", "mask": mask},
        {"label": "b", "mode": "mask", "mask": "?d"},
    ]))


@pytest.mark.parametrize("mask,err", [
    ("?z", "unknown token"),
    ("?d?", "dangling"),
    ("?1?1", "no custom charset"),
    ("", "non-empty"),
    ("?d\n--outfile", "control character"),
])
def test_invalid_masks(library, mask, err):
    with pytest.raises(spec_mod.SpecError, match=err):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "mask", "mask": mask},
            {"label": "b", "mode": "mask", "mask": "?d"},
        ]))


def test_mask_over_hashcats_position_limit(library):
    """300 literal positions — under the cheap byte-length guard, so this
    exercises the actual token count against hashcat's 256 maximum."""
    with pytest.raises(spec_mod.SpecError, match="over hashcat"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "mask", "mask": "a" * 300},
            {"label": "b", "mode": "mask", "mask": "?d"},
        ]))


def test_absurdly_long_mask_is_rejected_before_parsing(library):
    with pytest.raises(spec_mod.SpecError, match="too long"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "mask", "mask": "?l" * 5000},
            {"label": "b", "mode": "mask", "mask": "?d"},
        ]))


# ── shape ───────────────────────────────────────────────────────────────────

def test_at_least_two_attacks(library):
    with pytest.raises(spec_mod.SpecError, match="at least 2"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "mask", "mask": "?d"},
        ]))


def test_too_many_attacks(library):
    attacks = [{"label": f"a{i}", "mode": "mask", "mask": "?d"} for i in range(20)]
    with pytest.raises(spec_mod.SpecError, match="at most"):
        spec_mod.validate(base_spec(attacks=attacks))


def test_duplicate_labels_refused(library):
    """Labels key the recovered-set dict, so duplicates would silently drop an
    attack's results."""
    with pytest.raises(spec_mod.SpecError, match="unique"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "same", "mode": "mask", "mask": "?d"},
            {"label": "same", "mode": "mask", "mask": "?l"},
        ]))


def test_label_charset_is_restricted(library):
    with pytest.raises(spec_mod.SpecError, match="characters outside"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "<script>", "mode": "mask", "mask": "?d"},
            {"label": "b", "mode": "mask", "mask": "?l"},
        ]))


def test_unknown_mode(library):
    with pytest.raises(spec_mod.SpecError, match="mode must be one of"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "raw", "args": ["--help"]},
            {"label": "b", "mode": "mask", "mask": "?d"},
        ]))


def test_rules_rejected_outside_wordlist_mode(library):
    with pytest.raises(spec_mod.SpecError, match="only supported for mode"):
        spec_mod.validate(base_spec(attacks=[
            {"label": "a", "mode": "mask", "mask": "?d", "rules": ["best64.rule"]},
            {"label": "b", "mode": "mask", "mask": "?l"},
        ]))


@pytest.mark.parametrize("bad", [0, -1, 90_000, "600", True])
def test_max_runtime_bounds(library, bad):
    with pytest.raises(spec_mod.SpecError, match="max_runtime_s"):
        spec_mod.validate(base_spec(max_runtime_s=bad))


def test_max_runtime_accepted(library):
    assert spec_mod.validate(base_spec(max_runtime_s=600)).max_runtime_s == 600
