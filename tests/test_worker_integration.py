"""End-to-end: enqueue a job, run the worker, check the numbers by hand.

This is the test that proves the central assumption — that `hashcat -m 99999`
turns a plaintext goal list into a set-membership oracle, and that two attacks
run against it stay independent.

Skipped unless hashcat is actually runnable. Point NARWAL_HASHCAT_BIN at it,
and set NARWAL_HASHCAT_FORCE=1 on a host whose only OpenCL device is a PoCL
CPU runtime:

    NARWAL_HASHCAT_BIN=~/hashcat/hashcat/hashcat NARWAL_HASHCAT_FORCE=1 \
        PYTHONPATH=. python3 -m pytest tests/test_worker_integration.py -v
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from backend import config
from backend.jobs import db

pytestmark = pytest.mark.integration


@pytest.fixture
def hashcat_bin(monkeypatch):
    binary = os.environ.get("NARWAL_HASHCAT_BIN") or shutil.which("hashcat")
    if not binary:
        pytest.skip("no hashcat: set NARWAL_HASHCAT_BIN or put it on PATH")
    monkeypatch.setattr(config, "hashcat_bin", binary)
    monkeypatch.setattr(
        config, "hashcat_force",
        os.environ.get("NARWAL_HASHCAT_FORCE", "").strip() in ("1", "true", "yes"),
    )
    monkeypatch.setattr(config, "hashcat_extra", [])

    from worker import hashcat
    try:
        hashcat.probe()
    except Exception as err:  # noqa: BLE001
        pytest.skip(f"hashcat not usable: {err}")
    return binary


# Six goal entries. Attack A finds three, attack B finds three, and they
# share exactly one ("abcdef"), so every index below is checkable by eye.
GOAL = ["password", "hunter2", "qwerty123", "Cafe123", "zzzzzz", "abcdef"]
WL_A = ["password", "hunter2", "abcdef", "notinthegoallist"]
WL_B = ["abcdef", "zzzzzz", "Cafe123"]


@pytest.fixture
def env(tmp_path, monkeypatch, hashcat_bin):
    library = tmp_path / "lib"
    library.mkdir()
    (library / "goal.txt").write_text("\n".join(GOAL) + "\n")
    (library / "wl_a.txt").write_text("\n".join(WL_A) + "\n")
    (library / "wl_b.txt").write_text("\n".join(WL_B) + "\n")

    runs = tmp_path / "runs"
    # Warm-up is an optimisation, not behaviour these tests are about, and it
    # costs a kernel compile per attack mode. One test below turns it back on.
    monkeypatch.setattr(config, "hashcat_warmup", False)
    monkeypatch.setattr(config, "wordlists_root", library.resolve())
    monkeypatch.setattr(config, "wordlists_pattern", None)
    monkeypatch.setattr(config, "rules_root", None)
    monkeypatch.setattr(config, "runs_dir", runs.resolve())
    return tmp_path


SPEC = {
    "goal": "goal.txt",
    "attacks": [
        {"label": "A", "mode": "wordlist", "wordlist": "wl_a.txt"},
        {"label": "B", "mode": "wordlist", "wordlist": "wl_b.txt"},
    ],
}


def test_two_wordlist_attacks_end_to_end(env):
    from worker import main as worker_main

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, SPEC, name="integration")

    assert worker_main.process_one(conn) is True
    job = db.get(conn, job_id)
    assert job["status"] == "done", job["error"]
    r = job["result"]

    # hashcat loaded all six goal lines, none rejected.
    assert r["goal_size"] == 6
    assert r["goal_rejected"] == 0
    assert r["partial"] is False

    by_label = {a["label"]: a for a in r["attacks"]}
    assert by_label["A"]["recovered"] == 3   # password, hunter2, abcdef
    assert by_label["B"]["recovered"] == 3   # abcdef, zzzzzz, Cafe123
    assert by_label["A"]["coverage"] == pytest.approx(0.5)

    pair = r["pairs"][0]
    assert pair["shared"] == 1               # abcdef, and only abcdef
    assert pair["union"] == 5
    assert pair["only_a"] == 2
    assert pair["only_b"] == 2
    assert pair["jaccard"] == pytest.approx(1 / 5)
    assert pair["mergeability"] == pytest.approx(2 / 3)   # (5 - 3) / 3

    assert r["combined_recovered"] == 5
    assert r["combined_coverage"] == pytest.approx(5 / 6)

    # The concrete "what does the second attack add?" answer.
    assert set(pair["sample_only_b"]) == {"zzzzzz", "Cafe123"}

    conn.close()


def test_attacks_do_not_contaminate_each_other(env):
    """The potfile regression guard.

    Both attacks use the *same* wordlist here, so each must independently
    recover the same three entries. If hashcat's potfile were left enabled,
    the second attack would find nothing because the first already "cracked"
    those hashes, and mergeability would read as a perfect 0 for the wrong
    reason.
    """
    from worker import main as worker_main

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, {
        "goal": "goal.txt",
        "attacks": [
            {"label": "first", "mode": "wordlist", "wordlist": "wl_a.txt"},
            {"label": "second", "mode": "wordlist", "wordlist": "wl_a.txt"},
        ],
    })

    worker_main.process_one(conn)
    job = db.get(conn, job_id)
    assert job["status"] == "done", job["error"]
    r = job["result"]

    assert [a["recovered"] for a in r["attacks"]] == [3, 3]
    pair = r["pairs"][0]
    assert pair["shared"] == 3
    assert pair["jaccard"] == 1.0
    assert pair["mergeability"] == 0.0  # identical attacks add nothing
    conn.close()


def test_mask_attack_and_over_length_goal_lines(env):
    """A 300-character goal line is past hashcat's 256 limit for -m 99999. It
    must be reported as rejected rather than silently shrinking the coverage
    denominator."""
    from worker import main as worker_main

    library = config.wordlists_root
    (library / "goal2.txt").write_text(
        "\n".join(GOAL) + "\n" + "a" * 300 + "\n" + "password\n"  # over-length + a duplicate
    )

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, {
        "goal": "goal2.txt",
        "attacks": [
            {"label": "dict", "mode": "wordlist", "wordlist": "wl_a.txt"},
            {"label": "sixlower", "mode": "mask", "mask": "?l?l?l?l?l?l"},
        ],
    })

    worker_main.process_one(conn)
    job = db.get(conn, job_id)
    assert job["status"] == "done", job["error"]
    r = job["result"]

    # 8 raw lines -> 1 rejected for length, 1 duplicate collapsed -> 6 unique.
    assert r["goal_size"] == 6
    assert r["goal_rejected"] == 1

    # The two six-lowercase-letter entries in the goal list: zzzzzz, abcdef.
    by_label = {a["label"]: a for a in r["attacks"]}
    assert by_label["sixlower"]["recovered"] == 2
    conn.close()


def test_cancelling_a_running_job(env, monkeypatch):
    """Cancel must stop hashcat and land the job in `cancelled`, not `failed`."""
    from worker import main as worker_main

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, {
        "goal": "goal.txt",
        "attacks": [
            # Big enough that it cannot finish before the cancel lands.
            {"label": "slow", "mode": "mask", "mask": "?a?a?a?a?a?a?a?a"},
            {"label": "dict", "mode": "wordlist", "wordlist": "wl_a.txt"},
        ],
    })

    real_heartbeat = db.heartbeat
    calls = {"n": 0}

    def cancel_after_a_few(c, jid, progress=None):
        calls["n"] += 1
        if calls["n"] == 3:
            db.cancel(c, jid)
        return real_heartbeat(c, jid, progress)

    monkeypatch.setattr(db, "heartbeat", cancel_after_a_few)

    worker_main.process_one(conn)
    assert db.get(conn, job_id)["status"] == "cancelled"
    conn.close()


def test_ordering_job_end_to_end(env):
    """An ordering job off the same queue and the same hashcat runs.

    Three attacks whose recovered sets are checkable by eye: `dict` finds
    {password, hunter2, abcdef}, `sixlower` finds {zzzzzz, abcdef}, and
    `subset` finds only {abcdef} — which `dict` and `sixlower` both already
    cover, so wherever it lands it contributes nothing.
    """
    from worker import main as worker_main

    library = config.wordlists_root
    (library / "wl_c.txt").write_text("abcdef\n")

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, {
        "kind": "ordering",
        "goal": "goal.txt",
        "attacks": [
            {"label": "dict", "mode": "wordlist", "wordlist": "wl_a.txt"},
            {"label": "sixlower", "mode": "mask", "mask": "?l?l?l?l?l?l"},
            {"label": "subset", "mode": "wordlist", "wordlist": "wl_c.txt"},
        ],
    }, name="ordering integration")

    assert worker_main.process_one(conn) is True
    job = db.get(conn, job_id)
    assert job["status"] == "done", job["error"]
    r = job["result"]

    assert r["kind"] == "ordering"
    assert "pairs" not in r                   # that is the other kind's summary
    assert r["permutations_scored"] == 6      # 3!
    assert r["goal_size"] == 6
    assert r["combined_recovered"] == 4       # password, hunter2, abcdef, zzzzzz

    by_label = {a["label"]: a for a in r["attacks"]}
    assert by_label["dict"]["recovered"] == 3
    assert by_label["sixlower"]["recovered"] == 2
    assert by_label["subset"]["recovered"] == 1
    assert by_label["subset"]["exclusive"] == 0

    # Guess counts came back from hashcat's status lines, exactly, and they
    # are what the ranking used. A plain wordlist costs one guess per line; a
    # mask that cracks only part of the goal runs its whole keyspace.
    assert r["cost_axis"] == "guesses"
    assert by_label["dict"]["guesses"] == len(WL_A)
    assert by_label["subset"]["guesses"] == 1
    assert by_label["sixlower"]["guesses"] == 26**6
    assert r["total_guesses"] == sum(a["guesses"] for a in r["attacks"])

    # Wall-clock timings still come along for display.
    assert r["timing_available"] is True
    assert all(a["duration_s"] > 0 for a in r["attacks"])
    assert r["total_runtime_s"] == pytest.approx(
        sum(a["duration_s"] for a in r["attacks"])
    )

    # The curve is complete and monotonic, and ends on the full haul.
    cumulative = [s["cumulative"] for s in r["best"]["steps"]]
    assert len(cumulative) == 3
    assert cumulative == sorted(cumulative)
    assert cumulative[-1] == 4
    assert r["best"]["steps"][-1]["cumulative_guesses"] == r["total_guesses"]
    assert r["best"]["steps"][-1]["elapsed_s"] == pytest.approx(r["total_runtime_s"])

    # Ranked by guesses, the answer no longer depends on this host's speed:
    # `dict` finds 3 in 4 guesses, the brute force adds the last one, and
    # `subset` — which adds nothing new after `dict` — goes last, where its
    # guess no longer delays anything.
    assert r["best"]["order"] == ["dict", "sixlower", "subset"]
    assert r["best"]["steps"][-1]["cumulative"] == 4
    assert r["best"]["efficiency"] >= r["worst"]["efficiency"]
    assert r["greedy"]["efficiency"] <= r["best"]["efficiency"] + 1e-12
    conn.close()


def test_warm_up_takes_the_kernel_compile_out_of_the_measurement(env, monkeypatch):
    """The reason warm-up exists.

    hashcat compiles an OpenCL kernel the first time it sees a given attack
    mode. Without a warm-up that cost is charged to whichever attack used the
    mode first, and an ordering result reports exactly those durations.
    Here both attacks are the same wordlist against the same goal list, so
    their true costs are identical — any large gap between them is compilation,
    not work.
    """
    from worker import main as worker_main

    monkeypatch.setattr(config, "hashcat_warmup", True)

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, {
        "kind": "ordering",
        "goal": "goal.txt",
        "attacks": [
            {"label": "first", "mode": "wordlist", "wordlist": "wl_a.txt"},
            {"label": "second", "mode": "wordlist", "wordlist": "wl_a.txt"},
        ],
    })

    worker_main.process_one(conn)
    job = db.get(conn, job_id)
    assert job["status"] == "done", job["error"]
    r = job["result"]

    # The warm-up ran, and is reported separately from the measured durations.
    assert "wordlist" in r["warmup_s"]
    assert r["warmup_s"]["wordlist"] > 0

    first, second = (a["duration_s"] for a in r["attacks"])
    assert first == pytest.approx(second, rel=0.6), (
        f"identical attacks measured {first:.1f}s and {second:.1f}s — the first "
        f"one still looks like it absorbed a kernel compile"
    )
    conn.close()


def test_hashcat_writes_nothing_into_the_install_directory(env):
    """The install is the operator's, and is bind-mounted from the host.

    A build-from-source hashcat treats its own directory as the profile
    directory, so without --outfile-check-dir and --logfile-disable it drops a
    <session>.outfiles directory and a hashcat.log in there on every run. Its
    own caches (kernels/, hashcat.dictstat2) are fine and expected.
    """
    import shutil
    from worker import main as worker_main

    install = shutil.which(config.hashcat_bin)
    if install is None:
        pytest.skip("hashcat is not on PATH; nothing to check containment against")
    install_dir = Path(install).resolve().parent
    before = {p.name for p in install_dir.iterdir()}

    conn = db.connect()
    db.init(conn)
    db.enqueue(conn, SPEC)
    worker_main.process_one(conn)
    conn.close()

    new = {p.name for p in install_dir.iterdir()} - before
    stray = {n for n in new if n.endswith(".outfiles") or n == "hashcat.log"}
    assert not stray, f"hashcat littered the operator's install: {sorted(stray)}"


def test_outfile_check_dir_does_not_leak_between_attacks(env):
    """--outfile-check-dir must not see our own outfiles.

    hashcat adopts cracks found in that directory as already-done. If it points
    at the job workdir, attack 2 reads attack 1's `attack0.out` and skips
    everything in it — the same contamination --potfile-disable prevents, just
    through a different door.

    The mask attack here is the one that matters: the check only runs on
    --outfile-check-timer intervals (5s by default), so a sub-second wordlist
    attack never performs one and would pass even while the bug was present.
    `sixlower` runs long enough to check at least once.
    """
    from worker import main as worker_main

    conn = db.connect()
    db.init(conn)
    job_id = db.enqueue(conn, {
        "goal": "goal.txt",
        "attacks": [
            # Runs first and writes abcdef into the workdir...
            {"label": "dict", "mode": "wordlist", "wordlist": "wl_a.txt"},
            # ...which this must still find for itself.
            {"label": "sixlower", "mode": "mask", "mask": "?l?l?l?l?l?l"},
        ],
    })

    worker_main.process_one(conn)
    job = db.get(conn, job_id)
    assert job["status"] == "done", job["error"]

    by_label = {a["label"]: a for a in job["result"]["attacks"]}
    # zzzzzz and abcdef. abcdef is the one `dict` already wrote out.
    assert by_label["sixlower"]["recovered"] == 2
    assert job["result"]["pairs"][0]["shared"] == 1
    conn.close()
