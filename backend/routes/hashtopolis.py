"""Hashtopolis supertasks as ready-made attack lists for the Attack order scene.

The browser can't talk to Hashtopolis, so this exposes the two calls the picker
needs: the supertask names, and one supertask's pretasks parsed into the same
attack shape the builder form holds. Paths go out relative to the wordlist /
rules roots, which is what the form's inputs and job specs use.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from .. import config
from ..hashtopolis_bridge import Supertask, get_attacks, get_supertask_list
from ..jobs.spec import Attack

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/hashtopolis", tags=["hashtopolis"])


def _attack_json(attack: Attack) -> dict:
    wordlist = ""
    if attack.wordlist is not None and config.wordlists_root is not None:
        wordlist = attack.wordlist.relative_to(config.wordlists_root).as_posix()
    rules = [
        r.relative_to(config.rules_root).as_posix()
        for r in attack.rules
        if r is not None and config.rules_root is not None
    ]
    return {
        "label": attack.label,
        "mode": attack.mode,
        "wordlist": wordlist,
        "rules": rules,
        "mask": attack.mask or "",
        "charsets": dict(attack.charsets),
    }


@router.get("/supertasks")
def list_supertasks():
    # Like the file listings: "not available" is an empty list, not an error, so
    # the scene just omits the picker.
    try:
        supertasks = get_supertask_list()
    except Exception as err:
        log.warning("Hashtopolis unavailable, attack picker off: %r", err)
        return {"enabled": False, "supertasks": []}
    return {
        "enabled": True,
        "supertasks": [{"id": st.id, "name": st.name} for st in supertasks],
    }


@router.get("/supertasks/{supertask_id}/attacks")
def supertask_attacks(supertask_id: int):
    unresolved: list[str] = []
    try:
        attacks = get_attacks(Supertask(id=supertask_id, name="", pretasks=[]), unresolved)
    except ValueError as err:
        raise HTTPException(422, str(err)) from err
    except Exception as err:
        raise HTTPException(502, f"could not load supertask from Hashtopolis: {err}") from err
    return {"attacks": [_attack_json(a) for a in attacks], "unresolved": unresolved}
