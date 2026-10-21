"""Validation for a job spec — mergeability or attack ordering.

Both kinds describe the same thing (a goal wordlist plus a list of attacks) and
run the same way (each attack once against the full goal list), so they share
one spec, one queue and one worker. `kind` only decides which summary the
worker computes from the recovered sets afterwards. A spec with no `kind` is a
mergeability job, which is what every spec written before ordering existed is.

This is the trust boundary. A job spec arrives as JSON from a browser and ends
up as hashcat's argv, so everything here exists to make sure the only things a
caller can influence are *which* operator-provided files get used and *what
shape* the mask has — never where those files live, and never anything the
shell would interpret.

Three rules do the work:

  · Every path is relative, resolved under a configured root, and rejected if
    it escapes. `Path.resolve()` collapses `..` and follows symlinks before the
    containment check, so neither a traversal nor a symlink planted inside the
    library can point outward. Same check as
    backend/routes/wordlists.py::_resolve, applied to a second root for rules.
  · NARWAL_WORDLISTS_REGEX is enforced here too, not just in the listing
    endpoint — otherwise the regex would only be a UI filter, and a caller who
    guessed a filename could reach a file the operator meant to exclude.
  · Masks are parsed token by token against hashcat's charset alphabet, so a
    mask can never smuggle in an argument.

Validation is stdlib-only and runs in both containers: the API validates to
reject bad input with a 400, and the worker re-validates the stored spec
before running it, because config can change between enqueue and claim (a
wordlist directory gets remounted, a regex gets tightened) and the DB file is
writable by anything with the volume mounted.

Deliberately NOT supported: raw hashcat arguments, absolute paths, and the
`--outfile`/`--potfile`/`--session` flags the worker manages itself.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .. import config
from .ordering import MAX_ORDER_ATTACKS


class SpecError(ValueError):
    """A job spec that must be rejected. Message is safe to show the user."""


# hashcat's built-in mask charsets. `?1`–`?4` are handled separately: they are
# only legal when the spec defines them.
BUILTIN_CHARSETS = set("ludhHsab")
CUSTOM_CHARSETS = set("1234")

MODES = {
    # our name    -> hashcat -a
    "wordlist": 0,   # straight: wordlist, optionally through rules
    "mask": 3,       # brute force over a mask
    "hybrid-wm": 6,  # wordlist + mask appended
    "hybrid-mw": 7,  # mask + wordlist appended
}

# An ordering job scores every permutation of its attacks, so its cap is the
# factorial one from backend/jobs/ordering.py rather than MAX_ATTACKS.
KINDS = ("mergeability", "ordering")
DEFAULT_KIND = "mergeability"

MAX_ATTACKS = 8
MAX_RULES = 4
MAX_MASK_LEN = 256      # hashcat -m 99999 Password.Len.Max
MAX_LABEL_LEN = 60
LABEL_OK = re.compile(r"^[\w .+\-/()]+$")


@dataclass(frozen=True)
class Attack:
    label: str
    mode: str
    attack_mode: int
    wordlist: Path | None = None
    rules: tuple[Path, ...] = ()
    mask: str | None = None
    charsets: tuple[tuple[str, str], ...] = ()
    increment_min: int | None = None
    increment_max: int | None = None
    # This attack's wordlist is flagged as possibly derived from the goal list,
    # so verbatim cracks (the goal word was sitting in the dictionary) are set
    # aside rather than credited. Only ever true for mode "wordlist" — see
    # validate() and worker/hashcat.py. The measurement of what an attack
    # really *guesses* depends on this being honest.
    suspect: bool = False


@dataclass(frozen=True)
class JobSpec:
    goal: Path
    attacks: tuple[Attack, ...] = ()
    max_runtime_s: int | None = None
    kind: str = DEFAULT_KIND
    # Wordlists the caller marked as possibly built from the goal corpus. An
    # attack whose wordlist resolves to one of these is marked `suspect`.
    suspect_wordlists: tuple[Path, ...] = ()


# ── path resolution ─────────────────────────────────────────────────────────

def _resolve_under(root: Path | None, rel: object, what: str) -> Path:
    if root is None:
        raise SpecError(f"no {what} directory is configured on this server")
    if not isinstance(rel, str) or not rel.strip():
        raise SpecError(f"{what} must be a non-empty relative path")
    rel = rel.strip()
    if rel.startswith(("/", "\\")) or (len(rel) > 1 and rel[1] == ":"):
        raise SpecError(f"{what} must be a relative path, got {rel!r}")
    if "\x00" in rel:
        raise SpecError(f"{what} contains a null byte")
    candidate = (root / rel).resolve()
    if not candidate.is_relative_to(root):
        raise SpecError(f"{what} {rel!r} resolves outside the configured directory")
    if not candidate.is_file():
        raise SpecError(f"{what} {rel!r} not found")
    return candidate


def _resolve_corpus(rel: object, what: str) -> Path:
    """A goal list or attack wordlist: under the library root, and matching
    NARWAL_WORDLISTS_REGEX if one is set."""
    path = _resolve_under(config.wordlists_root, rel, what)
    posix = path.relative_to(config.wordlists_root).as_posix()
    if config.wordlists_pattern and not config.wordlists_pattern.search(posix):
        raise SpecError(f"{what} {posix!r} is excluded by the server's wordlist filter")
    return path


def _resolve_rule(rel: object) -> Path:
    """A rule file: hashcat's own rules directory, or the wordlist library."""
    try:
        return _resolve_under(config.rules_root, rel, "rule")
    except SpecError:
        if config.wordlists_root is None:
            raise
        return _resolve_corpus(rel, "rule")


