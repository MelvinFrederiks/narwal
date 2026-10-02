"""Job queue API — mergeability and attack-ordering analyses.

Create a job, poll it, read the result. This router never runs hashcat and
never touches a wordlist's contents — it validates the spec, writes a row, and
reads rows back. All the work happens in the worker container (worker/main.py),
which reaches this same queue through the shared NARWAL_RUNS_DIR volume.

That separation is the point: the API image stays a plain slim-Python image
with no GPU runtime, and a job outlives the request that created it, so the
user can close the tab and collect the result later.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from .. import config
from ..jobs import db, ordering, wakeup, spec as spec_mod

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _conn():
    conn = db.connect()
    db.init(conn)
    return conn


@router.get("/config")
def job_config() -> dict:
    """What the job builder needs to render itself.

    `enabled` is false when there is no wordlist library configured — without
    one there is nothing a job could legally reference, so the scene shows a
    setup hint instead of a broken form.
    """
    rules = []
    if config.rules_root is not None:
        rules = sorted(
            p.relative_to(config.rules_root).as_posix()
            for p in config.rules_root.rglob("*.rule")
            if p.is_file()
        )
    return {
        "enabled": config.wordlists_root is not None,
        "modes": sorted(spec_mod.MODES),
        "kinds": list(spec_mod.KINDS),
        "rules": rules,
        "max_attacks": spec_mod.MAX_ATTACKS,
        # An ordering job enumerates every permutation, so its own cap is
        # lower (or equal) and the builder has to know which one applies.
        "max_ordering_attacks": min(spec_mod.MAX_ATTACKS, ordering.MAX_ORDER_ATTACKS),
        "max_rules": spec_mod.MAX_RULES,
    }


@router.post("", status_code=201)
def create_job(payload: dict = Body(...)) -> dict:
    name = str(payload.get("name") or "").strip()[:120]
    try:
        spec_mod.validate(payload.get("spec"))
    except spec_mod.SpecError as err:
        raise HTTPException(400, str(err)) from err

    # The raw spec is stored, not the resolved one: relative paths stay valid
    # across containers with different mount points, and the worker
    # re-validates against its own config before running anything.
    conn = _conn()
    try:
        job_id = db.enqueue(conn, payload["spec"], name=name)
    finally:
        conn.close()

    # Nudge the worker so it starts now instead of on its next housekeeping
    # pass. Best-effort by design: the job is already committed to the queue,
    # and a worker that misses this finds it anyway.
    wakeup.notify()
    return {"id": job_id, "status": "queued"}


@router.get("")
def list_jobs(limit: int = 100) -> dict:
    conn = _conn()
    try:
        return {"jobs": db.list_jobs(conn, limit=max(1, min(limit, 500)))}
    finally:
        conn.close()


@router.get("/{job_id}")
def get_job(job_id: str) -> dict:
    conn = _conn()
    try:
        job = db.get(conn, job_id)
    finally:
        conn.close()
    if job is None:
        raise HTTPException(404, "no such job")
    return job


@router.delete("/{job_id}")
def cancel_job(job_id: str) -> dict:
    conn = _conn()
    try:
        status = db.cancel(conn, job_id)
    finally:
        conn.close()
    if status is None:
        raise HTTPException(404, "no such job")
    return {"id": job_id, "status": status}
