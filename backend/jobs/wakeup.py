"""A cross-container nudge, so the worker can sleep instead of poll.

The worker used to wake every 2 seconds to ask the queue whether anything had
arrived. That is cheap but not free: `db.claim` is an `UPDATE ... RETURNING`
and `db.requeue_stale` an `UPDATE`, so an idle worker opened a write
transaction twice every two seconds — around 86,000 pointless writes a day,
each of them growing the WAL.

This replaces the sleep with a wait on a FIFO in NARWAL_RUNS_DIR: the API
writes a byte when it enqueues a job, and the worker blocks in `select()` until
that byte shows up. An idle worker then consumes nothing at all, and a queued
job starts immediately rather than up to a poll interval later.

A FIFO rather than a socket or an HTTP call because it is the only option that
is stdlib-only on both sides, needs no listening port, and travels over the
volume the two containers already share — which keeps the promise that the
worker's dependencies are the stdlib plus hashcat.

Two properties make this safe to rely on:

  · **A FIFO buffers.** A notification sent while the worker is busy running a
    job is not lost; it sits in the pipe and the next `wait()` returns at once.
  · **Losing one never loses a job.** `wait()` always has a timeout, so the
    worst case of a missed or undeliverable notification is that the job starts
    a few seconds later instead of instantly. Nothing here is load-bearing for
    correctness — it is purely a latency and idle-cost optimisation, and
    `ensure()` returning None (a filesystem with no FIFO support) simply puts
    the worker back on its old polling loop.
"""

from __future__ import annotations

import errno
import os
import select
import stat
from pathlib import Path

from .. import config

FIFO_NAME = "wakeup.fifo"


def path() -> Path:
    return config.runs_dir / FIFO_NAME


def ensure() -> Path | None:
    """Create the FIFO if it isn't there. None when this filesystem can't.

    Called by the worker at startup. The API never creates it — if the worker
    has not started yet there is nobody to wake, and the worker will find the
    job on its first pass anyway.
    """
    target = path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.mkfifo(target, 0o666)
            # mkfifo honours the umask, and the two containers may not run as
            # the same user; set the mode explicitly so the API can write.
            os.chmod(target, 0o666)
        except FileExistsError:
            pass
        if not stat.S_ISFIFO(os.stat(target).st_mode):
            return None  # something else is sitting on the name
    except OSError:
        return None
    return target


def notify() -> None:
    """Producer side: wake the worker if one is listening. Never raises.

    ENXIO means the FIFO exists but has no reader — the worker is down, or
    mid-restart. That is not an error: the job is already committed to the
    queue, and whoever starts next will claim it.
    """
    try:
        fd = os.open(path(), os.O_WRONLY | os.O_NONBLOCK)
    except OSError:
        return
    try:
        os.write(fd, b"\x01")
    except OSError as err:
        # EAGAIN means the pipe is full, which means a wakeup is already
        # pending and this one would have been redundant.
        if err.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
            pass
    finally:
        os.close(fd)


class Waiter:
    """Consumer side: block until notified, until a signal, or until timeout."""

    def __init__(self, fifo: Path):
        # O_RDWR rather than O_RDONLY, deliberately. Opening a FIFO read-only
        # blocks until some writer appears, which would hang the worker at
        # startup; and a read-only reader gets a permanent EOF-readable fd
        # whenever the last writer closes, which would spin select() at 100%
        # CPU — the exact busy loop this module exists to remove. Holding a
        # writer end ourselves means there is always a writer, so neither
        # happens.
        self._fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)

    def wait(self, timeout: float, also: tuple[int, ...] = ()) -> bool:
        """True if something woke us, False if the timeout expired.

        `also` carries extra file descriptors to watch — the worker passes the
        read end of its signal pipe, so SIGTERM interrupts the wait instead of
        leaving the container to be SIGKILLed when Docker's stop timeout runs
        out partway through a long sleep.
        """
        watched = [self._fd, *also]
        try:
            ready, _, _ = select.select(watched, [], [], timeout)
        except InterruptedError:
            return True
        for fd in ready:
            try:
                os.read(fd, 4096)  # drain; the content carries no meaning
            except OSError:
                pass
        return bool(ready)

    def close(self) -> None:
        try:
            os.close(self._fd)
        except OSError:
            pass