# ── mask parsing ────────────────────────────────────────────────────────────

def _validate_mask(mask: object, defined: set[str], what: str = "mask") -> str:
    """Accept literals and `?X` tokens; reject anything else.

    `??` is hashcat's escape for a literal question mark. A custom `?1`–`?4`
    is only legal when the attack defines that charset, which stops a mask
    from referencing a charset hashcat would then complain about at runtime.
    """
    if not isinstance(mask, str) or not mask:
        raise SpecError(f"{what} must be a non-empty string")
    if len(mask) > MAX_MASK_LEN * 2:
        raise SpecError(f"{what} is too long")
    if "\x00" in mask or "\n" in mask:
        raise SpecError(f"{what} contains a control character")

    i = 0
    length = 0
    while i < len(mask):
        c = mask[i]
        if c != "?":
            i += 1
            length += 1
            continue
        if i + 1 >= len(mask):
            raise SpecError(f"{what} ends with a dangling '?'")
        n = mask[i + 1]
        if n == "?":
            pass
        elif n in BUILTIN_CHARSETS:
            pass
        elif n in CUSTOM_CHARSETS:
            if n not in defined:
                raise SpecError(f"{what} uses ?{n} but no custom charset {n} is defined")
        else:
            raise SpecError(f"{what} has unknown token '?{n}'")
        i += 2
        length += 1
    if length > MAX_MASK_LEN:
        raise SpecError(f"{what} is {length} positions, over hashcat's {MAX_MASK_LEN} limit")
    return mask


def _validate_charsets(raw: object) -> tuple[tuple[str, str], ...]:
    """Custom charsets `{"1": "?l?u", "2": "0123456789"}` for -1..-4.

    A custom charset may itself use built-in `?X` tokens but not another
    custom one — hashcat does not resolve those recursively.
    """
    if raw is None:
        return ()
    if not isinstance(raw, dict):
        raise SpecError("charsets must be an object like {\"1\": \"?l?d\"}")
    out = []
    for key in sorted(str(k) for k in raw):
        if key not in CUSTOM_CHARSETS:
            raise SpecError(f"charset key must be one of 1-4, got {key!r}")
        out.append((key, _validate_mask(raw[key], defined=set(), what=f"charset {key}")))
    return tuple(out)


# ── attacks ─────────────────────────────────────────────────────────────────

def _validate_label(raw: object, index: int) -> str:
    if raw is None or raw == "":
        return f"attack {index + 1}"
    if not isinstance(raw, str):
        raise SpecError("label must be a string")
    label = raw.strip()
    if len(label) > MAX_LABEL_LEN:
        raise SpecError(f"label is over {MAX_LABEL_LEN} characters")
    if not LABEL_OK.match(label):
        raise SpecError(f"label {label!r} has characters outside letters, digits and . + - _ / ( )")
    return label


def _validate_increment(raw: dict) -> tuple[int | None, int | None]:
    lo, hi = raw.get("increment_min"), raw.get("increment_max")
    if lo is None and hi is None:
        return None, None
    for v, n in ((lo, "increment_min"), (hi, "increment_max")):
        if v is not None and (not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= MAX_MASK_LEN):
            raise SpecError(f"{n} must be an integer between 1 and {MAX_MASK_LEN}")
    if lo is not None and hi is not None and lo > hi:
        raise SpecError("increment_min must not exceed increment_max")
    return lo, hi


