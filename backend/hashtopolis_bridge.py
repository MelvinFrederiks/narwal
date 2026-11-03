import re
import shlex
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional

try:
    import hashtopolis
except Exception:  # not installed or unconfigured; only the API-backed functions need it
    hashtopolis = None
from fastapi import HTTPException

from backend.jobs.spec import MODES, Attack
from backend.routes.rules import list_files as list_rules
from backend.routes.wordlists import list_files as list_wordlists


@dataclass(frozen=True)
class Pretask:
    id: int
    name: str
    command: str


@dataclass
class Supertask:
    id: int
    name: str
    pretasks: list[Pretask]


def get_supertask_list() -> list[Supertask]:
    # Return a list of supertask info (without the pretasks)
    supertasks = [
        Supertask(id=supertask.id, name=supertask.supertaskName, pretasks=[])
        for supertask in hashtopolis.Supertask.objects.all()
    ]
    return supertasks


def get_supertask_pretasks(supertask: Supertask) -> Supertask:
    # Load pretasks into supertask
    supertask_info = (
        hashtopolis.Supertask.objects.prefetch_related("pretasks").filter(pk=supertask.id).get()
    )
    supertask.pretasks = [
        Pretask(id=pretask.id, name=pretask.taskName, command=pretask.attackCmd)
        for pretask in supertask_info.pretasks_set
    ]
    return supertask


HASHLIST_PLACEHOLDER = "#HL#"
_IGNORED_FLAGS = {"-O", "-S"}  # performance flags, no effect on the candidates
_IGNORED_WITH_VALUE = {"-w"}  # workload profile, takes a value
_VALUE_PATTERN = re.compile(r"^-([awr1-4])(.*)$")


def _tokenize_command(command: str) -> tuple[int, list[tuple[str, str]], list[Path], list[str]]:
    """Split a hashcat command into (mode, charsets, rules, positionals)."""
    tokens = shlex.split(command)
    mode = 0
    charsets: list[tuple[str, str]] = []
    rules: list[Path] = []
    positionals: list[str] = []

    i = 0
    while i < len(tokens):
        token = tokens[i]
        i += 1
        if token == HASHLIST_PLACEHOLDER:
            continue
        if token in _IGNORED_FLAGS:
            continue
        match = _VALUE_PATTERN.match(token) if token.startswith("-") else None
        if not match:
            if token.startswith("-") and len(token) > 1:
                raise ValueError(f"unsupported flag {token} in attack command {command!r}")
            positionals.append(token)
            continue

        flag, attached = match.groups()
        if attached:
            value = attached
        elif i < len(tokens):
            value = tokens[i]
            i += 1
        else:
            raise ValueError(f"flag -{flag} is missing a value in attack command {command!r}")

        if flag == "a":
            try:
                mode = int(value)
            except ValueError:
                raise ValueError(f"invalid attack mode {value!r} in {command!r}") from None
        elif flag == "r":
            rules.append(find_file(value, check=False))
        elif flag in "1234":
            charsets.append((flag, value))
        # -w: value consumed and ignored

    return mode, charsets, rules, positionals


def parse_pretask(pretask: Pretask) -> Attack:
    # Use the attack command to build an Attack
    mode, charsets, rules, positionals = _tokenize_command(pretask.command)

    mode_name = next((name for name, num in MODES.items() if num == mode), None)
    if mode_name is None:
        raise ValueError(f"unsupported attack mode -a {mode} in {pretask.command!r}")

    wordlist: Path | None = None
    mask: str | None = None
    expected = {0: 1, 3: 1, 6: 2, 7: 2}[mode]
    if len(positionals) != expected:
        raise ValueError(
            f"attack mode {mode} expects {expected} positional argument(s), "
            f"got {len(positionals)} in {pretask.command!r}"
        )
    if mode == 0:
        wordlist = find_file(positionals[0], check=False)
    elif mode == 3:
        mask = positionals[0]
    elif mode == 6:
        wordlist, mask = find_file(positionals[0], check=False), positionals[1]
    else:  # 7
        mask, wordlist = positionals[0], find_file(positionals[1], check=False)

    return Attack(
        label=pretask.name,
        mode=mode_name,
        attack_mode=mode,
        wordlist=wordlist,
        rules=tuple(rules),
        mask=mask,
        charsets=tuple(charsets),
    )


def find_file(file: str, check: bool = True, rule: bool = False) -> Optional[Path]:
    # Finds the best match for file, check versioned dicts. With rule=True the file is
    # looked up in the rules directory instead of the wordlist library.
    # This function can be expanded to fit your particular setup, here it is used
    # because there are differences between hashtopolis' file paths and those of corpse.
    if not check:
        # For testing purposes, if check is False, return the path verbatim.
        return Path(file)
    list_files = list_rules if rule else list_wordlists
    # Candidates will be checked 'in order': first candidate is checked first and, if a match/resolution is found,
    # use it greedily even if later matches might have 'better' resolutions.
    candidates = [file]
    # Otherwise, try a versioned name (wordlist.version.dict)
    re_match = re.search(r"^(\w+)\.\d+\.dict", file)
    if re_match:
        candidates.append(re_match.group(1) + ".dict")
    for candidate in candidates:
        try:
            result = list_files(candidate)
            if result.get("enabled"):
                files = result.get("files")
                if files is not None:
                    # Match first.
                    return Path(files[0])
        except HTTPException:
            continue
    return None


def resolve_attack(attack: Attack, unresolved: list[str] | None = None) -> Attack:
    # parse_pretask keeps file names verbatim; this maps them onto files that exist here.
    # A file that cannot be found becomes None (wordlist) or a None entry (rules), and its
    # original name is appended to `unresolved`, since the Attack no longer carries it.
    def lookup(name: Path | None, rule: bool) -> Path | None:
        if name is None:
            return None
        found = find_file(str(name), rule=rule)
        if found is None and unresolved is not None:
            unresolved.append(str(name))
        return found

    return replace(
        attack,
        wordlist=lookup(attack.wordlist, rule=False),
        rules=tuple(lookup(rule, rule=True) for rule in attack.rules),
    )


def get_attacks(supertask: Supertask, unresolved: list[str] | None = None) -> list[Attack]:
    # Takes as input a supertask (without prefetched pretasks), and outputs a list of
    # narwal-compatible attacks. Names of files that could not be found are added to
    # `unresolved` if given.
    supertask = get_supertask_pretasks(supertask)
    return [resolve_attack(parse_pretask(pretask), unresolved) for pretask in supertask.pretasks]
