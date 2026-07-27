<p align="center">
  <img src="web/assets/favicon-180.png" width="160" alt="Narwal logo — rainbow-haired cartoon narwhal"/>
</p>

<h1 align="center">
  <img src="web/assets/header-tagline.svg" width="720" alt="Narwal: Plan the attack. Save polar bears."/>
</h1>

**A pre-attack planner for password cracking.** Profile a target hashlist against reference password corpora, simulate candidate attack chains in software, and get a ranked, deduplicated attack plan — before burning GPU-hours on the real cluster.

Narwal plans; [Hashtopolis](https://github.com/hashtopolis/server) cracks. Designed to slot in as a sidecar when you're ready to ship a plan, but runs fully standalone for everything up to that point.

## What it does

You give it:
- a target hashlist (NTLM, bcrypt, MD5, …)
- a cluster spec (defaults: 8× RTX 5080 ≈ 840 GH/s NTLM)
- a budget (hours of cluster time)

It gives you:
- a cumulative-mask coverage chart (à la van Heijningen 2013, fig. O.2) showing how each attack contributes
- a pairwise overlap viewer telling you which attacks are redundant
- a per-position character-frequency heatmap of your target — diagnoses dataset character at a glance
- a dataset-similarity cluster placing your target near the most similar reference corpus
- a recommended attack chain with budget allocations
- a one-click export to a Hashtopolis task chain

## Methodology

Built on two references:

1. **Van Heijningen 2013** ([thesis](https://www.researchgate.net/publication/362283500)) — the cumulative-mask cracking-time chart, per-position letter-frequency heatmaps, and Hashcat mask-attack methodology.
2. **MAYA / Corrias et al. 2026** ([arxiv:2504.16651](https://arxiv.org/abs/2504.16651)) — dataset cleaning conventions, the seven research questions framing, the cross-cultural password-distribution insights.

Datasets are cleaned through [demeuk](https://github.com/NetherlandsForensicInstitute/demeuk) before profiling. Simulation uses hashcat's `--stdout` mode (fast, no GPU needed) plus PCFG/OMEN for guess-number estimates on the headline curves.

## Quick start

### With Docker

```bash
git clone https://github.com/thatux/narwal.git
cd narwal
docker compose up           # standalone Narwal on :8080
open http://localhost:8080
```

That's it — no Hashtopolis container required. The bridge is preview-only: clicking *Send to Hashtopolis* in the Verdict scene returns the v2 supertask JSON for you to POST manually. To make the bridge live-call upstream, run Narwal next to a Hashtopolis dev compose:

```bash
docker compose \
  -f /path/to/hashtopolis/docker-compose.dev.yml \
  -f ./docker-compose.yml \
  up
export HASHTOPOLIS_URL=http://hashtopolis:8080/api/v2 HASHTOPOLIS_API_KEY=…
```

### Local (no Docker)

```bash
git clone https://github.com/thatux/narwal.git
cd narwal
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi 'uvicorn[standard]' pydantic demeuk httpx numpy umap-learn scikit-learn
PYTHONPATH=. uvicorn backend.main:app --host 127.0.0.1 --port 8080
open http://127.0.0.1:8080
```

Drop your hashlist into the composer. Click **profile target**. Read the verdict panel.

## Architecture

```
Narwal (standalone)
├── FastAPI backend
├── Web UI (vanilla JS + Chart.js)
└── Bridge → Hashtopolis REST API   ← preview JSON only, no upstream
                                       container required to plan
```

Drop into the Hashtopolis dev container when you want the bridge to POST live. See `wiki/architecture.md` for the longer version.

## Docs

- [`wiki/architecture.md`](wiki/architecture.md) — how the pieces fit
- [`wiki/methodology.md`](wiki/methodology.md) — what we measure and why, with paper citations
- [`wiki/extending.md`](wiki/extending.md) — adding datasets, attacks, hash types

## Status

Early-stage. The headline visualizations (cumulative-mask coverage, overlap viewer, frequency heatmap) are working against fixture data. The demeuk pipeline, hashcat-stdout simulator, and Hashtopolis bridge are scaffolded but not all wired end-to-end yet.

## License

MIT for the tool. Reference datasets follow their own terms — see `wiki/methodology.md` for the dataset table.
