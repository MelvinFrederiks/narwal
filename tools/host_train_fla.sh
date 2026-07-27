#!/usr/bin/env bash
# Run FLA training for Crackalyzer on the host GPU.
#
# Run this OUTSIDE the VM, on the host where the NVIDIA GPU lives. Inputs
# and outputs all live under the repo root (auto-detected from this
# script's location), which the VM also sees on the shared mount — so
# when training finishes, the VM picks up the checkpoint automatically.
#
# Usage:
#   bash tools/host_train_fla.sh [--train-corpus rockyou] [--n-samples 1000000] [--resume]
#
# Resume note: MAYA doesn't support mid-training resume. It writes
# mid-checkpointN.pt as a best-of-completed-epochs snapshot during training and
# only renames it to checkpointN.pt after all 20 epochs finish. With --resume,
# the wrapper promotes the latest mid-checkpoint to a finalized one so MAYA's
# eval runs against the partial model. Crack rate will be below the paper's
# 20-epoch number, but you get an actual reading instead of nothing.
#
# Expected runtime on an RTX-class GPU: ~2 h per epoch × 20 epochs (~36 h total)
# on a midrange laptop card; faster on a desktop GPU.

set -euo pipefail

# Repo root = parent of the directory this script lives in.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)

TRAIN_CORPUS=rockyou
N_SAMPLES=1000000
RESUME=0

# ── Argument parsing (positional or --flag style) ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --train-corpus|--corpus) TRAIN_CORPUS="$2"; shift 2 ;;
    --n-samples|-n) N_SAMPLES="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --help|-h) sed -n '2,16p' "$0"; exit 0 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done

MAYA=$REPO/third_party/maya
VENV=$REPO/.venv-host
LOG_DIR=$REPO/data/cache/fla
LOG_FILE=$LOG_DIR/host_train.log
SUMMARY=$LOG_DIR/host_train.summary.txt
PUBLISHED_CSV=$MAYA/results/rq1/rq1.csv.maya-published

mkdir -p "$LOG_DIR"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

log "============================================================"
log "Crackalyzer host-side FLA training"
log "Repo root:    $REPO"
log "Corpus:       $TRAIN_CORPUS"
log "n_samples:    $N_SAMPLES"
log "Mode:         $([[ $RESUME -eq 1 ]] && echo 'resume (autoload latest checkpoint)' || echo 'fresh (train from scratch)')"
log "============================================================"

# ── 1. Sanity checks ──
if [[ ! -d $MAYA ]]; then
  log "ERROR: MAYA repo not at $MAYA. Clone it first:"
  log "  git clone https://github.com/williamcorrias/MAYA-Password-Benchmarking $MAYA"
  exit 1
fi
if [[ ! -f $REPO/data/clean/$TRAIN_CORPUS.txt.gz ]]; then
  log "ERROR: cleaned corpus missing at $REPO/data/clean/$TRAIN_CORPUS.txt.gz"
  exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  log "WARN: no nvidia-smi found. Training will run on CPU, which takes ~37 days."
  log "      ctrl-C now if that's not what you want."
  sleep 5
else
  log "GPU(s) detected:"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | tee -a "$LOG_FILE"
fi

# ── 2. Host-side venv (separate from VM's /mnt/llm-shared/.venv) ──
if [[ ! -x $VENV/bin/python ]]; then
  log "Creating host venv at $VENV"
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip 2>&1 | tee -a "$LOG_FILE" | tail -3

# ── 3. PyTorch with CUDA ──
if command -v nvidia-smi >/dev/null 2>&1; then
  log "Installing torch with CUDA support"
  "$VENV/bin/pip" install --quiet torch torchvision torchaudio 2>&1 | tee -a "$LOG_FILE" | tail -3
else
  log "Installing torch CPU-only"
  "$VENV/bin/pip" install --quiet --index-url https://download.pytorch.org/whl/cpu \
    torch torchvision torchaudio 2>&1 | tee -a "$LOG_FILE" | tail -3
fi

# ── 4. MAYA's other deps ──
log "Installing MAYA runtime deps"
"$VENV/bin/pip" install --quiet \
  accelerate transformers datasets pyyaml tqdm gdown numpy-ringbuffer \
  scipy seaborn matplotlib heapcy rarfile py7zr pyzstd \
  2>&1 | tee -a "$LOG_FILE" | tail -3

# ── 5. Verify torch actually sees the GPU ──
CUDA_OK=$("$VENV/bin/python" -c "import torch; print(int(torch.cuda.is_available()))")
log "torch.cuda.is_available() = $CUDA_OK"
if [[ "$CUDA_OK" != "1" ]] && command -v nvidia-smi >/dev/null 2>&1; then
  log "ERROR: nvidia-smi works but torch doesn't see CUDA — likely a driver/toolkit mismatch."
  log "       Fix: install the matching CUDA toolkit or reinstall torch with the right index URL."
  exit 1
fi

# ── 6. Ensure MAYA pickle exists for the training corpus ──
log "Ensuring MAYA pickle for $TRAIN_CORPUS"
"$VENV/bin/python" - <<EOF
import sys, gzip, pickle
sys.path.insert(0, "$REPO")
from backend.pipeline.fla_runner import prepare_corpus
p = prepare_corpus("$TRAIN_CORPUS")
print(f"pickle ready at {p}")
EOF

