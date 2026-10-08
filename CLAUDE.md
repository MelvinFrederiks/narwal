# Narwal — working notes

A password corpus visualizer.

Three client-side scenes — files parsed in the browser, never uploaded:

- **Keyspace viz** (`#keyspace`) — PACK `statsgen` `.masks` files → length distribution + per-character-class keyspace coverage.
- **Analysis results** (`#analysis-results`) — JSON analysis runs → histograms and bivariate grids.
- **Overlap** (`#overlap`) — two wordlists or masks files → area-proportional Venn + Jaccard.

And two that aren't, because they can't be — both queue a background hashcat job:

- **Mergeability** (`#mergeability`) — how much a second attack adds on top of a first, against a goal wordlist. Metric is the Mergeability Index (arXiv:2504.16651).
- **Attack order** (`#ordering`) — given a set of attacks you intend to run anyway, in what *sequence* to run them so passwords turn up soonest. Scores all N! orderings. See "Mergeability jobs" and "Ordering jobs" below.

The backend serves static assets, `/healthz`, and two routers: `backend/routes/wordlists.py` (the optional "pick from server library" dropdown, browsing a read-only operator-configured directory — see `.env.example`) and `backend/routes/jobs.py` (the job queue, shared by both server-side scenes). The three client-side scenes never call the backend for computation.

## Layout

