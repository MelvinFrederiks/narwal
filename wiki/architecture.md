# Architecture

Narwal runs as a **sidecar** alongside Hashtopolis inside the same dev container. No fork, no upstream patches — it talks to Hashtopolis through its public REST API.

## Components

**Web UI** (Chart.js, vanilla JS). Single-page app. Three main views:
- *Composer* — drag attacks into a pipeline, see runtime estimates update live
- *Coverage chart* — cumulative-mask % cracked + cracking time, van-Heijningen style
- *Overlap viewer* — Jaccard between cracked-hash sets, with verdict (drop / keep both)
- *Heatmap* — per-position character frequency for the target and each reference
- *Cluster map* — UMAP projection of reference datasets, target dropped in once profiled
- *Verdict panel* — strongest/weakest reference, recommended chain, export buttons

**FastAPI backend.** Endpoints:
- `POST /profile` — accepts hashlist + cluster spec, returns full analysis JSON
- `POST /simulate` — runs a candidate pipeline through hashcat `--stdout`, returns coverage curve
- `GET /datasets` — lists available cleaned reference corpora
- `POST /plan/export` — converts the chosen pipeline into a Hashtopolis task-chain payload

**demeuk pipeline.** Reference datasets are cleaned once at container build, cached on disk. Re-runs are no-ops unless the source file changes (mtime check).

**Simulation engines.**
- *Fast path:* hashcat `--stdout` generates candidates; we set-intersect with reference plaintexts and the target's known-cracked plaintexts (if any provided). Sub-second feedback for the composer.
- *Slow path:* PCFG (lakiw's pcfg_cracker) and OMEN compute true guess-number curves for the headline figure. Run async, results streamed in when ready.

**Hashtopolis bridge.** Pure REST client. Auth via API key in env. Creates supertasks, uploads wordlist/rule references, sets priorities. No code in upstream Hashtopolis is touched.

## Data flow

```
hashlist + cluster spec
        │
        ▼
   FastAPI /profile
        │
        ├──> demeuk (cached)
        ├──> hashcat --stdout (per attack)
        ├──> PCFG/OMEN (async, headline figure)
        ├──> MinHash sketches → Jaccard
        └──> UMAP projection
        │
        ▼
   analysis JSON → web UI
        │
        ▼
   user picks plan → /plan/export → Hashtopolis API
```

## Why sidecar, not fork

Upstream Hashtopolis moves. A fork carries diffs forever. A sidecar talks to the stable public API and survives upstream changes. If a feature genuinely belongs in Hashtopolis core, we send a PR; everything else stays out-of-tree.

## Dev container

The compose file in the repo root brings up:
- the upstream Hashtopolis dev container (unmodified)
- Narwal's FastAPI service
- a shared volume for cleaned datasets

Both services expose ports to the host. The UI talks to FastAPI directly; FastAPI talks to Hashtopolis over the internal docker network.
