"""Narwal FastAPI service entry point.

Routes are split per-scene under backend/routes/. /profile is a coarse
aggregator kept for compatibility with wiki/architecture.md's original
endpoint list.

Static UI is served from /. Visit http://localhost:8080/.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.pipeline import pregenerate
from backend.routes import (
    bridge,
    cluster,
    compose,
    coverage,
    datasets,
    heatmap,
    maya,
    overlap,
    profile,
    verdict,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm the coverage + heatmap + UMAP caches in the background so the
    # first browser hit finds every scene's data already computed.
    pregenerate.warm_all_in_background()
    pregenerate.warm_all_extras_in_background()
    yield


app = FastAPI(title="Narwal", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    coverage.router,
    compose.router,
    overlap.router,
    cluster.router,
    verdict.router,
    heatmap.router,
    datasets.router,
    bridge.router,
    maya.router,
    profile.router,
):
    app.include_router(router)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


_WEB = Path(__file__).resolve().parents[1] / "web"
if _WEB.exists():
    app.mount("/", StaticFiles(directory=str(_WEB), html=True), name="web")
