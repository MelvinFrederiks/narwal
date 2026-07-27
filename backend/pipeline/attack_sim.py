"""Attack simulator. Per wiki/architecture.md 'Simulation engines · Fast path':

  hashcat --stdout generates candidates → set-intersect with reference
  plaintexts → cache the hit set per (attack_id, reference_id).

Downstream consumers:
  - Scene 4 (Overlap): Jaccard between two attacks' hit sets on the same ref.
  - Scene 2 (Composer): expected per-step yield against a chosen ref.
  - Scene 6 (Verdict): the candidate chain's projected total yield.

The cache is the only thing that makes this performant. First call per
(attack, ref) is slow (10 s – minutes); subsequent calls are an mmap-fast
pickle load. Cache invalidates if the cleaned corpus's mtime moves.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import pickle
import subprocess
import tempfile
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from backend.models import AttackDef

log = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "backend"
_DATA = _REPO / "data"
_CLEAN = _DATA / "clean"
_CACHE = _DATA / "cache" / "sim"
_CACHE.mkdir(parents=True, exist_ok=True)

# Cap on how many candidates we accept from hashcat per attack — protects
# against runaway mask attacks like ?a?a?a?a?a?a?a (7e13 candidates).
_MAX_CANDIDATES = 200_000_000

# Cap on per-attack walltime in seconds. Beyond this, treat as out-of-scope.
_TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class SimResult:
    attack_id: str
    reference: str
    hit_count: int
    candidate_count: int
    seconds: float


def _hits_path(attack_id: str, reference: str) -> Path:
    return _CACHE / f"{attack_id}__{reference}.pkl"


def _meta_path(attack_id: str, reference: str) -> Path:
    return _CACHE / f"{attack_id}__{reference}.meta.json"


def _clean_path(reference: str) -> Path:
    return _CLEAN / f"{reference}.txt.gz"


# ── Reference plaintext access ────────────────────────────────────────────────
#
# We never materialize the full reference as `frozenset[str]` — for big leaks
# like LinkedIn (60.9M unique passwords) that needs ~5 GB resident and used
# to swap-thrash even when RAM was technically sufficient. Instead:
#
#   _iter_reference(ref)      → yield plaintexts one-at-a-time from gzip
#   reference_size(ref)       → uniq line count, cached on disk
#   _intersect_streaming(...) → stream the reference past a candidate set
#
# Result: peak RAM is bounded by |candidates ∪ hits|, never by |reference|.

_REF_SIZE_CACHE: dict[str, int] = {}
# Compat shim — warm_sim still calls _REF_SET_CACHE.pop(ref, None) between
# references to free RAM. No-op now (we never load the full set), but keeping
# the name avoids touching every caller. Remove once warm_sim is updated.
_REF_SET_CACHE: dict[str, frozenset[str]] = {}


def _iter_reference(reference: str) -> Iterable[str]:
    path = _clean_path(reference)
    if not path.exists():
        raise FileNotFoundError(f"cleaned corpus missing: {path}")
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            pwd = line.rstrip("\n")
            if pwd:
                yield pwd


def reference_size(reference: str) -> int:
    """Count unique plaintexts in the cleaned reference corpus.

    Cached on disk; one full pass per cache miss, no full set in RAM.
    """
    if reference in _REF_SIZE_CACHE:
        return _REF_SIZE_CACHE[reference]
    src = _clean_path(reference)
    if not src.exists():
        raise FileNotFoundError(f"cleaned corpus missing: {src}")
    size_cache = _CACHE / f"{reference}.size.json"
    if size_cache.exists() and size_cache.stat().st_mtime >= src.stat().st_mtime:
        try:
            with size_cache.open() as fh:
                n = int(json.load(fh)["unique"])
            _REF_SIZE_CACHE[reference] = n
            return n
        except (OSError, ValueError, KeyError):
            pass
    log.info("counting unique plaintexts in reference: %s", reference)
    # Cleaned corpora are dedup'd by the cleaner, so a line count is exact.
    n = sum(1 for _ in _iter_reference(reference))
    tmp = size_cache.with_suffix(".json.tmp")
    with tmp.open("w") as fh:
        json.dump({"unique": n}, fh)
    tmp.replace(size_cache)
    _REF_SIZE_CACHE[reference] = n
    return n


def _intersect_streaming(
    candidates: Iterable[str],
    reference: str,
    *,
    budget_seconds: float | None = None,
    t0: float | None = None,
) -> tuple[frozenset[str], int]:
    """Find the intersection of `candidates` with the reference corpus.

    `candidates` is materialized into a set first (bounded by _MAX_CANDIDATES
    in callers), then we stream the reference past it. Returns (hits,
    unique_candidate_count).
    """
    cand_set: set[str] = set()
    for c in candidates:
        cand_set.add(c)
        if budget_seconds is not None and t0 is not None:
            if (time.time() - t0) > budget_seconds:
                log.warning("candidate generation hit %.0fs budget at %d uniq",
                            budget_seconds, len(cand_set))
                break
    log.info("streaming intersect: %d uniq candidates × %s",
             len(cand_set), reference)
    hits: set[str] = set()
    for pwd in _iter_reference(reference):
        if pwd in cand_set:
            hits.add(pwd)
    return frozenset(hits), len(cand_set)


# ── Cache lookup ──────────────────────────────────────────────────────────────


def get_cached_hits(attack_id: str, reference: str) -> frozenset[str] | None:
    p = _hits_path(attack_id, reference)
    clean = _clean_path(reference)
    if not p.exists():
        return None
    if clean.exists() and clean.stat().st_mtime > p.stat().st_mtime:
        log.info("sim cache stale (source newer): %s", p)
        return None
    try:
        with p.open("rb") as fh:
            return pickle.load(fh)
    except (OSError, pickle.PickleError) as exc:
        log.warning("sim cache read failed for %s: %s", p, exc)
        return None


def _store_hits(attack_id: str, reference: str, hits: frozenset[str]) -> None:
    p = _hits_path(attack_id, reference)
    tmp = p.with_suffix(".pkl.tmp")
    with tmp.open("wb") as fh:
        pickle.dump(hits, fh, protocol=pickle.HIGHEST_PROTOCOL)
    tmp.replace(p)


# ── Attack execution ──────────────────────────────────────────────────────────


def _hashcat_binary() -> str:
    import shutil

    cli = shutil.which("hashcat")
    if cli is None:
        raise RuntimeError("hashcat not in PATH — install it in the container")
    return cli


def _stream_candidates(attack: AttackDef) -> Iterable[str]:
    """Generate candidates via hashcat --stdout. Capped at _MAX_CANDIDATES."""
    binary = _hashcat_binary()

    if attack.type == "mask":
        if not attack.mask:
            raise ValueError(f"attack {attack.id} type=mask missing 'mask'")
        cmd = [binary, "--stdout", "-a", "3", attack.mask]
    elif attack.type == "wordlist":
        wl = _wordlist_path(attack.wordlist or "")
        cmd = [binary, "--stdout", "-a", "0", str(wl)]
    elif attack.type == "wordlist+rules":
        wl = _wordlist_path(attack.wordlist or "")
        rules = _rules_path(attack.rules or "")
        cmd = [binary, "--stdout", "-a", "0", str(wl), "-r", str(rules)]
    else:
        raise NotImplementedError(f"sim for attack.type={attack.type} not implemented yet")

    log.info("hashcat: %s", " ".join(cmd))
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=False
    )
    try:
        assert proc.stdout is not None
        n = 0
        for raw in proc.stdout:
            if n >= _MAX_CANDIDATES:
                break
            yield raw.rstrip(b"\n").decode("utf-8", errors="replace")
            n += 1
    finally:
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# ── Wordlist / rules resolution ───────────────────────────────────────────────

_WORDLISTS_FALLBACK = _DATA / "clean"


def _wordlist_path(name: str) -> Path:
    """Resolve a wordlist name to an on-disk path.

    Preference order: data/clean/<name>.txt.gz  → data/raw/<name>.txt
    """
    candidates = [
        _DATA / "clean" / f"{name}.txt.gz",
        _DATA / "raw" / f"{name}.txt",
    ]
    for c in candidates:
        if c.exists():
            # hashcat doesn't read gzip — decompress to a temp file
            if c.suffix == ".gz":
                tmp = Path(tempfile.gettempdir()) / f"narwal.wl.{name}.txt"
                if not tmp.exists() or tmp.stat().st_mtime < c.stat().st_mtime:
                    log.info("decompressing wordlist %s -> %s", c, tmp)
                    with gzip.open(c, "rb") as fin, tmp.open("wb") as fout:
                        for chunk in iter(lambda: fin.read(1024 * 1024), b""):
                            fout.write(chunk)
                return tmp
            return c
    raise FileNotFoundError(f"wordlist not found: {name}")


_RULES_DIR = _REPO / "data" / "rules"
_HASHCAT_RULES_DIR = Path("/usr/share/hashcat/rules")


def _rules_path(name: str) -> Path:
    """Resolve a rules file. Falls back to /usr/share/hashcat/rules/<name>.rule."""
    for p in [
        _RULES_DIR / name,
        _RULES_DIR / f"{name}.rule",
        _HASHCAT_RULES_DIR / name,
        _HASHCAT_RULES_DIR / f"{name}.rule",
    ]:
        if p.exists():
            return p
    raise FileNotFoundError(f"rules file not found: {name}")


# ── Public entry point ────────────────────────────────────────────────────────


def simulate(
    attack: AttackDef,
    reference: str,
    *,
    force: bool = False,
) -> tuple[frozenset[str], SimResult]:
    """Run `attack` against the cleaned `reference` corpus; return the
    set of plaintexts that would be cracked plus metadata.

    Peak RAM is bounded by the candidate set + the hits set — the reference
    corpus is streamed off disk, never materialized.

    Fast paths skip hashcat entirely:
      · type=wordlist → load wordlist as candidate set, stream reference
      · type=mask     → stream reference past PACK classification (constant RAM)
    type=wordlist+rules invokes hashcat --stdout. type=fla streams from MAYA.
    """
    cached = None if force else get_cached_hits(attack.id, reference)
    if cached is not None:
        return cached, _read_meta(attack.id, reference)

    t0 = time.time()

    if attack.type == "wordlist":
        wl_set = _wordlist_plaintext_set(attack.wordlist or "")
        hits, candidate_count = _intersect_streaming(iter(wl_set), reference)
    elif attack.type == "mask":
        hits, candidate_count = _stream_mask_filter(attack.mask or "", reference)
    elif attack.type == "fla":
        from backend.pipeline import fla_runner

        n_samples = attack.guess_budget or 10_000_000
        training = attack.training or "rockyou"
        hits, candidate_count = _intersect_streaming(
            fla_runner.stream_candidates(training, n_samples=n_samples),
            reference,
            budget_seconds=_TIMEOUT_SECONDS,
            t0=t0,
        )
    elif attack.type in {"wordlist+rules", "mask+rules"}:
        hits, candidate_count = _intersect_streaming(
            _stream_candidates(attack),
            reference,
            budget_seconds=_TIMEOUT_SECONDS,
            t0=t0,
        )
    else:
        raise NotImplementedError(f"sim for attack.type={attack.type!r} not implemented yet")

    seconds = time.time() - t0
    _store_hits(attack.id, reference, hits)
    result = SimResult(
        attack_id=attack.id, reference=reference,
        hit_count=len(hits), candidate_count=candidate_count, seconds=seconds,
    )
    _write_meta(attack.id, reference, result)
    log.info("sim %s/%s: %d hits / %d candidates in %.1fs",
             attack.id, reference, len(hits), candidate_count, seconds)
    return hits, result


def _stream_mask_filter(mask: str, reference: str) -> tuple[frozenset[str], int]:
    """Stream the reference past the PACK classifier. Constant RAM."""
    from backend.pipeline.mask_histogram import classify

    hits: set[str] = set()
    for pwd in _iter_reference(reference):
        if classify(pwd) == mask:
            hits.add(pwd)
    return frozenset(hits), 0  # mask attacks don't enumerate a candidate set


_WORDLIST_SET_CACHE: dict[str, frozenset[str]] = {}


def _wordlist_plaintext_set(name: str) -> frozenset[str]:
    if name in _WORDLIST_SET_CACHE:
        return _WORDLIST_SET_CACHE[name]
    for cand in [_DATA / "clean" / f"{name}.txt.gz", _DATA / "raw" / f"{name}.txt"]:
        if cand.exists():
            opener = gzip.open if cand.suffix == ".gz" else open
            log.info("loading wordlist as set: %s", cand)
            with opener(cand, "rt", encoding="utf-8", errors="replace") as fh:
                out = {line.rstrip("\n") for line in fh if line.rstrip("\n")}
            fs = frozenset(out)
            _WORDLIST_SET_CACHE[name] = fs
            return fs
    raise FileNotFoundError(f"wordlist not found: {name}")


def _write_meta(attack_id: str, reference: str, result: SimResult) -> None:
    meta = {
        "attack_id": result.attack_id,
        "reference": result.reference,
        "hit_count": result.hit_count,
        "candidate_count": result.candidate_count,
        "seconds": result.seconds,
    }
    with _meta_path(attack_id, reference).open("w") as fh:
        json.dump(meta, fh)


def _read_meta(attack_id: str, reference: str) -> SimResult:
    p = _meta_path(attack_id, reference)
    if not p.exists():
        return SimResult(attack_id=attack_id, reference=reference, hit_count=0, candidate_count=0, seconds=0.0)
    with p.open("r") as fh:
        d = json.load(fh)
    return SimResult(**d)


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 0.0
    u = len(a | b)
    if u == 0:
        return 0.0
    return len(a & b) / u
