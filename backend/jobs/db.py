"""SQLite-backed job queue, shared by the API and the worker over a volume.

Deliberately not Redis/Celery: one GPU host runs one worker, the queue depth
is a handful of jobs, and `sqlite3` is stdlib — which keeps the promise in
CLAUDE.md that the runtime deps are just fastapi and uvicorn. The database
file lives in NARWAL_RUNS_DIR alongside the per-job artifact directories, so
"the queue" and "the results" are one thing to mount, back up, or delete.

Claiming is a single `UPDATE ... RETURNING` statement. SQLite serialises
writers behind one write lock, so two workers racing on it cannot both take
the same row: the second one's subquery re-runs after the first has committed
and sees that job already marked `running`.

Statuses: queued → running → done | failed | cancelled. `cancel_requested` is
a separate flag rather than a status because a running job can only be stopped
by the worker that holds it — the API sets the flag, the worker notices on its
next heartbeat and kills hashcat.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from .. import config

# `UPDATE ... RETURNING` landed in SQLite 3.35. Fail loudly at import rather
# than mysteriously at the first claim.
if sqlite3.sqlite_version_info < (3, 35):
    raise RuntimeError(
        f"narwal's job queue needs SQLite >= 3.35 for UPDATE...RETURNING, "
        f"found {sqlite3.sqlite_version}"
    )

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL,
    spec_json        TEXT NOT NULL,
    result_json      TEXT,
    progress_json    TEXT,
    error            TEXT,
    worker           TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at       REAL NOT NULL,
    claimed_at       REAL,
    finished_at      REAL,
    heartbeat_at     REAL
);
CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs (status, created_at);
"""

ACTIVE = ("queued", "running")
TERMINAL = ("done", "failed", "cancelled")


def connect(path: Path | None = None) -> sqlite3.Connection:
    """Open the queue in autocommit + WAL mode.

    WAL is what lets the API read job status while the worker is mid-write.
    `timeout` covers the brief write-lock contention between the two.
    """
    target = path or config.db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Job row as JSON-ready dict, with the embedded JSON columns expanded."""
    d = dict(row)
    for col, key in (("spec_json", "spec"), ("result_json", "result"), ("progress_json", "progress")):
        raw = d.pop(col, None)
        d[key] = json.loads(raw) if raw else None
    d["cancel_requested"] = bool(d.get("cancel_requested"))
    return d


# ── producer side (API) ─────────────────────────────────────────────────────

def enqueue(conn: sqlite3.Connection, spec: dict, name: str = "") -> str:
    job_id = uuid.uuid4().hex[:16]
    conn.execute(
        "INSERT INTO jobs (id, name, status, spec_json, created_at) VALUES (?, ?, 'queued', ?, ?)",
        (job_id, name, json.dumps(spec), time.time()),
    )
    return job_id


def get(conn: sqlite3.Connection, job_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_jobs(conn: sqlite3.Connection, limit: int = 100) -> list[dict]:
    """Newest first. Omits `result` — a full result can be large, and the list
    view only needs status; callers fetch the result per job."""
    rows = conn.execute(
        "SELECT id, name, status, progress_json, error, worker, cancel_requested,"
        "       created_at, claimed_at, finished_at, heartbeat_at,"
        "       spec_json, NULL AS result_json"
        "  FROM jobs ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def cancel(conn: sqlite3.Connection, job_id: str) -> str | None:
    """Cancel a job. A queued job dies immediately; a running one is flagged
    and the worker stops it at the next heartbeat. Returns the resulting
    status, or None if there is no such job. Already-finished jobs are left
    alone — cancelling a completed job must not destroy its result.
    """
    row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    if row["status"] in TERMINAL:
        return row["status"]
    if row["status"] == "queued":
        conn.execute(
            "UPDATE jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'",
            (time.time(), job_id),
        )
        return "cancelled"
    conn.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
    return "running"


# ── consumer side (worker) ──────────────────────────────────────────────────

def claim(conn: sqlite3.Connection, worker: str) -> dict | None:
    """Atomically take the oldest queued job. None when the queue is empty."""
    now = time.time()
    row = conn.execute(
        "UPDATE jobs SET status='running', worker=?, claimed_at=?, heartbeat_at=?"
        " WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1)"
        " RETURNING *",
        (worker, now, now),
    ).fetchone()
    return _row_to_dict(row) if row else None


def heartbeat(conn: sqlite3.Connection, job_id: str, progress: dict | None = None) -> bool:
    """Mark the job alive and publish live progress.

    Returns True if the worker should keep going, False if it should stop —
    either the job was cancelled, or it was requeued out from under this
    worker after the heartbeat went stale.
    """
    conn.execute(
        "UPDATE jobs SET heartbeat_at=?, progress_json=? WHERE id=? AND status='running'",
        (time.time(), json.dumps(progress) if progress is not None else None, job_id),
    )
    row = conn.execute("SELECT status, cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
    return bool(row) and row["status"] == "running" and not row["cancel_requested"]


def complete(conn: sqlite3.Connection, job_id: str, result: dict) -> None:
    conn.execute(
        "UPDATE jobs SET status='done', result_json=?, progress_json=NULL, finished_at=?"
        " WHERE id=?",
        (json.dumps(result), time.time(), job_id),
    )


def fail(conn: sqlite3.Connection, job_id: str, error: str) -> None:
    conn.execute(
        "UPDATE jobs SET status='failed', error=?, progress_json=NULL, finished_at=? WHERE id=?",
        (error[:8000], time.time(), job_id),
    )


def finish_cancelled(conn: sqlite3.Connection, job_id: str) -> None:
    conn.execute(
        "UPDATE jobs SET status='cancelled', progress_json=NULL, finished_at=? WHERE id=?",
        (time.time(), job_id),
    )


def requeue_stale(conn: sqlite3.Connection, timeout_s: float = 120.0) -> int:
    """Return jobs whose worker stopped heartbeating to the queue.

    Covers a killed or restarted worker container: the job goes back to
    `queued` and the next worker picks it up from the start. Attacks are
    re-run rather than resumed — hashcat restore files would tie a job to one
    worker's filesystem, and a re-run is idempotent.
    """
    cur = conn.execute(
        "UPDATE jobs SET status='queued', worker=NULL, claimed_at=NULL,"
        "                heartbeat_at=NULL, progress_json=NULL"
        " WHERE status='running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?",
        (time.time() - timeout_s,),
    )
    return cur.rowcount or 0
