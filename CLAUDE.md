# Narwal — working notes

A pre-attack password planner sidecar for Hashtopolis. NFI / forensic context (user: `fdtlicenties@nfi.nl`).

## Filesystem

- **Always work under `/mnt/llm-shared/`.** This is the only persistent mount; `/tmp/` is wiped between sessions.
- Repo lives at the mount root. Use absolute paths in tool calls.
- Cleaned corpora: `data/clean/<id>.txt.gz` (gzipped, one password per line). Raw drops in `data/raw/`.
- On-disk caches: `data/cache/{coverage,heatmap,features,umap,sims}/` — invalidated by mtime of upstream files.
- Fixtures (Van Heijningen Table O.1, etc.) live in `data/fixtures/` — do not regenerate; they are anchors for tests.
- Storyboard (design reference): `docs/storyboard.html`. The wiki under `wiki/` is the authoritative spec — surface conflicts in PR/responses, don't silently diverge.

## Python environment

- Venv at `/mnt/llm-shared/.venv` (persistent — gitignored). Rebuild if missing:
  ```
  python3 -m venv /mnt/llm-shared/.venv
  /mnt/llm-shared/.venv/bin/pip install fastapi 'uvicorn[standard]' pydantic demeuk httpx numpy umap-learn scikit-learn pytest pytest-asyncio
  ```
- Never put project files under `/tmp` — `/tmp` is wiped between sessions. Persistent state lives under `/mnt/llm-shared/`.
- No package pinning in `pyproject.toml` — install latest. Bug-compatible code is preferred over version walls.
- Use the venv's interpreter explicitly: `/mnt/llm-shared/.venv/bin/python`, `/mnt/llm-shared/.venv/bin/uvicorn`, `/mnt/llm-shared/.venv/bin/pytest`.
- Run from repo root with `PYTHONPATH=.`.

## Running the app

```
cd /mnt/llm-shared
PYTHONPATH=. /mnt/llm-shared/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8080
```

Open `http://127.0.0.1:8080/`. First request per scene may spin while caches warm — the lifespan hook pre-warms coverage, heatmap, features, and UMAP in the background.

## Tests

```
cd /mnt/llm-shared
PYTHONPATH=. /tmp/cra-venv/bin/pytest
```

All 25 tests pass on a clean checkout. Real-RockYou test (`test_real_rockyou_reaches_table_o1_headline_within_2pp`) auto-skips if `data/clean/rockyou.txt.gz` is absent.

## Sudo / system installs

- Sudo password (for explicitly authorized installs only): `llm`. Pattern: `echo 'llm' | sudo -S apt-get install -y <pkg>`.
- Don't use it for anything beyond what the user asked for.
- Tools confirmed installed system-wide: `git`, `hashcat`, `code` (VSCode 1.122.1).

## Git conventions

- Author identity for commits in this repo: `Your Name <you@example.com>` (placeholder, intentional per user).
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Never push, force-push, or amend without the user asking. Only commit when the user requests it.

## Scope guardrails (do not relax)

- **Plan-only.** Narwal simulates against reference corpora; it never attempts the user's target hashes itself. Cracking is Hashtopolis's job.
- **Hashtopolis bridge is preview-only.** `/api/bridge/export` returns the v2 supertask JSON; it does not POST.
- **DL-based password guessers**: FLA is **in scope** (user override 2026-06-02 — subprocess via MAYA's implementation). PassGPT and the other neural models stay out of scope.
- **Targeted attacks** — out of scope per MAYA exclusion.
- **No invented datasets.** Registry is MAYA Table 2 (8 leaks) + HIBP top10M (guess-list). The `000webhost` dataset id is `zerozeroowebhost` because TOML keys can't start with a digit; display label maps it back.

## Numbers reaching the UI

- Percentages: 1 decimal place.
- Time: natural units (ms / s / min / h / d / y), not raw seconds.
- Charts use locked axes when comparing datasets so the slope tells a consistent story.

## Anchor values

- Van Heijningen Table O.1 row 25 (`?l?l?l?l?l?l?l?l?d?d`): 67.19% cumulative. Reproduced on real RockYou at **row 30** (~67.5%); row 25 (~61.7%) is off by ~5pp because Van Heijningen's masks were filtered to those occurring in ≥2 of his 10 leaks — we only have one. Documented in `tests/test_mask_histogram.py`.
- Cluster spec defaults: 8× RTX 5080 = 840 GH/s NTLM (105/card).

## Editor

VSCode installed as `code`. Open the workspace with `code /mnt/llm-shared`.
