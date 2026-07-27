"""Run demeuk over a raw reference corpus, gzip the result into data/clean/.

demeuk is used as a library when importable; falls back to the `demeuk` CLI
otherwise. The cleaned output is cached — re-runs are a no-op unless the raw
file's mtime is newer than the cleaned file's.

See wiki/methodology.md "Reference corpora" for the cleaning rules
(UTF-8 normalise, strip non-printable, dedupe, length filter ≥ 6).
"""

from __future__ import annotations

import gzip
import logging
import shutil
import subprocess
import tempfile
import tomllib
from dataclasses import dataclass
from functools import cache
from pathlib import Path

log = logging.getLogger(__name__)

_BACKEND = Path(__file__).resolve().parents[1]
_REPO = _BACKEND.parent
_DATASETS_TOML = _BACKEND / "config" / "datasets.toml"
_DATA = _REPO / "data"
_RAW = _DATA / "raw"
_CLEAN = _DATA / "clean"


@dataclass(frozen=True)
class CleanResult:
    dataset_id: str
    clean_path: Path
    line_count: int
    cached: bool


@cache
def _registry() -> dict:
    with _DATASETS_TOML.open("rb") as fh:
        return tomllib.load(fh)


def _raw_for(dataset_id: str) -> Path:
    entry = _registry()[dataset_id]
    return _RAW / Path(entry["path"]).name


def _clean_for(dataset_id: str) -> Path:
    return _CLEAN / f"{dataset_id}.txt.gz"


def is_clean_fresh(dataset_id: str) -> bool:
    raw, clean = _raw_for(dataset_id), _clean_for(dataset_id)
    if not clean.exists():
        return False
    if not raw.exists():
        return True
    return clean.stat().st_mtime >= raw.stat().st_mtime


def run(dataset_id: str, *, force: bool = False) -> CleanResult:
    if dataset_id not in _registry():
        raise KeyError(f"unknown dataset id: {dataset_id!r}")

    raw, clean = _raw_for(dataset_id), _clean_for(dataset_id)
    if not raw.exists():
        raise FileNotFoundError(f"raw corpus missing: {raw}")

    if not force and is_clean_fresh(dataset_id):
        line_count = _count_lines(clean)
        return CleanResult(dataset_id, clean, line_count, cached=True)

    _CLEAN.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt") as tmp:
        tmp_path = Path(tmp.name)

    try:
        _run_demeuk(raw, tmp_path)
        line_count = _gzip_into_place(tmp_path, clean)
    finally:
        tmp_path.unlink(missing_ok=True)

    return CleanResult(dataset_id, clean, line_count, cached=False)


def _run_demeuk(raw: Path, out: Path) -> None:
    # demeuk ships as a single-file script `demeuk.py` installed into bin/
    # with a Python shebang. Older Debian packages name it `demeuk`. Try both.
    cli = shutil.which("demeuk") or shutil.which("demeuk.py")
    if cli is None:
        raise RuntimeError(
            "demeuk not found on $PATH (looked for 'demeuk' and 'demeuk.py'); "
            "install it in the container — see wiki/methodology.md 'Reference corpora'"
        )
    log.info("running demeuk via CLI: %s -> %s", raw, out)
    subprocess.run(
        [
            cli,
            "-i", str(raw),
            "-o", str(out),
            "--threads", "all",
            "--check-min-length", "6",
            "--check-controlchar",
        ],
        check=True,
    )


def _gzip_into_place(src: Path, dst: Path) -> int:
    count = 0
    with src.open("rb") as fin, gzip.open(dst, "wb", compresslevel=6) as fout:
        for line in fin:
            fout.write(line)
            count += 1
    return count


def _count_lines(gz_path: Path) -> int:
    count = 0
    with gzip.open(gz_path, "rb") as fh:
        for _ in fh:
            count += 1
    return count