```
backend/main.py       FastAPI app — CORS, /healthz, static mount of web/
backend/config.py     reads .env: wordlist library, runs dir, hashcat settings
backend/routes/       wordlists.py (server-library browsing), jobs.py (queue API)
backend/jobs/         db.py (SQLite queue), spec.py (validation), metrics.py, ordering.py, wakeup.py
worker/               separate container: claims jobs, runs hashcat, writes results
web/index.html        shell: theme variables, design-system CSS, nav
web/app.js            hash router (`#scene/param`) + theme toggle
web/scenes/           registry.js + the scene modules
web/util/serverFiles.js  frontend client for the server-library dropdown
web/util/jobForm.js   attack builder + job list, shared by the two queue-backed scenes
runs/                 job queue + per-job artifacts; gitignored, runtime-created
```

`backend/jobs/` is imported by *both* containers, which is why it holds no FastAPI. The worker's only dependency is the stdlib plus the hashcat binary.

**The worker does not poll.** `backend/jobs/wakeup.py` is a FIFO in `NARWAL_RUNS_DIR`: the API writes a byte on enqueue, the worker blocks in `select()` until it arrives, with `NARWAL_WORKER_IDLE` (30s) as a fallback for housekeeping. Idle cost went from two write transactions every 2s to nothing; enqueue-to-running went from up to 2s to ~0.03s. Three things keep it safe: a FIFO buffers, so a notification sent mid-job is still there afterwards; every wait has a timeout, so a lost notification costs latency and never a job; and `ensure()` returning None (a filesystem with no FIFO support) puts the worker back on the old poll loop. The `Waiter` opens the FIFO `O_RDWR` rather than `O_RDONLY` deliberately — read-only would block at startup until a writer appeared, and would spin `select()` on permanent EOF once the last writer closed, which is the busy loop this replaces. The worker also watches a `signal.set_wakeup_fd` pipe, without which a SIGTERM arriving mid-sleep would set the stop flag and then sleep out the rest of the timeout, past Docker's 10s stop grace.

- `data/`, `docs/`, `design/`, `analysis_samples/` are reference material, not inputs to the running app. `analysis_samples/` holds example `.masks` / stats files useful for exercising the scenes by hand.
- `docs/storyboard.html` and `docs/papers/` are design/background reference only.

## Running

```
docker compose up          # http://localhost:7070/ — web UI + hashcat worker
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up   # NVIDIA GPU
```

**The worker image ships no hashcat.** Set `NARWAL_HASHCAT_DIR` in `.env` to your own install (any hashcat tree: a release tarball or a `git clone && make` build); it is bind-mounted at `/opt/hashcat` and the worker refuses to start without it, naming what to set. That is the point of the arrangement — you get the attack modes, hash modes and backends your distribution's package predates, and there is no bundled binary for a broken mount to silently fall back to.

The mount is read-**write**, which is not an oversight. A build-from-source hashcat is a "portable" install: it treats its own directory as the profile directory, keeps its compiled-kernel cache and `hashcat.dictstat2` there, and will not start without somewhere to write. Both verified — `:ro` dies with `Read-only file system` trying to create `<session>.outfiles`, and `XDG_CACHE_HOME`/`XDG_DATA_HOME` do **not** redirect it in portable mode. The worker runs as root, so what it leaves there is root-owned (`chown -R "$USER" <install>` to undo). `--logfile-disable` and `--outfile-check-dir` keep everything else out of the tree, so only hashcat's own caches end up in it.

The OpenCL runtime's *separate* compile cache (~34MB under `$HOME/.cache`) lives in the `hashcat-cache` named volume, so recreating the container doesn't throw it away.

The worker is CPU-only by default so the stack runs anywhere; the override file adds device reservations and clears `NARWAL_HASHCAT_FORCE`.

Or without Docker, from the repo root:

```
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi 'uvicorn[standard]'
PYTHONPATH=. uvicorn backend.main:app --host 127.0.0.1 --port 7070
```

The compose file bind-mounts `./backend` and `./web`, so edits to either show up on container restart (uvicorn runs without `--reload`).

Note: the container runs as root, so any `__pycache__` it writes under `backend/` ends up root-owned. Clear it with
`docker run --rm -v "$PWD/backend:/target" python:3.11-slim bash -c 'find /target -name __pycache__ -type d -prune -exec rm -rf {} +'`.

Optional server-side wordlist library: copy `.env.example` to `.env` and set `NARWAL_WORDLISTS_DIR` (host path) and `NARWAL_WORDLISTS_REGEX`. Under Docker it's bind-mounted read-only at `/mnt/wordlists`; with bare uvicorn it's read directly. Unset by default — the dropdown just doesn't appear.

## Mergeability jobs

The measurement rests on **hashcat mode 99999 (`Plaintext`)**: the goal wordlist is handed to hashcat *as the hash file*, so each line is its own "hash" and a candidate cracks it by being byte-identical. No hashing happens; hashcat becomes a GPU-parallel set-membership test, and "what would this attack recover?" is just `--outfile`. Verified on hashcat 6.2.6 and 7.1.2 — `Password.Len.Max` is 256 in both.

Things that will bite anyone changing `worker/hashcat.py`:

- **Exit code 1 means *exhausted*, which is success.** Only codes above 1 are errors. Treating non-zero as failure fails essentially every job.
- **`--potfile-disable` is load-bearing.** Without it, attack 2 skips what attack 1 already cracked and reports near-zero — mergeability then reads as a perfect 0 for entirely the wrong reason. `tests/test_worker_integration.py::test_attacks_do_not_contaminate_each_other` guards this.
- **The `--session` name must be unique per attempt**, not per (job, attack). hashcat writes a pidfile named after the session and refuses to start if that session looks live; a worker killed mid-attack leaves one behind, so reusing the name makes every *requeued* job fail with "Already an instance running".
- **Goal loading is lossy and silent.** hashcat drops blank lines, rejects lines over 256 bytes, then de-duplicates. `Hashes: N digests; M unique digests` in the log is the real goal size and the only correct coverage denominator.
- **Never `--remove`** — it rewrites the operator's goal file in place.
- **`--outfile-check-dir` must point at a directory nothing writes to.** hashcat adopts cracks found there as already-done. Pointing it at the job workdir — the obvious choice, since that is where the outfiles go — reintroduces precisely the contamination `--potfile-disable` prevents, through a different door: attack 2 reads `attack0.out` and skips everything in it. It is also *timing-dependent*, since the check only runs on `--outfile-check-timer` intervals (5s default), so sub-second attacks look fine while long ones quietly under-report. `worker/hashcat.py::_check_dir` keeps an empty directory for it; `tests/test_worker_integration.py::test_outfile_check_dir_does_not_leak_between_attacks` guards it with a mask attack long enough to actually perform a check.
- **Kernel compilation is charged to whichever attack goes first.** hashcat compiles an OpenCL kernel per (hash mode, attack mode) on first use. Measured on PoCL CPU: an `-a 3` attack takes **29.5s cold and 3.3s warm**; `-a 0` takes 15.2s cold and 2.7s warm. `hashcat.warm_up` runs one throwaway attack per mode in the spec before anything is timed, and the result records `warmup_s` per mode so odd durations can be checked against it. `NARWAL_HASHCAT_WARMUP=0` disables it.
  - `--keyspace` does **not** help here, which is worth knowing because it looks like it should: it never initialises the backend, so it builds no kernels. Measured: `--keyspace` returns in 0.2–1.4s and the real attack afterwards still paid the full 30s cold cost. Its value is also not a candidate count (for `?l?l?l?l?l` it returns 456,976 = 26⁴, the outer-loop size), so it isn't a useful thing to show a user either.
- Recovered plains are compared as raw bytes, not decoded: real corpora are not valid UTF-8.

A job spec carries a `kind` — `mergeability` or `ordering`. Both kinds describe the same thing and run the same hashcat work; only the summary computed afterwards differs, so they share one queue, one worker and one builder UI. A spec with no `kind` is a mergeability job, which is what every spec written before ordering existed is — don't make it required.

`backend/jobs/spec.py` is the trust boundary — job specs arrive as browser JSON and become hashcat argv. Paths are resolved and containment-checked (which also defeats symlink escapes), `NARWAL_WORDLISTS_REGEX` is enforced there and not just in the listing endpoint, and masks are parsed token by token. The worker re-validates on claim, since config can change between enqueue and run.

On a CPU-only host hashcat refuses the PoCL OpenCL runtime as outdated and exits with "No devices found/left"; `NARWAL_HASHCAT_FORCE=1` is the way past that, and compose sets it by default.

## Ordering jobs

`kind: "ordering"` answers a different question off the same hashcat runs: given attacks you have already decided to run, in what sequence do you run them so the cracked count climbs soonest?

The thing to not get wrong: **this needs N hashcat runs, not N!**. An attack's recovered set and its runtime do not depend on where it sits in the sequence — that is the same `--potfile-disable` property mergeability relies on. So every permutation's cracked-over-time curve is a pure function of the N recovered sets and the N measured durations, and `backend/jobs/ordering.py` scores all of them exactly, in Python, in milliseconds. If anyone proposes running the permutations through hashcat, that is the paragraph to point at.

- **Scoring never touches the sets N! times.** Each recovered password is reduced to an N-bit *coverage signature* (which attacks find it), collapsing the corpus to ≤ 2^N−1 counts; a subset-sum (zeta) transform then precomputes `|union of S|` for all 2^N subsets, after which scoring one ordering is N array lookups. 8 attacks over 160k recovered passwords: 40,320 orderings in 0.08s.
- **`MAX_ORDER_ATTACKS = 8` is a factorial cap, not a stylistic one**, enforced in `spec.py` *and* re-checked in `ordering.py`. 10! is felt, 12! never finishes.
- **The score is a normalised area under the cracked-vs-time curve.** Total recovered and total runtime are identical for every ordering, so the normalisation only makes the number readable — it cannot change the ranking.
- **The one modelling assumption is inside an attack.** hashcat reports how many goal entries an attack recovered and how long it took, not which entry it found at which second, so recovery is taken to accrue uniformly across a run (trapezoid). The milestone times only interpolate within the single attack that crosses the milestone; the step boundaries are all measured.
- **Greedy (best marginal gain per second) is computed and compared, because it is not always optimal** — `tests/test_ordering.py::test_greedy_can_be_suboptimal_which_is_why_we_enumerate` holds the minimal counterexample, and the e2e run hit a real one. That comparison is the justification for exhaustive enumeration; if it ever stops holding, that test says so.
- **The first attack of a job pays a one-time OpenCL kernel build**, which lands in its measured duration and so biases the ranking against whatever happens to run first. On this host's PoCL CPU runtime that is ~25s cold against ~2s warm — enough to swamp a short attack entirely (an 815-word list measured 26.9s cold, while an 11.9M-candidate mask measured 16.8s warm in the same job). It matters much less on a GPU, and not at all once a job's attacks all cost minutes. If per-attack timings ever look implausible, check whether the cache was cold.
- `max_runtime_s` distorts an ordering job more than a mergeability one: a capped attack reports the cap as its duration, so the ranking is scheduling against a cost that would not hold in a real run. The result says so in `partial_note`.

## Tests

```
PYTHONPATH=. python3 -m pytest                                  # unit only
NARWAL_HASHCAT_BIN=... NARWAL_HASHCAT_FORCE=1 PYTHONPATH=. python3 -m pytest
```

Integration tests need an OpenCL runtime, which this host no longer has (see below). Run the whole suite against real hashcat in the worker image instead:

```
docker run --rm -v "$PWD":/app:ro -v /home/jesse/hashcat/hashcat:/opt/hashcat \
  -w /app -e PYTHONPATH=/app -e NARWAL_HASHCAT_BIN=/opt/hashcat/hashcat \
  -e NARWAL_HASHCAT_FORCE=1 narwal-worker:dev \
  sh -c 'pip install -q pytest; python -m pytest tests/ -q -p no:cacheprovider'
