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
                         queue), the wakeup FIFO the API uses to nudge the
                         worker, and one subdirectory of hashcat artifacts per
                         job. Defaults to `runs/` at the repo root. Apart from
                         hashcat's own caches under the hashcat install, this
                         is the only path the app writes to.
  NARWAL_RULES_DIR       Directory that a job's rule files must live under.
                         Defaults to the `rules/` directory of whatever hashcat
                         NARWAL_HASHCAT_BIN points at, then to
                         /usr/share/hashcat/rules. Attack wordlists come from
                         NARWAL_WORDLISTS_DIR instead.
  NARWAL_HASHCAT_BIN     hashcat executable. Default `hashcat` (on PATH). The
                         worker image no longer ships one — point this at your
                         own build, which is also how you get attack modes a
                         distribution hashcat does not have. Under Docker the
                         tree is bind-mounted at /opt/hashcat; see
                         docker-compose.yml and .env.example.
  NARWAL_HASHCAT_WARMUP  "0" to skip the pre-measurement warm-up run. On by
                         default, and worth leaving on: hashcat compiles an
                         OpenCL kernel per attack mode on first use, and that
                         one-time cost otherwise lands inside the measured
                         duration of whichever attack happens to use that mode
                         first — which is exactly the number an ordering job
                         schedules against. Measured on this host's PoCL CPU
                         runtime: an -a 3 attack takes 29.5s cold and 3.3s
                         warm.
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
import shutil
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

wordlists_dir = os.environ.get("NARWAL_WORDLISTS_DIR", "").strip()
wordlists_regex = os.environ.get("NARWAL_WORDLISTS_REGEX", "").strip()

wordlists_root: Path | None = Path(wordlists_dir).resolve() if wordlists_dir else None
if wordlists_root is not None and not wordlists_root.is_dir():
    wordlists_root = None

wordlists_pattern: re.Pattern | None = re.compile(wordlists_regex) if wordlists_regex else None


def _default_rules_root() -> Path | None:
    """hashcat's own rules directory: the custom install's first, then the
    distribution location a system hashcat would use."""
    home = hashcat_home()
    candidates = [home / "rules"] if home else []
    candidates.append(Path("/usr/share/hashcat/rules"))
    return next((c for c in candidates if c.is_dir()), None)


rules_dir = os.environ.get("NARWAL_RULES_DIR", "").strip()
rules_root: Path | None = Path(rules_dir).resolve() if rules_dir else _default_rules_root()
if rules_root is not None and not rules_root.is_dir():
    rules_root = None


# ── mergeability job queue ──────────────────────────────────────────────────

runs_dir: Path = Path(os.environ.get("NARWAL_RUNS_DIR", "").strip() or _ROOT / "runs").resolve()

hashcat_bin: str = os.environ.get("NARWAL_HASHCAT_BIN", "").strip() or "hashcat"
hashcat_force: bool = os.environ.get("NARWAL_HASHCAT_FORCE", "").strip() in ("1", "true", "yes")
hashcat_extra: list[str] = shlex.split(os.environ.get("NARWAL_HASHCAT_EXTRA", "").strip())
hashcat_warmup: bool = os.environ.get("NARWAL_HASHCAT_WARMUP", "1").strip() not in (
    "0",
    "false",
    "no",
)


def hashcat_home() -> Path | None:
    """Directory of the hashcat install, resolved through PATH if need be.

    A hashcat built from source keeps its rules, masks and charsets next to the
    binary (and, being a "portable" install, writes its kernel cache there too
    — which is why the bind mount in docker-compose.yml is read-write).
    """
    resolved = shutil.which(hashcat_bin)
    return Path(resolved).resolve().parent if resolved else None


def db_path() -> Path:
    """Path to the SQLite queue. Callers that write must mkdir runs_dir first."""
    return runs_dir / "narwal.db"


def job_dir(job_id: str) -> Path:
    """Per-job artifact directory (hashcat outfiles + logs)."""
    return runs_dir / "jobs" / job_id
