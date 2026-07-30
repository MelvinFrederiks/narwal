"""Proxy to the optional "Expert opinion" LLM endpoint (see
backend/config.py). The backend is the only thing that ever sees
NARWAL_LLM_API_KEY — the frontend only ever calls this router, never the
configured endpoint directly, so the key never reaches the browser.

Talks the OpenAI-compatible chat-completions shape (`POST {model,
messages:[{role,content}]}` -> `{choices:[{message:{content}}]}`), which
OpenAI itself and most self-hosted servers (Ollama, vLLM, LM Studio, ...)
all speak. Uses the stdlib `urllib` rather than adding an HTTP client
dependency — see pyproject.toml's runtime deps.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config

router = APIRouter(prefix="/api/llm", tags=["llm"])

_TIMEOUT_S = 120


class QueryBody(BaseModel):
    prompt: str


@router.get("/status")
def status():
    return {"enabled": config.llm_endpoint is not None}


@router.post("/query")
def query(body: QueryBody):
    if config.llm_endpoint is None:
        raise HTTPException(404, "LLM endpoint not configured (set NARWAL_LLM_ENDPOINT)")

    payload = {"messages": [{"role": "user", "content": body.prompt}]}
    if config.llm_model:
        payload["model"] = config.llm_model

    headers = {"Content-Type": "application/json"}
    if config.llm_api_key:
        headers["Authorization"] = f"Bearer {config.llm_api_key}"

    req = urllib.request.Request(
        config.llm_endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            resp_body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise HTTPException(502, f"LLM endpoint returned {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise HTTPException(502, f"could not reach LLM endpoint: {e.reason}") from e
    except (TimeoutError, json.JSONDecodeError) as e:
        raise HTTPException(502, f"LLM endpoint request failed: {e}") from e

    try:
        content = resp_body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise HTTPException(
            502, "unexpected response shape from LLM endpoint (expected an OpenAI-style chat completion)"
        ) from e

    return {"content": content}
