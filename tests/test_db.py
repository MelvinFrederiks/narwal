"""Job queue semantics — claiming, cancelling, and surviving a dead worker."""

from __future__ import annotations

import threading
import time

import pytest

from backend.jobs import db


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "narwal.db")
    db.init(c)
    yield c
    c.close()


SPEC = {"goal": "g.txt", "attacks": []}


def test_enqueue_then_get(conn):
    job_id = db.enqueue(conn, SPEC, name="nightly")
    job = db.get(conn, job_id)
    assert job["status"] == "queued"
    assert job["name"] == "nightly"
    assert job["spec"] == SPEC
    assert job["result"] is None


def test_claim_returns_oldest_first(conn):
    first = db.enqueue(conn, SPEC, name="first")
    time.sleep(0.01)
    second = db.enqueue(conn, SPEC, name="second")
    assert db.claim(conn, "w1")["id"] == first
    assert db.claim(conn, "w2")["id"] == second
    assert db.claim(conn, "w3") is None


def test_a_job_is_claimed_exactly_once(tmp_path):
    """The core queue guarantee. Two workers on separate connections race for
    one job; exactly one may win."""
    path = tmp_path / "narwal.db"
    setup = db.connect(path)
    db.init(setup)
    job_id = db.enqueue(setup, SPEC)
    setup.close()

    results = []
    barrier = threading.Barrier(8)

    def worker(n: int) -> None:
        c = db.connect(path)
        barrier.wait()
        try:
            results.append(db.claim(c, f"w{n}"))
        finally:
            c.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    winners = [r for r in results if r is not None]
    assert len(winners) == 1
    assert winners[0]["id"] == job_id


def test_complete_stores_the_result(conn):
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    db.complete(conn, job_id, {"combined_coverage": 0.5})
    job = db.get(conn, job_id)
    assert job["status"] == "done"
    assert job["result"]["combined_coverage"] == 0.5
    assert job["finished_at"] is not None


def test_fail_stores_the_error(conn):
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    db.fail(conn, job_id, "hashcat exited 255")
    job = db.get(conn, job_id)
    assert job["status"] == "failed"
    assert "255" in job["error"]


def test_cancelling_a_queued_job_is_immediate(conn):
    job_id = db.enqueue(conn, SPEC)
    assert db.cancel(conn, job_id) == "cancelled"
    assert db.get(conn, job_id)["status"] == "cancelled"
    # ...and it can no longer be claimed.
    assert db.claim(conn, "w1") is None


def test_cancelling_a_running_job_signals_the_worker(conn):
    """A running job can only be stopped by the worker holding it, so cancel
    sets a flag and the worker learns about it on its next heartbeat."""
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    assert db.heartbeat(conn, job_id, {"attack_index": 0}) is True

    assert db.cancel(conn, job_id) == "running"
    assert db.get(conn, job_id)["status"] == "running"
    assert db.heartbeat(conn, job_id, None) is False

    db.finish_cancelled(conn, job_id)
    assert db.get(conn, job_id)["status"] == "cancelled"


def test_cancelling_a_finished_job_does_not_destroy_its_result(conn):
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    db.complete(conn, job_id, {"ok": True})
    assert db.cancel(conn, job_id) == "done"
    assert db.get(conn, job_id)["result"] == {"ok": True}


def test_cancel_unknown_job(conn):
    assert db.cancel(conn, "nope") is None


def test_heartbeat_publishes_progress(conn):
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    db.heartbeat(conn, job_id, {"attack_index": 1, "attack_count": 3})
    assert db.get(conn, job_id)["progress"]["attack_index"] == 1


def test_stale_running_job_is_requeued(conn):
    """A killed worker container must not strand its job forever."""
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    assert db.get(conn, job_id)["status"] == "running"

    assert db.requeue_stale(conn, timeout_s=3600) == 0  # heartbeat is fresh
    assert db.requeue_stale(conn, timeout_s=-1) == 1    # ...now it is not

    job = db.get(conn, job_id)
    assert job["status"] == "queued"
    assert job["worker"] is None
    assert db.claim(conn, "w2")["id"] == job_id


def test_requeue_leaves_finished_jobs_alone(conn):
    job_id = db.enqueue(conn, SPEC)
    db.claim(conn, "w1")
    db.complete(conn, job_id, {"ok": True})
    assert db.requeue_stale(conn, timeout_s=-1) == 0
    assert db.get(conn, job_id)["status"] == "done"


def test_list_jobs_is_newest_first_and_omits_results(conn):
    a = db.enqueue(conn, SPEC, name="a")
    time.sleep(0.01)
    b = db.enqueue(conn, SPEC, name="b")
    db.claim(conn, "w1")
    db.complete(conn, a, {"big": "payload"})

    jobs = db.list_jobs(conn)
    assert [j["id"] for j in jobs] == [b, a]
    assert all(j["result"] is None for j in jobs)
    assert jobs[1]["status"] == "done"
