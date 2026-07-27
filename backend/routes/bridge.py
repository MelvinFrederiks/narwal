"""Hashtopolis bridge.

POST /api/bridge/auth          — IMPLEMENT: ping Hashtopolis REST API, verify key
POST /api/bridge/export        — IMPLEMENT (preview-only): build the supertask
                                 JSON payload Hashtopolis would receive,
                                 plus the URL/headers, with no live call.

See wiki/architecture.md "Hashtopolis bridge".
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter

from backend.models import (
    BridgeAuthRequest,
    BridgeAuthResult,
    TaskChainExportRequest,
    TaskChainExportResult,
)
from backend.pipeline import hashtopolis_payload

router = APIRouter()


@router.post("/api/bridge/auth", response_model=BridgeAuthResult)
async def auth(req: BridgeAuthRequest) -> BridgeAuthResult:
    headers = {"X-API-Key": req.api_key}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{req.base_url.rstrip('/')}/server/version", headers=headers)
    except httpx.HTTPError as exc:
        return BridgeAuthResult(ok=False, detail=f"transport error: {exc}")

    if resp.status_code >= 400:
        return BridgeAuthResult(ok=False, detail=f"HTTP {resp.status_code}")
    try:
        data = resp.json()
    except ValueError:
        return BridgeAuthResult(ok=False, detail="non-JSON response from Hashtopolis")
    return BridgeAuthResult(ok=True, server_version=str(data.get("version", "unknown")))


@router.post("/api/bridge/export", response_model=TaskChainExportResult)
def export_task_chain(req: TaskChainExportRequest) -> TaskChainExportResult:
    built = hashtopolis_payload.build(
        name=req.name,
        pipeline=req.pipeline,
        target=req.target,
        cluster=req.cluster,
    )
    return TaskChainExportResult(
        ok=True,
        request=built["request"],
        payload=built["payload"],
        metadata=built["metadata"],
        detail="preview only — no live POST made",
    )
