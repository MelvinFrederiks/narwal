"""The FIFO the API uses to nudge the worker out of its sleep.

Nothing here is load-bearing for correctness — a lost notification only costs
latency — so these tests are mostly about the ways it must *not* fail: no
blocking at the wrong moment, no spinning, and no exception escaping into the
request that enqueued the job.
"""

from __future__ import annotations

import os
import threading
import time

import pytest

from backend import config
from backend.jobs import wakeup


@pytest.fixture
def runs(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "runs_dir", tmp_path / "runs")
    return tmp_path / "runs"


def test_ensure_creates_a_fifo(runs):
    import stat
    path = wakeup.ensure()
    assert path is not None
    assert stat.S_ISFIFO(os.stat(path).st_mode)


def test_ensure_is_idempotent(runs):
    assert wakeup.ensure() == wakeup.ensure()


def test_ensure_refuses_a_name_taken_by_a_regular_file(runs):
    """A leftover regular file must not be mistaken for the channel — the
    worker falls back to polling instead."""
    runs.mkdir(parents=True)
    (runs / wakeup.FIFO_NAME).write_text("not a fifo")
    assert wakeup.ensure() is None


def test_notify_then_wait_returns_immediately(runs):
    waiter = wakeup.Waiter(wakeup.ensure())
    try:
        wakeup.notify()
        started = time.monotonic()
        assert waiter.wait(timeout=5) is True
        assert time.monotonic() - started < 1
    finally:
        waiter.close()


def test_wait_times_out_when_nothing_happens(runs):
    waiter = wakeup.Waiter(wakeup.ensure())
    try:
        started = time.monotonic()
        assert waiter.wait(timeout=0.3) is False
        assert time.monotonic() - started >= 0.25
    finally:
        waiter.close()


def test_a_notification_sent_while_busy_is_not_lost(runs):
    """The worker is mid-job when the API enqueues. A FIFO buffers, so the
    wakeup is still there when it next looks — this is what lets the fallback
    timeout be long."""
    waiter = wakeup.Waiter(wakeup.ensure())
    try:
        wakeup.notify()
        time.sleep(0.2)                      # "running a job"
        assert waiter.wait(timeout=5) is True
    finally:
        waiter.close()


def test_repeated_notifications_collapse(runs):
    """Many enqueues, one drain. The second wait must block rather than spin:
    a reader that saw permanent readability would be the busy loop this
    replaces."""
    waiter = wakeup.Waiter(wakeup.ensure())
    try:
        for _ in range(50):
            wakeup.notify()
        assert waiter.wait(timeout=5) is True
        assert waiter.wait(timeout=0.3) is False
    finally:
        waiter.close()


def test_opening_the_waiter_does_not_block_without_a_writer(runs):
    """A FIFO opened read-only blocks until a writer appears, which would hang
    the worker at startup. The Waiter must open read-write to avoid that."""
    done = threading.Event()

    def open_it():
        w = wakeup.Waiter(wakeup.ensure())
        w.close()
        done.set()

    threading.Thread(target=open_it, daemon=True).start()
    assert done.wait(timeout=5), "Waiter blocked on open with no writer present"


def test_notify_is_silent_when_there_is_no_fifo(runs):
    """The API calls this inside a request. It must never raise, whether the
    worker has started yet or not."""
    wakeup.notify()  # nothing created at all


def test_notify_is_silent_when_nobody_is_listening(runs):
    """FIFO exists, worker is down: open() gives ENXIO. Still not an error —
    the job is already in the queue."""
    wakeup.ensure()
    wakeup.notify()


def test_wait_returns_on_an_extra_descriptor(runs):
    """The worker watches its signal pipe alongside the FIFO so SIGTERM cuts
    the sleep short instead of leaving it to be SIGKILLed."""
    waiter = wakeup.Waiter(wakeup.ensure())
    r, w = os.pipe()
    try:
        os.write(w, b"!")
        started = time.monotonic()
        assert waiter.wait(timeout=5, also=(r,)) is True
        assert time.monotonic() - started < 1
    finally:
        waiter.close()
        os.close(r)
        os.close(w)