def _validate_attack(raw: object, index: int, suspect_set: frozenset[Path] = frozenset()) -> Attack:
    if not isinstance(raw, dict):
        raise SpecError(f"attack {index + 1} must be an object")
    mode = raw.get("mode")
    if mode not in MODES:
        raise SpecError(f"attack {index + 1}: mode must be one of {', '.join(sorted(MODES))}")

    label = _validate_label(raw.get("label"), index)
    charsets = _validate_charsets(raw.get("charsets"))
    defined = {k for k, _ in charsets}

    wordlist: Path | None = None
    rules: tuple[Path, ...] = ()
    mask: str | None = None

    if mode in ("wordlist", "hybrid-wm", "hybrid-mw"):
        wordlist = _resolve_corpus(raw.get("wordlist"), "wordlist")
    if mode in ("mask", "hybrid-wm", "hybrid-mw"):
        mask = _validate_mask(raw.get("mask"), defined)
    if mode == "wordlist":
        raw_rules = raw.get("rules") or []
        if not isinstance(raw_rules, list):
            raise SpecError("rules must be a list of rule-file paths")
        if len(raw_rules) > MAX_RULES:
            raise SpecError(f"at most {MAX_RULES} rule files per attack")
        rules = tuple(_resolve_rule(r) for r in raw_rules)
    elif raw.get("rules"):
        raise SpecError(f"attack {index + 1}: rules are only supported for mode 'wordlist'")

    lo, hi = _validate_increment(raw) if mode == "mask" else (None, None)

    # Contamination handling is only well-defined for a straight dictionary
    # attack, where a crack is either the dict word verbatim or a rule applied
    # to it. A hybrid combines the word with a mask, so it can never reproduce a
    # bare goal word anyway — nothing to set aside.
    suspect = mode == "wordlist" and wordlist is not None and wordlist in suspect_set

    return Attack(
        label=label,
        mode=mode,
        attack_mode=MODES[mode],
        wordlist=wordlist,
        rules=rules,
        mask=mask,
        charsets=charsets,
        increment_min=lo,
        increment_max=hi,
        suspect=suspect,
    )


def validate(raw: object) -> JobSpec:
    """Turn untrusted JSON into a JobSpec of resolved, contained paths."""
    if not isinstance(raw, dict):
        raise SpecError("spec must be an object")

    kind = raw.get("kind") or DEFAULT_KIND
    if kind not in KINDS:
        raise SpecError(f"kind must be one of {', '.join(KINDS)}")

    goal = _resolve_corpus(raw.get("goal"), "goal wordlist")

    # Wordlists the caller believes may be derived from the goal. Resolved
    # through the same containment + regex gate as any corpus, so this field is
    # no weaker a trust boundary than `wordlist` itself.
    suspect_raw = raw.get("suspect_wordlists") or []
    if not isinstance(suspect_raw, list):
        raise SpecError("suspect_wordlists must be a list of wordlist paths")
    suspect_paths = tuple(_resolve_corpus(s, "suspect wordlist") for s in suspect_raw)
    suspect_set = frozenset(suspect_paths)

    attacks_raw = raw.get("attacks")
    if not isinstance(attacks_raw, list):
        raise SpecError("attacks must be a list")
    if len(attacks_raw) < 2:
        raise SpecError(
            "an ordering job needs at least 2 attacks to sequence"
            if kind == "ordering"
            else "a mergeability job needs at least 2 attacks to compare"
        )
    limit = min(MAX_ATTACKS, MAX_ORDER_ATTACKS) if kind == "ordering" else MAX_ATTACKS
    if len(attacks_raw) > limit:
        if kind == "ordering" and limit == MAX_ORDER_ATTACKS:
            raise SpecError(
                f"an ordering job scores every permutation of its attacks, so it is "
                f"capped at {limit} ({len(attacks_raw)} given)"
            )
        raise SpecError(f"at most {limit} attacks per job")

    attacks = tuple(_validate_attack(a, i, suspect_set) for i, a in enumerate(attacks_raw))

    labels = [a.label for a in attacks]
    if len(set(labels)) != len(labels):
        raise SpecError("attack labels must be unique")

    runtime = raw.get("max_runtime_s")
    if runtime is not None:
        if not isinstance(runtime, int) or isinstance(runtime, bool) or not 1 <= runtime <= 86_400:
            raise SpecError("max_runtime_s must be an integer between 1 and 86400")

    return JobSpec(
        goal=goal,
        attacks=attacks,
        max_runtime_s=runtime,
        kind=kind,
        suspect_wordlists=suspect_paths,
    )
