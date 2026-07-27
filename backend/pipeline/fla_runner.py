"""FLA (Fast, Lean, Accurate — Melicher 2016) integration via MAYA.

This module is a subprocess wrapper around the FLA implementation in the
MAYA benchmarking framework (williamcorrias/MAYA-Password-Benchmarking).
We do NOT reimplement Melicher's LSTM — we just orchestrate MAYA's runner.

Lifecycle
---------
1. **One-time corpus conversion**: cleaned `.txt.gz` corpora live in
   `data/clean/`; MAYA expects `.pickle` files containing `set[str]` under
   its own `datasets/<lang>/<service>/` tree. `prepare_corpus()` converts
   on demand and caches a pointer.

2. **Training**: the first time we want FLA guesses for training corpus T,
   MAYA trains an LSTM (~20 epochs by default) and writes a checkpoint to
   `third_party/maya/script/test/<...>/checkpoint20.pt`. This is the
   expensive step — many hours on CPU, much faster on a GPU.

3. **Generation**: `generate_guesses(training_corpus, n_samples)` calls
   MAYA's main.py with the existing checkpoint, gets back a file of
   `<password> <probability>` lines, returns the path.

4. **attack_sim hook**: `attack_sim.simulate(attack)` for `type=fla` reads
   that file, parses out the password column, intersects with the
   reference set, pickles hits to `data/cache/sim/`.

Status
------
The scaffolding is complete and importable. Actual training has NOT been
run — neither in CI nor in any session — because (a) MAYA doesn't ship
pretrained checkpoints, (b) this host has no GPU and 4GB RAM, and (c) the
ref-corpus sim warmup is currently saturating those resources.

To actually run FLA:
  1. Convert one or more training corpora:
        from backend.pipeline import fla_runner
        fla_runner.prepare_corpus("rockyou")
  2. Train (long-running):
        fla_runner.train("rockyou")
  3. Generate:
        path = fla_runner.generate_guesses("rockyou", n_samples=10_000_000)
"""

from __future__ import annotations

import gzip
import logging
import os
import pickle
import shutil
import subprocess
import sys
from pathlib import Path

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_MAYA = _REPO / "third_party" / "maya"
_CLEAN = _REPO / "data" / "clean"
_FLA_CACHE = _REPO / "data" / "cache" / "fla"
_FLA_CACHE.mkdir(parents=True, exist_ok=True)


# Language + service buckets for known corpora — needed because MAYA's
# pickle layout is `datasets/<lang>/<service>/<name>.pickle`.
_CORPUS_BUCKETS = {
    "rockyou":          ("en", "gaming"),
    "linkedin":         ("en", "social-net"),
    "zerozeroowebhost": ("en", "web-hosting"),
    "taobao":           ("zh", "e-commerce"),
    "mailru":           ("ru", "email"),
    "gmail":            ("en", "email"),
    "ashleymadison":    ("en", "dating"),
    "libero":           ("it", "email"),
    "hibp_top10m":      ("en", "guess-list"),
}


def maya_root() -> Path:
    if not _MAYA.exists():
        raise FileNotFoundError(
            f"MAYA not cloned at {_MAYA}. Run: "
            f"git clone https://github.com/williamcorrias/MAYA-Password-Benchmarking {_MAYA}"
        )
    return _MAYA


def pickle_path(corpus: str) -> Path:
    """Where MAYA expects this corpus's pickle."""
    lang, service = _CORPUS_BUCKETS.get(corpus, ("en", "other"))
    return maya_root() / "datasets" / lang / service / f"{corpus}.pickle"


