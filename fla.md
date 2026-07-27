# FLA — how it's wired up

FLA is the LSTM-based generative password model from Melicher et al. 2016
("Fast, Lean, and Accurate"). Narwal integrates it via the MAYA
benchmarking framework (`williamcorrias/MAYA-Password-Benchmarking`).

There are two ways FLA shows up in Narwal:

## 1. Published crack rates (instant, paper-grade, fixed targets)

MAYA ships **268 FLA result rows** in `third_party/maya/results/rq1/rq1.csv`
— their published benchmark numbers across 8 training corpora at 11
n_samples thresholds, on the `all-8-100-80` test setting (chars ≤ 8, 80%
train/test split, 100% train chunk).

- Surfaced via `GET /api/maya/curves?model=fla&training_dataset=<id>`.
- Returns `{n_samples, crack_pct}` pairs sorted by n_samples.
- The Verdict scene (TODO) will plot these against wordlist+rules and
  masks so you can see FLA's curve next to alternatives.

**Limitation:** these are crack rates against MAYA's own held-out test
splits, not against *your* target hashlist. If you want FLA-style
guesses against an arbitrary target, you need path #2.

## 2. Locally-trained FLA (multi-hour CPU, arbitrary targets)

This produces an actual LSTM checkpoint you can run inference on to
generate candidates that we then intersect with any reference corpus —
exactly the same shape as our wordlist+rules / mask attacks.

### Pre-requisites

- MAYA repo cloned to `third_party/maya/` (gitignored).
- MAYA's deps installed in `.venv` — torch (CPU), transformers,
  accelerate, heapcy, rarfile, py7zr, pyzstd, scipy, seaborn, etc.
- Cleaned corpus available at `data/clean/<id>.txt.gz`.
- Corpus converted to MAYA's pickle format by `fla_runner.prepare_corpus(id)`.

### Quirks of MAYA's harness

Three things that bit us, all fixed:

1. **MAYA's plotter crashes on non-standard n_samples.** `script/plotters/rq1.py:48`
   does `datasets[dataset][i]` with `i` in the standard set (1M, 2.5M, ...).
   If you pass a custom n_samples (e.g. 100000), KeyError. **Patched** to
   skip missing keys gracefully.

2. **`--test_datasets X` with the same X as `--train_datasets` produces
   zero combinations.** `tester.py:generate_combinations` filters out
   `train == test`. For same-corpus train/eval, **omit `--test_datasets`** —
   MAYA holds out 20% of the train set automatically.

3. **MAYA's stdout is *always* redirected** inside `Model.__init__` to
   per-run `log.out` files. `--display_logs 1` only keeps stderr visible.
   If a run looks silent, look under
   `third_party/maya/results/<rq>/<model>/<train>/<test-args>/<n>/<test-hash>/log.out`.

### Run a verification training

This trains FLA on rockyou at MAYA's paper config (hidden=1000, 20 epochs)
to verify our crack-rate output matches their published `15.70% @ n=1M`:

```sh
systemd-run --user --unit=narwal-fla-train \
  --working-directory=/mnt/llm-shared/third_party/maya \
  --setenv=PYTHONPATH=/mnt/llm-shared/third_party/maya \
  --property=StandardOutput=append:/mnt/llm-shared/data/cache/fla/train.log \
  --property=StandardError=append:/mnt/llm-shared/data/cache/fla/train.log \
  /mnt/llm-shared/.venv/bin/python -u main.py \
    --test_config config/test/rq1.yaml \
    --models fla \
    --n_samples 1000000 \
    --train_datasets rockyou \
    --autoload 0 \
    --overwrite 1 \
    --display_logs 1
```

**Expected cost**: measured on this host (Ubuntu 24.04, no GPU, 3.8 GB RAM):
~45h per epoch at MAYA's default config (hidden=1000, batch=128), so
**~37 days for the full 20-epoch run**. Verified by kicking off the
training (it gets to "Epoch 0/20: 36 it/s" and progresses) but bailing
once the per-epoch ETA was clear. On a CUDA GPU this is hours, not days.

**Expected crack rate** (once the training finishes): `15.70 ± 0.5%` at
n=1M against rockyou's 20% held-out test split. Anything more than ~2 pp
drift suggests we've diverged from MAYA's pipeline somewhere.

### After training

MAYA writes:

- Checkpoint: `third_party/maya/checkpoints/fla/<train-hash>/checkpoint20.pt`
- Per-run log: `third_party/maya/results/rq1/fla/<train>/<test-args>/<n>/<test-hash>/log.out`
- Guesses file: `third_party/maya/results/rq1/fla/<train>/<test-args>/<n>/<test-hash>/guesses/guesses.gz`
  — this is the candidate stream we intersect with a reference corpus.
- Updated `results/rq1/rq1.csv` with our row.

### Wiring back into Narwal

`backend/pipeline/fla_runner.py` exposes:

- `prepare_corpus(name)` — `data/clean/<name>.txt.gz` → MAYA pickle.
- `train(name, epochs, hidden)` — subprocess MAYA `main.py` for one train+gen cycle.
- `checkpoint_path(name)` — where to expect the trained model.
- `stream_candidates(name, n_samples)` — iterator yielding generated passwords.

`backend/pipeline/attack_sim.py` calls `stream_candidates` when an attack
of `type = "fla"` is simulated against a reference. The `fla_rockyou_1e7`
entry in `backend/config/attacks.toml` is the demo attack.

## Why not just reimplement FLA from scratch?

Considered, rejected. Melicher's original cupslab repo is Keras-on-TF1
and hard to revive; MAYA's PyTorch port is current, paper-faithful, and
maintained. The integration ugliness (3 quirks above) is a one-time tax;
reimplementing would burn weeks for no upside.

## Scope guardrails (per CLAUDE.md)

- FLA: **in scope** (user override 2026-06-02).
- Other DL-based guessers (PassGPT, PassFlow, PassGAN, PLRGAN, VGPT2):
  out of scope, but their MAYA-published crack curves are available via
  the same `/api/maya/curves` endpoint — surface them if needed.
- All FLA usage is **plan-only**: we generate candidates and check
  whether they'd crack our target. Actual hash cracking is Hashtopolis's
  job.