# ── 7. Back up MAYA's published CSV so our run produces a clean rq1.csv ──
# Only on a fresh run — resume should keep accumulating rows in the existing file.
if [[ $RESUME -eq 0 ]]; then
  if [[ -f $MAYA/results/rq1/rq1.csv && ! -f $PUBLISHED_CSV ]]; then
    cp "$MAYA/results/rq1/rq1.csv" "$PUBLISHED_CSV"
    log "Backed up MAYA's published rq1.csv to $(basename "$PUBLISHED_CSV")"
  fi
  rm -f "$MAYA/results/rq1/rq1.csv"
fi

# ── 8. Resume sanity check ──
# MAYA's design:
#   · mid-checkpointN.pt: best-of-completed-epochs snapshot, overwritten each epoch
#   · checkpointN.pt:     written ONLY by finalize_checkpoint() after all 20 epochs
#   · autoload scans for ^checkpointN.pt and ignores mid-* files.
# So "resume mid-training" isn't supported; the best we can do is promote the
# mid-checkpoint to a finished checkpoint and let MAYA evaluate that partial model.
if [[ $RESUME -eq 1 ]]; then
  FINAL_CKPTS=$(find "$MAYA/checkpoints/fla" -name "checkpoint*.pt" -not -name "mid-*" 2>/dev/null)
  MID_CKPTS=$(find "$MAYA/checkpoints/fla" -name "mid-checkpoint*.pt" 2>/dev/null)
  if [[ -n "$FINAL_CKPTS" ]]; then
    log "Found finalized checkpoint(s); MAYA will treat training as complete and skip to eval:"
    echo "$FINAL_CKPTS" | tee -a "$LOG_FILE"
  elif [[ -n "$MID_CKPTS" ]]; then
    log "WARN: only mid-checkpoint(s) exist — training never finished cleanly."
    log "      Promoting the latest mid-checkpoint to a finalized one. The eval will run"
    log "      against a PARTIALLY-TRAINED model, so the crack rate will be below the"
    log "      paper's 20-epoch number. Continue if you want a partial-training reading."
    LATEST_MID=$(echo "$MID_CKPTS" | sort -V | tail -1)
    PROMOTED="${LATEST_MID/mid-/}"
    log "      $LATEST_MID  →  $PROMOTED"
    cp "$LATEST_MID" "$PROMOTED"
    log "      (original mid-checkpoint left in place so the run could be re-attempted later)"
  else
    log "WARN: --resume requested but no checkpoint files at all under $MAYA/checkpoints/fla/"
    log "      Falling back to fresh training."
    RESUME=0
  fi
fi

# ── 9. Run training ──
log "Starting FLA training (config: $MAYA/models/FLA/CONF/config.yaml)"
log "Live progress lands in:"
log "  $MAYA/results/rq1/fla/$TRAIN_CORPUS/all-8-100-80/$N_SAMPLES/<hash>/log.out"
log "Tail it from anywhere with:"
log "  tail -F \"\$(find $MAYA/results/rq1/fla -name log.out | head -1)\""
log "============================================================"

cd "$MAYA"

if [[ $RESUME -eq 1 ]]; then
  # autoload=1 → load latest checkpointN.pt and continue from epoch N+1.
  # overwrite=0 → don't clobber existing rq1.csv rows.
  PYTHONPATH="$MAYA" "$VENV/bin/python" -u main.py \
    --test_config config/test/rq1.yaml \
    --models fla \
    --n_samples "$N_SAMPLES" \
    --train_datasets "$TRAIN_CORPUS" \
    --autoload 1 \
    --overwrite 0 \
    --display_logs 1 2>&1 | tee -a "$LOG_FILE"
else
  PYTHONPATH="$MAYA" "$VENV/bin/python" -u main.py \
    --test_config config/test/rq1.yaml \
    --models fla \
    --n_samples "$N_SAMPLES" \
    --train_datasets "$TRAIN_CORPUS" \
    --autoload 0 \
    --overwrite 1 \
    --display_logs 1 2>&1 | tee -a "$LOG_FILE"
fi

TRAIN_RC=${PIPESTATUS[0]}
log "main.py exited with status $TRAIN_RC"

# ── 9. Summary back to /mnt/llm-shared ──
{
  echo "Crackalyzer host-side FLA training summary"
  echo "==========================================="
  echo "Finished:        $(date -u +%FT%TZ)"
  echo "Train corpus:    $TRAIN_CORPUS"
  echo "n_samples:       $N_SAMPLES"
  echo "Exit code:       $TRAIN_RC"
  echo ""
  echo "Checkpoint:"
  find "$MAYA/checkpoints/fla" -name "checkpoint*.pt" -newer "$MAYA/main.py" 2>/dev/null || echo "  (none — training did not produce a checkpoint)"
  echo ""
  echo "rq1.csv row(s) for this run:"
  if [[ -f $MAYA/results/rq1/rq1.csv ]]; then
    grep "^fla,$TRAIN_CORPUS," "$MAYA/results/rq1/rq1.csv" || echo "  (no matching row)"
  else
    echo "  (no rq1.csv produced)"
  fi
  echo ""
  if [[ -f $PUBLISHED_CSV ]]; then
    echo "MAYA's published rows for comparison:"
    grep "^fla,$TRAIN_CORPUS," "$PUBLISHED_CSV" || echo "  (none)"
  fi
} | tee "$SUMMARY"

log "Done. Summary written to $SUMMARY"
log "Next steps:"
log "  cat \"$SUMMARY\""
log "  ls \"$MAYA/checkpoints/fla/\""

exit "$TRAIN_RC"
