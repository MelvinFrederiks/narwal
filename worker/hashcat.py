"""Running one attack with hashcat, and reading back what it recovered.

The trick this whole feature rests on is hashcat's mode 99999, "Plaintext".
The goal wordlist is handed to hashcat *as the hash file*: each line is its own
"hash", and a candidate "cracks" it by being byte-identical. No hashing
happens at all, so hashcat degenerates into a very fast, GPU-parallel
set-membership test over whatever keyspace the attack describes — and the
answer to "which goal entries would this attack find?" is simply the outfile.

Verified against hashcat v7.1.2 (`-m 99999 --example-hashes`):
Password.Len.Max is 256, both pure and optimized kernels exist, and potfile
storage is enabled for the mode — which is why --potfile-disable below is not
optional.

Behaviours worth knowing before changing anything here:

  · Exit code 1 means *exhausted* (the keyspace ran out before every goal
    entry was found), which is the normal outcome for a real analysis. Only
    codes above 1 are errors. Treating a non-zero exit as failure would fail
    essentially every job.
  · Loading the goal file is lossy and silent unless you read the log.
    hashcat drops blank lines, rejects lines over 256 bytes with a "Token
    length exception", then de-duplicates. `Hashes: N digests; M unique
    digests` is the authoritative size of the goal set, and M is what the
    coverage denominator has to be.
  · --potfile-disable keeps the attacks independent. With the potfile on,
    hashcat would skip goal entries a previous attack already cracked and the
    second attack would report a near-zero recovery.
  · --outfile-format 2 writes the plain. hashcat hex-escapes plains it cannot
    write literally, but does so deterministically from the content, so the
    same password encodes identically in every attack's outfile and set
    comparison stays exact. Lines are compared as raw bytes for the same
    reason — real corpora are not valid UTF-8.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from backend import config
from backend.jobs.spec import Attack, JobSpec

log = logging.getLogger(__name__)

HASH_MODE = "99999"  # Plaintext

# hashcat exit codes. 0 and 1 are both successful completions.
EXIT_CRACKED = 0
EXIT_EXHAUSTED = 1
EXIT_ABORTED = 2
EXIT_ABORTED_CHECKPOINT = 3
EXIT_ABORTED_RUNTIME = 4
OK_EXITS = (EXIT_CRACKED, EXIT_EXHAUSTED)
# A runtime/checkpoint abort still produces a valid — but partial — outfile.
PARTIAL_EXITS = (EXIT_ABORTED, EXIT_ABORTED_CHECKPOINT, EXIT_ABORTED_RUNTIME)

_RE_HASHES = re.compile(r"Hashes:\s*(\d+)\s+digests;\s*(\d+)\s+unique digests")
_RE_REJECTED = re.compile(r"Token length exception:\s*(\d+)/(\d+)\s+hashes")


@dataclass
class AttackRun:
    label: str
    argv: list[str]
    exit_code: int
    recovered: set[bytes] = field(default_factory=set)
    goal_loaded: int = 0        # unique digests hashcat actually loaded
    goal_rejected: int = 0      # lines it refused (over-length, malformed)
    partial: bool = False       # stopped early, so `recovered` is a lower bound
    log_path: Path | None = None

    @property
    def ok(self) -> bool:
        return self.exit_code in OK_EXITS or self.partial


def build_argv(spec: JobSpec, attack: Attack, outfile: Path, session: str) -> list[str]:
    """hashcat argv for one attack. Every element is a separate list entry and
    the process is spawned without a shell, so nothing here is ever re-parsed.
    """
    argv = [
        config.hashcat_bin,
        "-m", HASH_MODE,
        "-a", str(attack.attack_mode),
        "--potfile-disable",       # keeps attacks independent — see module docstring
        "--restore-disable",       # no .restore files; a requeued job re-runs clean
        "--outfile", str(outfile),
        "--outfile-format", "2",   # plain only
        "--session", session,
        "--status", "--status-json", "--status-timer", "2",
    ]
    if config.hashcat_force:
        argv.append("--force")
    if spec.max_runtime_s:
        argv += ["--runtime", str(spec.max_runtime_s)]
    for key, chars in attack.charsets:
        argv += [f"-{key}", chars]
    if attack.increment_min is not None or attack.increment_max is not None:
        argv.append("--increment")
        if attack.increment_min is not None:
            argv += ["--increment-min", str(attack.increment_min)]
        if attack.increment_max is not None:
            argv += ["--increment-max", str(attack.increment_max)]
    argv += config.hashcat_extra

    # Positional arguments, in the order each attack mode expects. The goal
    # file is always first — it is the "hash list".
    argv.append(str(spec.goal))
    if attack.mode == "wordlist":
        argv.append(str(attack.wordlist))
        for rule in attack.rules:
            argv += ["-r", str(rule)]
    elif attack.mode == "mask":
        argv.append(attack.mask)
    elif attack.mode == "hybrid-wm":
        argv += [str(attack.wordlist), attack.mask]
    elif attack.mode == "hybrid-mw":
        argv += [attack.mask, str(attack.wordlist)]
    return argv


def read_recovered(outfile: Path) -> set[bytes]:
    """Distinct recovered plains. Missing file means the attack found nothing —
    hashcat does not create an outfile when there are no cracks."""
    if not outfile.exists():
        return set()
    data = outfile.read_bytes()
    return {line for line in data.split(b"\n") if line}


def run_attack(
    spec: JobSpec,
    attack: Attack,
    workdir: Path,
    index: int,
    session: str,
    should_continue: Callable[[dict | None], bool],
) -> AttackRun:
    """Run one attack to completion, streaming progress out as it goes.

    `should_continue` is called with the latest parsed status (or None when
    there is no news) roughly once a second; returning False terminates
    hashcat. That is both the heartbeat and the cancel channel — see
    backend/jobs/db.py::heartbeat.
    """
    outfile = workdir / f"attack{index}.out"
    log_path = workdir / f"attack{index}.log"
    # A requeued job re-runs from scratch; stale artifacts would otherwise be
    # read back as this run's results.
    outfile.unlink(missing_ok=True)

    argv = build_argv(spec, attack, outfile, session)
    log.info("attack %s: %s", attack.label, " ".join(argv))

    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(workdir),
        bufsize=1,
        text=True,
        errors="replace",
    )

    # hashcat can go quiet for a long time while it loads a big wordlist, so
    # the pipe is drained on its own thread; the main loop stays free to
    # heartbeat and to notice a cancellation on time.
    lines: queue.Queue[str | None] = queue.Queue()

    def drain() -> None:
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.put(line)
        finally:
            lines.put(None)

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()

    goal_loaded = goal_rejected = 0
    latest: dict | None = None
    cancelled = False

    with log_path.open("w", encoding="utf-8", errors="replace") as fh:
        done = False
        while not done:
            try:
                line = lines.get(timeout=1.0)
            except queue.Empty:
                if not should_continue(latest):
                    cancelled = True
                    break
                continue
            if line is None:
                done = True
                continue

            fh.write(line)
            stripped = line.strip()

            if stripped.startswith("{"):
                try:
                    status = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                latest = _status_summary(status, attack.label)
                if not should_continue(latest):
                    cancelled = True
                    break
                continue

            if m := _RE_HASHES.search(stripped):
                goal_loaded = int(m.group(2))
            elif m := _RE_REJECTED.search(stripped):
                goal_rejected = int(m.group(1))

    if cancelled:
        _terminate(proc)
    exit_code = proc.wait()
    reader.join(timeout=5)

    partial = cancelled or exit_code in PARTIAL_EXITS
    # A status line reports the loaded goal size too; use it if hashcat exited
    # before the "Hashes:" summary was parsed.
    if not goal_loaded and latest and latest.get("goal_size"):
        goal_loaded = latest["goal_size"]

    return AttackRun(
        label=attack.label,
        argv=argv,
        exit_code=exit_code,
        recovered=read_recovered(outfile),
        goal_loaded=goal_loaded,
        goal_rejected=goal_rejected,
        partial=partial,
        log_path=log_path,
    )


def _status_summary(status: dict, label: str) -> dict:
    """The few fields of hashcat's --status-json the UI actually shows."""
    progress = status.get("progress") or [0, 0]
    recovered = status.get("recovered_hashes") or [0, 0]
    done, total = (progress + [0, 0])[:2]
    return {
        "attack": label,
        "done": done,
        "total": total,
        "fraction": (done / total) if total else 0.0,
        "recovered": recovered[0] if recovered else 0,
        "goal_size": recovered[1] if len(recovered) > 1 else 0,
        "speed": sum(d.get("speed", 0) for d in (status.get("devices") or [])),
        "estimated_stop": status.get("estimated_stop"),
    }


def _terminate(proc: subprocess.Popen) -> None:
    """Ask hashcat to stop, then insist."""
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        log.warning("hashcat ignored SIGTERM, killing")
        proc.kill()


def probe() -> str:
    """hashcat's version string, or raise. Called once at worker start so a
    missing or broken binary is reported immediately rather than as a failed
    job much later."""
    out = subprocess.run(
        [config.hashcat_bin, "--version"],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"`{config.hashcat_bin} --version` exited {out.returncode}: {out.stderr.strip()}")
    return out.stdout.strip()
