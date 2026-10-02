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
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from backend import config
from backend.jobs.spec import MODES as MODES_BY_NAME, Attack, JobSpec

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
    # Wall clock for the whole hashcat invocation, goal-file loading included.
    # Loading is a real cost an operator pays, so it belongs in the number the
    # ordering analysis schedules against (backend/jobs/ordering.py).
    duration_s: float = 0.0
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
        "--logfile-disable",       # hashcat.log belongs to the operator, not to us
        # hashcat creates <profile>/<session>.outfiles to watch for cracks
        # found by *other* tools, and adopts whatever it finds there. For a
        # build-from-source hashcat the profile directory is the install
        # directory, so leaving this unset litters the operator's tree.
        #
        # It must point at a directory we never write to. Pointing it at the
        # job workdir — the obvious choice — silently reintroduces exactly the
        # contamination --potfile-disable exists to prevent: our own
        # attack<n>.out files land there, so a later attack reads an earlier
        # attack's recovered plains as already-cracked and skips them. Worse,
        # it only bites attacks that outlive --outfile-check-timer (5s by
        # default), so short attacks look fine and long ones quietly
        # under-report. tests/test_worker_integration.py::
        # test_outfile_check_dir_does_not_leak_between_attacks guards this.
        "--outfile-check-dir", str(_check_dir(outfile.parent)),
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


def _check_dir(workdir: Path) -> Path:
    """An empty directory for --outfile-check-dir, kept that way deliberately.

    hashcat insists on having one and will create it inside its own install if
    we don't say where. This one stays empty for the life of the job, so the
    outfile check never has anything to adopt.
    """
    target = workdir / "outfile-check"
    target.mkdir(parents=True, exist_ok=True)
    return target


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

    # Monotonic, not wall clock: a duration is what the ordering analysis
    # divides by, and a clock step must not be able to make it negative.
    started = time.monotonic()
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
    duration = time.monotonic() - started
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
        duration_s=duration,
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
    """hashcat's version string, or raise.

    Called once at worker start so a missing or unusable binary is reported
    immediately rather than as a failed job much later. Since the worker image
    stopped shipping a hashcat, "missing" is the expected first-run state on a
    machine that has not been configured yet, so the message says what to set.

    The mode-99999 check used to be a build-time assertion in
    worker/Dockerfile. With the binary supplied from outside the image, build
    time is the wrong moment — this is.
    """
    try:
        out = subprocess.run(
            [config.hashcat_bin, "--version"],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as err:
        raise RuntimeError(
            f"cannot run hashcat at {config.hashcat_bin!r}: {err}. "
            f"The worker image does not ship one — set NARWAL_HASHCAT_DIR in .env "
            f"to a hashcat install (it is bind-mounted at /opt/hashcat), or point "
            f"NARWAL_HASHCAT_BIN at a binary directly."
        ) from err
    if out.returncode != 0:
        raise RuntimeError(
            f"`{config.hashcat_bin} --version` exited {out.returncode}: {out.stderr.strip()}"
        )
    version = out.stdout.strip()

    # Mode 99999 is the assumption this entire feature rests on. A hashcat
    # built without it would fail every job for a reason nothing else explains.
    modes = subprocess.run(
        [config.hashcat_bin, "-m", HASH_MODE, "--example-hashes"],
        capture_output=True, text=True, timeout=120,
    )
    if modes.returncode != 0:
        raise RuntimeError(
            f"hashcat {version} at {config.hashcat_bin} has no usable mode "
            f"{HASH_MODE} (Plaintext), which narwal needs to treat the goal "
            f"wordlist as a hash list: {(modes.stderr or modes.stdout).strip()[:300]}"
        )
    return version


def warm_up(spec: JobSpec, workdir: Path, session: str) -> dict[str, float]:
    """Run one throwaway attack per attack mode the job uses.

    hashcat compiles an OpenCL kernel the first time it sees a given (hash
    mode, attack mode) pair and caches it. That compilation is slow — measured
    at ~26s for -a 3 and ~12s for -a 0 on a PoCL CPU runtime — and without this
    it lands inside the measured duration of whichever attack happens to use
    that mode first. For an ordering job that is not a cosmetic problem: the
    per-attack durations are exactly what the ranking schedules against, so a
    contaminated one produces a confidently wrong answer.

    Measured on this host, for the same attack: 29.5s cold against 3.3s warm.

    Each warm-up is a one-line hash file against a one-candidate keyspace, so
    it does no real work; the cost is the compile, which is the point. Once the
    kernel cache is warm (it lives in the hashcat install, which is bind-
    mounted from the host and so survives restarts) a warm-up costs a second or
    two.

    Failures here are deliberately not fatal — a warm-up is an optimisation,
    and the job should still run if one goes wrong. Returns measured warm-up
    seconds per attack mode, for the record kept in the result.
    """
    probe_hash = workdir / "warmup.hash"
    probe_dict = workdir / "warmup.dict"
    probe_hash.write_text("narwal-warmup\n")
    probe_dict.write_text("narwal-warmup\n")

    timings: dict[str, float] = {}
    for mode in dict.fromkeys(a.mode for a in spec.attacks):  # distinct, in order
        argv = [
            config.hashcat_bin,
            "-m", HASH_MODE,
            "-a", str(MODES_BY_NAME[mode]),
            "--potfile-disable", "--restore-disable", "--logfile-disable",
            "--outfile", str(workdir / "warmup.out"),
            "--outfile-format", "2",
            "--outfile-check-dir", str(_check_dir(workdir)),
            "--session", f"{session}-warm-{mode}",
            "--quiet",
        ]
        if config.hashcat_force:
            argv.append("--force")
        argv += config.hashcat_extra
        argv.append(str(probe_hash))
        # The smallest keyspace each mode will accept.
        if mode == "wordlist":
            argv.append(str(probe_dict))
        elif mode == "mask":
            argv.append("?l")
        elif mode == "hybrid-wm":
            argv += [str(probe_dict), "?l"]
        elif mode == "hybrid-mw":
            argv += ["?l", str(probe_dict)]

        started = time.monotonic()
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=900)
            elapsed = time.monotonic() - started
            if done.returncode not in OK_EXITS:
                log.warning(
                    "warm-up for mode %s exited %d (continuing): %s",
                    mode, done.returncode, (done.stderr or done.stdout).strip()[:200],
                )
            timings[mode] = elapsed
            log.info("warmed up attack mode %s in %.1fs", mode, elapsed)
        except (OSError, subprocess.SubprocessError) as err:
            log.warning("warm-up for mode %s failed (continuing): %s", mode, err)

    for leftover in (probe_hash, probe_dict, workdir / "warmup.out"):
        leftover.unlink(missing_ok=True)
    return timings