```

`tests/` covers the queue (`test_db.py`), spec validation (`test_spec.py`), the indices (`test_metrics.py`), the wakeup FIFO (`test_wakeup.py`), the ordering scorer (`test_ordering.py` — including a brute-force cross-check of the signature shortcut against plain set unions), and a real-hashcat end-to-end (`test_worker_integration.py`, marked `integration`, self-skipping when no hashcat is runnable). The client-side scenes have no tests.

`scripts/demo_ordering.sh` queues three ordering analyses against a real corpus and is the fastest way to see the feature do something — run it with `--wait` for printed summaries. It calls `scripts/demo_corpus.py`, which builds what it needs into a `demo/` subdirectory of the wordlist library. The only library file it touches is `rockyou.txt` — there is no realistic goal list in the library (`goal.txt` is 15 hand-typed lines), so one is sampled from rockyou; the attack dictionary instead comes from cracklib's own small word list (`/usr/share/dict/cracklib-small`, needs `cracklib-runtime` installed), copied into the demo dir since an attack wordlist has to live under `NARWAL_WORDLISTS_DIR`. `rm -rf <library>/demo` undoes it. `scripts/demo_report.py` prints one job's result and exists as a file rather than a heredoc because a heredoc and a pipe cannot both have stdin.

`scripts/demo_mergeability.sh` runs the same cracklib/rules/mask attacks as `scripts/demo_ordering.sh`'s "dictionary vs rules" and "mask family" jobs, but as one mergeability job instead of an ordering one — run it with `--wait` to see `scripts/show_job.py`'s pairwise breakdown (the cracklib/cracklib+rules pair should land near 0 mergeability, since rules with the identity rule are a superset of the bare dictionary; the mask pairs should land much closer to 1).

`scripts/e2e_mergeability.sh` and `scripts/e2e_ordering.sh` drive the whole stack through docker compose against a throwaway library and print expected-vs-actual. `scripts/e2e_restart.sh` is the worker-crash recovery check — written but not yet run to completion, so treat it as unproven tooling.

Note that both e2e scripts recreate the compose containers against a temp library, which disrupts a stack already running against a real one. To exercise the worker without touching a running stack, bind-mount `backend/` and `worker/` into a throwaway `narwal-worker:dev` container and drive `worker.main.process_one` directly — it needs nothing but the stdlib and hashcat.

## Extending

- **New scene** — export `name` and `render(mountEl)` from a module in `web/scenes/`, then add it to `web/scenes/registry.js`. The nav is built from that list.
- **New endpoint** — add a module exposing `router` (a `fastapi.APIRouter`) under `backend/routes/`, then register it in the include loop in `backend/main.py`.

## Python environment

- No package pinning in `pyproject.toml` — install latest. Bug-compatible code is preferred over version walls.
- Runtime deps are just `fastapi` and `uvicorn[standard]`.
- Run from repo root with `PYTHONPATH=.`.

## Numbers reaching the UI

- Percentages: 1 decimal place.
- Time: natural units (ms / s / min / h / d / y), not raw seconds.
- Charts use locked axes when comparing datasets so the slope tells a consistent story.
- Chart.js 4.4 is loaded from a CDN in `index.html`; the annotation plugin is not used.

## Sudo / system installs

- Sudo password (for explicitly authorized installs only): `llm`. Pattern: `echo 'llm' | sudo -S apt-get install -y <pkg>`.
- Don't use it for anything beyond what the user asked for.
- Tools confirmed installed system-wide: `git`, `code` (VSCode 1.122.1), `docker` (29.6.2).
- **hashcat is NOT on `PATH`.** Only the `hashcat-data` package is installed; the working binary is `/home/jesse/hashcat/hashcat/hashcat` (v7.1.2-382), which is what `.env` points `NARWAL_HASHCAT_DIR` at. Its glibc requirement matches the worker image (both Debian 2.41) and it links only libc — OpenCL is `dlopen`ed — so it runs unmodified inside the container.
- **`pocl-opencl-icd` is removed on this host** (`rc` in dpkg, with a dangling `/etc/OpenCL/vendors/pocl.icd`), so the local binary finds no OpenCL platform at all and `--force` does not help: the `integration`-marked tests fail outside Docker with "No OpenCL, HIP or CUDA compatible platform found". Run them in the worker container instead, or reinstall the package.

## Git conventions

- Author identity for commits in this repo: `Your Name <you@example.com>` (placeholder, intentional per user).
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Never push, force-push, or amend without the user asking. Only commit when the user requests it.
