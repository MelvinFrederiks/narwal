"""Narwal FastAPI service entry point.

Serves the static single-page UI from /. Visit http://localhost:7070/.

Every scene parses its input files entirely in the browser. Two small API
routers back optional server-side features: backend/routes/wordlists.py lets
the frontend browse an operator-configured read-only directory of
wordlists/masks files so they don't have to be re-uploaded by hand, and
backend/routes/llm.py proxies the "Expert opinion" tab's queries to an
operator-configured LLM endpoint (keeping its API key server-side). Routers
belong in backend/routes/ and get included in the loop below.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .routes import llm, wordlists

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Narwal", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add `<module>.router` entries here as endpoints are introduced.
for router in (wordlists.router, llm.router):
    app.include_router(router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


_WEB = Path(__file__).resolve().parents[1] / "web"
if _WEB.exists():
    app.mount("/", StaticFiles(directory=str(_WEB), html=True), name="web")
