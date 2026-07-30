"""Reads optional config from `.env` at the repo root — see .env.example.
`docker compose` loads `.env` automatically for the `${...}` substitution in
docker-compose.yml; this module loads the same file directly so a bare
`uvicorn` run picks up the same config with no extra setup.

Read-only "server wordlists" mount — two knobs, both optional; the feature
is simply absent from the UI if `NARWAL_WORDLISTS_DIR` is unset or doesn't
exist on disk:

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

"Expert opinion" LLM tab — off unless `NARWAL_LLM_ENDPOINT` is set:

  NARWAL_LLM_ENDPOINT    Full URL of an OpenAI-compatible chat-completions
                         endpoint (`POST {model, messages:[{role,content}]}`
                         -> `{choices:[{message:{content}}]}`) — e.g. OpenAI
                         itself, or a self-hosted Ollama/vLLM/LM Studio
                         server exposing that same shape.
  NARWAL_LLM_API_KEY     Optional bearer token sent as `Authorization: Bearer
                         <key>`. Never exposed to the browser — the backend
                         is the only thing that ever sees it (see
                         backend/routes/llm.py).
  NARWAL_LLM_MODEL       Model name sent in the request body. Left out of
                         the request entirely if unset (some self-hosted
                         endpoints default it server-side).
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

llm_endpoint: str | None = os.environ.get("NARWAL_LLM_ENDPOINT", "").strip() or None
llm_api_key: str | None = os.environ.get("NARWAL_LLM_API_KEY", "").strip() or None
llm_model: str | None = os.environ.get("NARWAL_LLM_MODEL", "").strip() or None
