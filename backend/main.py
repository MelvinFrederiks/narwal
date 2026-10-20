"""Narwal FastAPI service entry point.

Serves the static single-page UI from /. Visit http://localhost:7070/.

Two kinds of scene, and so two kinds of router:

  · The keyspace, analysis-results and overlap scenes parse their input files
    entirely in the browser. backend/routes/wordlists.py exists only so they
    can browse an optional, operator-configured read-only directory of
    wordlist/masks files instead of re-uploading by hand.
  · The mergeability scene cannot run in a browser — it needs hashcat to
    expand a real keyspace. backend/routes/jobs.py accepts a job, validates
    it, and queues it; the worker container (worker/main.py) does the work and
    writes the result back through the shared NARWAL_RUNS_DIR volume. This
    process never runs hashcat.

Routers belong in backend/routes/ and get included in the loop below.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.routes import rules

from .routes import jobs, wordlists

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Narwal", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add `<module>.router` entries here as endpoints are introduced.
for router in (wordlists.router, rules.router, jobs.router):
    app.include_router(router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


_WEB = Path(__file__).resolve().parents[1] / "web"
if _WEB.exists():
    app.mount("/", StaticFiles(directory=str(_WEB), html=True), name="web")
