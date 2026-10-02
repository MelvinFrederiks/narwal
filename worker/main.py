"""Worker loop: claim a job, run its attacks, write the result.

Run it with `python -m worker.main` from the repo root (PYTHONPATH=.), which
is what worker/Dockerfile does. It needs no network — the queue is the SQLite
file on the shared NARWAL_RUNS_DIR volume — but it does need hashcat and a
working OpenCL/CUDA backend.

Each attack in a job is run separately against the full goal list, and the
recovered sets are then compared. Running them separately is the whole point:
the question is what attack B finds that attack A did not, which is only
answerable if B never got to see A's results (see --potfile-disable in
worker/hashcat.py).

Two kinds of job come off the same queue and the hashcat half is identical for
both — only the summary computed from the recovered sets differs:

  · `mergeability` compares every pair (backend/jobs/metrics.py).
  · `ordering` scores every permutation of the attacks by how early in the
    sequence passwords turn up (backend/jobs/ordering.py). It needs no extra
    hashcat work: an attack's recovered set and its runtime do not depend on
    its position, precisely because the potfile is disabled, so N runs are
    enough to score all N! orderings exactly.

Interruption is safe at any point. A job killed mid-run stays `running` with a
heartbeat that goes stale, and db.requeue_stale puts it back on the queue for
a clean re-run. Nothing is resumed — attacks are deterministic, so re-running
is simpler than restore files that would pin a job to one worker's disk.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import time
import uuid

from backend import config
from backend.jobs import db, metrics, ordering
from backend.jobs import spec as spec_mod

from . import hashcat

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("narwal.worker")

POLL_SECONDS = float(os.environ.get("NARWAL_WORKER_POLL", "2"))
STALE_SECONDS = float(os.environ.get("NARWAL_WORKER_STALE", "120"))
SAMPLE_SIZE = 20  # example passwords shown per pair

_stop = False
_HASHCAT_VERSION = "unknown"


class Cancelled(Exception):
    """The job was cancelled through the API while it was running."""


def _handle_signal(signum, _frame) -> None:
    global _stop
    log.info("signal %s received; finishing current attack then exiting", signum)
    _stop = True


def _sample(words: set[bytes], limit: int = SAMPLE_SIZE) -> list[str]:
    """A few example passwords, for the UI. Sorted so the sample is stable
    across re-runs; decoded leniently because corpora are not all UTF-8."""
    return [w.decode("utf-8", "replace") for w in sorted(words)[:limit]]


def _run_attacks(conn, job_id: str, spec: spec_mod.JobSpec) -> list[hashcat.AttackRun]:
    """Run every attack in the spec against the full goal list, in spec order.

    Shared by both job kinds — the sequence the attacks happen to be run in
    here has no bearing on either summary, since each one sees the whole goal
    list and none of them sees another's results.
    """
    workdir = config.job_dir(job_id)
    workdir.mkdir(parents=True, exist_ok=True)

    runs: list[hashcat.AttackRun] = []
    total = len(spec.attacks)

    for index, attack in enumerate(spec.attacks):
        if _stop:
            raise RuntimeError("worker shutting down")

        def should_continue(status: dict | None, _i: int = index) -> bool:
            if _stop:
                return False
            progress = {
                "attack_index": _i,
                "attack_count": total,
                "attack_label": spec.attacks[_i].label,
                "status": status,
            }
            return db.heartbeat(conn, job_id, progress)

        log.info("job %s: attack %d/%d — %s", job_id, index + 1, total, attack.label)
        # The session name is unique per *attempt*, not per (job, attack).
        # hashcat writes a pidfile named after the session and refuses to start
        # if it looks like that session is still running — and a worker killed
        # mid-attack leaves that pidfile behind. Reusing the name would make
        # every requeued job fail with "Already an instance running", which is
        # precisely the case the requeue exists to recover. Restore files are
        # disabled, so nothing needs to find this session again.
        run = hashcat.run_attack(
            spec, attack, workdir, index,
            session=f"narwal-{job_id}-{index}-{uuid.uuid4().hex[:8]}",
            should_continue=should_continue,
        )

        # A stopped run is ambiguous on its own: hashcat's --runtime cap and a
        # user cancellation both end it early. The queue is what distinguishes
        # them — if it says stop, this was a cancellation.
        if not db.heartbeat(conn, job_id, None):
            raise Cancelled(f"cancelled during attack {index + 1}")

        if not run.ok:
            tail = ""
            if run.log_path and run.log_path.exists():
                tail = "\n".join(run.log_path.read_text(errors="replace").splitlines()[-15:])
            raise RuntimeError(
                f"attack {index + 1} ({attack.label}) failed: hashcat exited "
                f"{run.exit_code}\n{tail}"
            )

        runs.append(run)
        log.info(
            "job %s: attack %d/%d recovered %d of %d in %.1fs",
            job_id, index + 1, total, len(run.recovered), run.goal_loaded, run.duration_s,
        )

    return runs


def run_job(conn, job: dict) -> dict:
    job_id = job["id"]
    # Re-validated here, not trusted from the queue: config can change between
    # enqueue and claim, and anything with the volume mounted can write the DB.
    spec = spec_mod.validate(job["spec"])

    started = time.time()
    runs = _run_attacks(conn, job_id, spec)
    recovered = {r.label: r.recovered for r in runs}

    # Every attack read the same goal file, so these should agree; take the
    # max so a run that exited before printing its summary cannot shrink the
    # coverage denominator and inflate every percentage.
    goal_size = max((r.goal_loaded for r in runs), default=0)
    goal_rejected = max((r.goal_rejected for r in runs), default=0)

    if spec.kind == "ordering":
        result = ordering.summarise(
            recovered, {r.label: r.duration_s for r in runs}, goal_size
        )
    else:
        result = metrics.summarise(recovered, goal_size)

    by_label = {r.label: r for r in runs}
    for entry in result["attacks"]:
        run = by_label[entry["label"]]
        attack = next(a for a in spec.attacks if a.label == entry["label"])
        entry.update(
            mode=attack.mode,
            partial=run.partial,
            exit_code=run.exit_code,
            wordlist=attack.wordlist.name if attack.wordlist else None,
            rules=[r.name for r in attack.rules],
            mask=attack.mask,
        )

    # What each side of a pair uniquely contributes — the concrete answer to
    # "what would running the second attack as well actually get me?".
    for pair in result.get("pairs", ()):
        a, b = recovered[pair["a"]], recovered[pair["b"]]
        pair["sample_only_a"] = _sample(a - b)
        pair["sample_only_b"] = _sample(b - a)

    partial = any(r.partial for r in runs)
    result.update(
        kind=spec.kind,
        goal=str(spec.goal.relative_to(config.wordlists_root)),
        goal_rejected=goal_rejected,
        partial=partial,
        max_runtime_s=spec.max_runtime_s,
        hashcat_version=_HASHCAT_VERSION,
        started_at=started,
        finished_at=time.time(),
        duration_s=time.time() - started,
    )
    if partial:
        result["partial_note"] = (
            "At least one attack was stopped before exhausting its keyspace "
            "(max_runtime_s), so its recovered set is a lower bound and the "
            "indices below understate the true overlap."
        )
        if spec.kind == "ordering":
            # Worse here than for mergeability: a capped attack's duration is
            # the cap rather than its real cost, so the ranking is scheduling
            # against a runtime that would not hold in a real run.
            result["partial_note"] += (
                " A capped attack also reports the cap as its duration instead of "
                "what it would really cost, so the ordering below is only valid "
                "for runs under the same cap."
            )
    return result


def process_one(conn) -> bool:
    """Claim and run a single job. True if there was one to do."""
    worker_id = f"{socket.gethostname()}/{os.getpid()}"
    job = db.claim(conn, worker_id)
    if job is None:
        return False

    job_id = job["id"]
    log.info("job %s: claimed (%s)", job_id, job.get("name") or "unnamed")
    try:
        result = run_job(conn, job)
    except Cancelled as err:
        log.info("job %s: %s", job_id, err)
        db.finish_cancelled(conn, job_id)
    except spec_mod.SpecError as err:
        log.warning("job %s: invalid spec — %s", job_id, err)
        db.fail(conn, job_id, f"invalid job spec: {err}")
    except Exception as err:  # noqa: BLE001 — a bad job must not kill the worker
        log.exception("job %s failed", job_id)
        db.fail(conn, job_id, str(err))
    else:
        db.complete(conn, job_id, result)
        extra = ""
        if result.get("kind") == "ordering":
            extra = f" — best order {' → '.join(result['best']['order'])}"
        log.info(
            "job %s: done in %.1fs — combined coverage %.1f%%%s",
            job_id, result["duration_s"], result["combined_coverage"] * 100, extra,
        )
    return True


def main() -> int:
    global _HASHCAT_VERSION
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        _HASHCAT_VERSION = hashcat.probe()
    except Exception as err:  # noqa: BLE001
        log.error("hashcat is not usable: %s", err)
        return 1
    log.info("hashcat %s", _HASHCAT_VERSION)

    if config.wordlists_root is None:
        log.warning(
            "NARWAL_WORDLISTS_DIR is not set — every job will fail validation. "
            "See .env.example."
        )

    conn = db.connect()
    db.init(conn)
    log.info("watching queue at %s", config.db_path())

    while not _stop:
        try:
            if n := db.requeue_stale(conn, STALE_SECONDS):
                log.warning("requeued %d job(s) whose worker went away", n)
            if not process_one(conn):
                time.sleep(POLL_SECONDS)
        except Exception:  # noqa: BLE001 — keep the loop alive through DB blips
            log.exception("worker loop error")
            time.sleep(POLL_SECONDS)

    conn.close()
    log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
