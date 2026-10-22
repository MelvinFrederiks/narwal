from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import config

router = APIRouter(prefix="/api/rules", tags=["rules"])


def _matches(rel_posix: str, ext: str | tuple[str, ...]) -> bool:
    if ext and not rel_posix.endswith(ext):
        return False
    return True


def _resolve(rel_path: str) -> Path:
    if config.rules_root is None:
        raise HTTPException(404, "rules directory not configured")
    candidate = (config.rules_root / rel_path).resolve()
    if not candidate.is_relative_to(config.rules_root):
        raise HTTPException(400, "invalid path")
    return candidate


@router.get("")
def list_files(ext: str = Query("", description="required filename suffix, e.g. .masks")):
    if config.rules_root is None:
        return {"enabled": False, "files": []}
    files = []
    for p in config.rules_root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(config.rules_root).as_posix()
        if _matches(rel, tuple(ext.split(","))):
            files.append({"path": rel, "size": p.stat().st_size})
    files.sort(key=lambda f: f["path"])
    return {"enabled": True, "files": files}


@router.get("/content")
def get_content(path: str, ext: str = Query("")):
    candidate = _resolve(path)
    rel = candidate.relative_to(config.rules_root).as_posix()
    if not candidate.is_file() or not _matches(rel, ext):
        raise HTTPException(404, "not found")
    return FileResponse(candidate)
