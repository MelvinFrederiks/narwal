"""Read-only browsing of an operator-configured wordlist/masks directory.

Backs the "or pick from server library" dropdown next to each scene's upload
button, so files already sitting on the host (e.g. cleaned HashMob/RockYou
corpora) don't need to be re-uploaded through the browser. See
backend/config.py for how the directory + regex are configured.

Both endpoints no-op (empty list / 404) when NARWAL_WORDLISTS_DIR isn't set,
so the frontend can treat "not configured" the same as "nothing matched".
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import config

router = APIRouter(prefix="/api/wordlists", tags=["wordlists"])


def _matches(rel_posix: str, ext: str) -> bool:
    if ext and not rel_posix.endswith(ext):
        return False
    if config.wordlists_pattern and not config.wordlists_pattern.search(rel_posix):
        return False
    return True


def _resolve(rel_path: str) -> Path:
    if config.wordlists_root is None:
        raise HTTPException(404, "wordlists directory not configured")
    candidate = (config.wordlists_root / rel_path).resolve()
    if not candidate.is_relative_to(config.wordlists_root):
        raise HTTPException(400, "invalid path")
    return candidate


@router.get("")
def list_files(ext: str = Query("", description="required filename suffix, e.g. .masks")):
    if config.wordlists_root is None:
        return {"enabled": False, "files": []}
    files = []
    for p in config.wordlists_root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(config.wordlists_root).as_posix()
        if _matches(rel, ext):
            files.append({"path": rel, "size": p.stat().st_size})
    files.sort(key=lambda f: f["path"])
    return {"enabled": True, "files": files}


@router.get("/content")
def get_content(path: str, ext: str = Query("")):
    candidate = _resolve(path)
    rel = candidate.relative_to(config.wordlists_root).as_posix()
    if not candidate.is_file() or not _matches(rel, ext):
        raise HTTPException(404, "not found")
    return FileResponse(candidate)
