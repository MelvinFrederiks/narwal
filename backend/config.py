"""Reads the optional read-only "server wordlists" mount config.

Two knobs, both optional — the feature is simply absent from the UI if
`NARWAL_WORDLISTS_DIR` is unset or doesn't exist on disk:

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
"""

from __future__ import annotations

import os
import re
from pathlib import Path

_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


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
