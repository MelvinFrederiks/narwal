"""Subprocess wrapper around `hashcat --stdout`.

hashcat is invoked via $PATH inside the container — we don't link against
libhashcat. Used by the fast-path simulator: generate candidates, intersect
with a reference corpus, treat the hit rate as a prior. See
wiki/architecture.md "Simulation engines".
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

log = logging.getLogger(__name__)


class HashcatMissing(RuntimeError):
    pass


def _binary() -> str:
    path = shutil.which("hashcat")
    if path is None:
        raise HashcatMissing("hashcat not on $PATH (expected inside the dev container)")
    return path


def stream_mask(mask: str, *, limit: int | None = None) -> Iterator[str]:
    cmd = [_binary(), "--stdout", "-a", "3", mask]
    log.debug("hashcat stream_mask: %s", cmd)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        assert proc.stdout is not None
        for i, line in enumerate(proc.stdout):
            if limit is not None and i >= limit:
                break
            yield line.rstrip("\n")
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def stream_wordlist_rules(wordlist: Path, rules: Path, *, limit: int | None = None) -> Iterator[str]:
    cmd = [_binary(), "--stdout", "-a", "0", str(wordlist), "-r", str(rules)]
    log.debug("hashcat stream_wordlist_rules: %s", cmd)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        assert proc.stdout is not None
        for i, line in enumerate(proc.stdout):
            if limit is not None and i >= limit:
                break
            yield line.rstrip("\n")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