def prepare_corpus(corpus: str) -> Path:
    """Convert data/clean/<corpus>.txt.gz to MAYA's pickle format.

    Idempotent — subsequent calls are no-ops if the pickle is fresh.
    """
    src = _CLEAN / f"{corpus}.txt.gz"
    if not src.exists():
        raise FileNotFoundError(f"cleaned corpus missing: {src}")
    dst = pickle_path(corpus)
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    log.info("fla: converting %s to MAYA pickle format", corpus)
    pwds: set[str] = set()
    with gzip.open(src, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line:
                pwds.add(line)
    tmp = dst.with_suffix(".pickle.tmp")
    with tmp.open("wb") as fh:
        pickle.dump(pwds, fh)
    tmp.replace(dst)
    log.info("fla: wrote %d passwords to %s", len(pwds), dst)
    return dst


def checkpoint_path(corpus: str) -> Path:
    """Where MAYA's FLA checkpoint for this training corpus lives."""
    return maya_root() / "script" / "test" / f"fla__{corpus}" / "checkpoint20.pt"


def train(corpus: str, *, epochs: int = 20, hidden: int = 1000) -> Path:
    """Train FLA on `corpus`. Returns path to the produced checkpoint.

    Costly. Will block for many hours on CPU. The MAYA main.py runner
    handles checkpoint resumption — if the checkpoint already exists, this
    will detect it and return immediately.
    """
    prepare_corpus(corpus)
    ckpt = checkpoint_path(corpus)
    if ckpt.exists():
        log.info("fla: checkpoint already exists at %s", ckpt)
        return ckpt
    cfg = _write_train_config(corpus, epochs=epochs, hidden=hidden)
    log.info("fla: TRAINING %s · this will take many hours on CPU", corpus)
    _run_maya(cfg)
    if not ckpt.exists():
        raise RuntimeError(f"training finished but no checkpoint at {ckpt}")
    return ckpt


def generate_guesses(corpus: str, *, n_samples: int) -> Path:
    """Use an existing checkpoint to produce `n_samples` ranked guesses.

    Returns the path to the file with one `<password> <probability>` line
    per generated guess (in MAYA's standard output format).
    """
    ckpt = checkpoint_path(corpus)
    if not ckpt.exists():
        raise RuntimeError(
            f"FLA checkpoint missing at {ckpt}. Run train('{corpus}') first."
        )
    cfg = _write_generate_config(corpus, n_samples=n_samples)
    _run_maya(cfg)
    out = maya_root() / "results" / f"fla__{corpus}" / f"guesses_{n_samples}.txt.gz"
    if not out.exists():
        raise RuntimeError(f"expected guesses at {out} after MAYA run")
    return out


# ── Subprocess plumbing ──────────────────────────────────────────────────────


def _run_maya(test_config: Path) -> None:
    cmd = [sys.executable, "main.py", "--test_config", str(test_config)]
    log.info("fla: %s (cwd=%s)", " ".join(cmd), maya_root())
    env = {**os.environ, "PYTHONPATH": str(maya_root())}
    proc = subprocess.run(cmd, cwd=str(maya_root()), env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"MAYA exited with status {proc.returncode}")


def _write_train_config(corpus: str, *, epochs: int, hidden: int) -> Path:
    """Write a one-off YAML matching MAYA's test config schema for training."""
    yaml = (
        f"fla_train_{corpus}:\n"
        f"  general_params:\n"
        f"    models: [fla]\n"
        f"    autoload: 0\n"
        f"    n_samples: [10000000]\n"
        f"    overwrite: 1\n"
        f"  pre_split_params:\n"
        f"    standard_preprocessing.read_train_passwords:\n"
        f"      train_datasets: [{corpus}]\n"
        f"      max_length: [12]\n"
        f"  test_params:\n"
        f"    test_datasets: [{corpus}]\n"
        f"  model_overrides:\n"
        f"    fla:\n"
        f"      train:\n"
        f"        epochs: {epochs}\n"
        f"        lstm_hidden_size: {hidden}\n"
    )
    return _write_config(corpus, "train", yaml)


def _write_generate_config(corpus: str, *, n_samples: int) -> Path:
    yaml = (
        f"fla_generate_{corpus}:\n"
        f"  general_params:\n"
        f"    models: [fla]\n"
        f"    autoload: 1\n"
        f"    n_samples: [{n_samples}]\n"
        f"  pre_split_params:\n"
        f"    standard_preprocessing.read_train_passwords:\n"
        f"      train_datasets: [{corpus}]\n"
        f"      max_length: [12]\n"
    )
    return _write_config(corpus, "generate", yaml)


def _write_config(corpus: str, kind: str, yaml: str) -> Path:
    p = _FLA_CACHE / f"{kind}_{corpus}.yaml"
    p.write_text(yaml)
    return p


# ── attack_sim hook ──────────────────────────────────────────────────────────


def stream_candidates(corpus: str, *, n_samples: int = 10_000_000):
    """Generator of guesses for use by attack_sim.

    Reads the file MAYA produced, yields candidate strings (drops the
    probability column).
    """
    path = generate_guesses(corpus, n_samples=n_samples)
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            cand = line.rstrip("\n").rsplit(" ", 1)[0]
            if cand:
                yield cand
