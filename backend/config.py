"""Reads the optional read-only "server wordlists" mount config, plus the
mergeability job-queue settings.

Two knobs, both optional — the "server library" feature is simply absent from
the UI if `NARWAL_WORDLISTS_DIR` is unset or doesn't exist on disk:

  NARWAL_WORDLISTS_DIR   Directory to scan. Under Docker this is the
                         container-side mount point (see docker-compose.yml,
                         which mounts it read-only from `NARWAL_WORDLISTS_DIR`
                         on the host via .env); with bare uvicorn it's just a
                         local path.
  NARWAL_WORDLISTS_REGEX A regex (re.search, matched against each file's path
                         relative to NARWAL_WORDLISTS_DIR using forward
                         slashes) a file must match to be listed. Empty means
                         match everything under the directory. Example:
                         `(hashmob|rockyou)/cleaned/.*` only surfaces files
                         under those two subfolders.

Set both via `.env` at the repo root — see .env.example. `docker compose`
loads `.env` automatically for the `${...}` substitution in
docker-compose.yml; this module loads the same file directly so a bare
`uvicorn` run picks up the same config with no extra setup.

The remaining knobs belong to the mergeability job queue (backend/jobs/,
worker/). Both the API container and the worker container import this module,
so they agree on where the queue lives:

  NARWAL_RUNS_DIR        Read-write directory holding narwal.db (the SQLite
                         queue) and one subdirectory of hashcat artifacts per
                         job. Defaults to `runs/` at the repo root. This is
                         the ONLY path the app writes to.
  NARWAL_RULES_DIR       Directory that a job's rule files must live under.
                         Defaults to hashcat's own /usr/share/hashcat/rules
                         when that exists. Attack wordlists come from
                         NARWAL_WORDLISTS_DIR instead.
  NARWAL_HASHCAT_BIN     hashcat executable. Default `hashcat` (on PATH).
  NARWAL_HASHCAT_FORCE   "1" to pass --force. Needed on hosts whose only
                         OpenCL device is a PoCL CPU runtime that hashcat
                         rejects as outdated — without it hashcat exits with
                         "No devices found/left". Leave unset on a real GPU.
  NARWAL_HASHCAT_EXTRA   Extra hashcat arguments, shell-split, appended to
                         every run (e.g. `-d 1` to pin a device). Operator
                         config only — never reachable from the API.
"""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_ENV_FILE = _ROOT / ".env"


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv(_ENV_FILE)

_dir = os.environ.get("NARWAL_WORDLISTS_DIR", "").strip()
_regex = os.environ.get("NARWAL_WORDLISTS_REGEX", "").strip()

wordlists_root: Path | None = Path(_dir).resolve() if _dir else None
if wordlists_root is not None and not wordlists_root.is_dir():
    wordlists_root = None

wordlists_pattern: re.Pattern | None = re.compile(_regex) if _regex else None

# ── mergeability job queue ──────────────────────────────────────────────────

runs_dir: Path = Path(os.environ.get("NARWAL_RUNS_DIR", "").strip() or _ROOT / "runs").resolve()

_rules = os.environ.get("NARWAL_RULES_DIR", "").strip()
_default_rules = Path("/usr/share/hashcat/rules")
rules_root: Path | None = Path(_rules).resolve() if _rules else _default_rules
if rules_root is not None and not rules_root.is_dir():
    rules_root = None

hashcat_bin: str = os.environ.get("NARWAL_HASHCAT_BIN", "").strip() or "hashcat"
hashcat_force: bool = os.environ.get("NARWAL_HASHCAT_FORCE", "").strip() in ("1", "true", "yes")
hashcat_extra: list[str] = shlex.split(os.environ.get("NARWAL_HASHCAT_EXTRA", "").strip())


def db_path() -> Path:
    """Path to the SQLite queue. Callers that write must mkdir runs_dir first."""
    return runs_dir / "narwal.db"


def job_dir(job_id: str) -> Path:
    """Per-job artifact directory (hashcat outfiles + logs)."""
    return runs_dir / "jobs" / job_id
