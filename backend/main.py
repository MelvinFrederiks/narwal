"""Narwal FastAPI service entry point.

Serves the static single-page UI from /. Visit http://localhost:7070/.

The two current scenes (Keyspace viz, Analysis results) parse their input
files entirely in the browser, so no API routes are needed yet. Routers
belong in backend/routes/ and get included in the loop below.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

app = FastAPI(title="Narwal", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add `<module>.router` entries here as endpoints are introduced.
for router in ():
    app.include_router(router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


_WEB = Path(__file__).resolve().parents[1] / "web"
if _WEB.exists():
    app.mount("/", StaticFiles(directory=str(_WEB), html=True), name="web")
