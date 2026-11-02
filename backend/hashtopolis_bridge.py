import re
from dataclasses import dataclass
from pathlib import Path

import hashtopolis

from backend.jobs.spec import MODES, Attack


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


def parse_pretask(pretask: Pretask) -> Attack:
    # Use the attack command to build an Attack
    mode_regex = r"^.*-a( ?\d).*$"
    mode_match = re.fullmatch(mode_regex, pretask.command)
    if not mode_match:
        raise ValueError(
            f"cannot parse attack command {pretask.command}, expected -a followed by a number"
        )
    mode = int(mode_match.group(1))

    return Attack(
        label=pretask.name,
        mode=next(mode_name for mode_name, mode_int in MODES.items() if mode_int == mode),
        attack_mode=mode,
        wordlist=None,
        rules=(),
        mask="",
        charsets=(),
    )


def find_file(file: str) -> Path:
    # Finds the best match on the corpse installation for the filename.
    # This function can be expanded to fit your particular setup, here it is used
    # because there are differences between hashtopolis' file paths and those of corpse.
    return Path(file)
