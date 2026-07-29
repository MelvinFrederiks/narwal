# Narwal — working notes

A browser-side password corpus visualizer.

Two scenes, both entirely client-side:

- **Keyspace viz** (`#keyspace`) — PACK `statsgen` `.masks` files → length distribution + per-character-class keyspace coverage.
- **Analysis results** (`#analysis-results`) — JSON analysis runs → histograms and bivariate grids.

Files are parsed in the browser and never uploaded. The backend serves static assets and `/healthz`; there are no API endpoints.

## Layout

```
backend/main.py      FastAPI app — CORS, /healthz, static mount of web/
backend/routes/      seam for future routers (empty)
web/index.html       shell: theme variables, design-system CSS, nav
web/app.js           hash router + theme toggle
web/scenes/          registry.js + the two scene modules
```

- `data/`, `docs/`, `design/`, `analysis_samples/` are reference material, not inputs to the running app. `analysis_samples/` holds example `.masks` / stats files useful for exercising the scenes by hand.
- `docs/storyboard.html` and `docs/papers/` are design/background reference only.

## Running

```
docker compose up          # http://localhost:7070/
```

Or without Docker, from the repo root:

```
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi 'uvicorn[standard]'
PYTHONPATH=. uvicorn backend.main:app --host 127.0.0.1 --port 7070
```

The compose file bind-mounts `./backend` and `./web`, so edits to either show up on container restart (uvicorn runs without `--reload`).

Note: the container runs as root, so any `__pycache__` it writes under `backend/` ends up root-owned. Clear it with
`docker run --rm -v "$PWD/backend:/target" python:3.11-slim bash -c 'find /target -name __pycache__ -type d -prune -exec rm -rf {} +'`.

## Tests

There are currently no tests — the previous suite covered the removed analysis pipeline. `tests/` keeps only `conftest.py` (repo-root `sys.path` bootstrap) as a seam.

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
- Tools confirmed installed system-wide: `git`, `hashcat`, `code` (VSCode 1.122.1).

## Git conventions

- Author identity for commits in this repo: `Your Name <you@example.com>` (placeholder, intentional per user).
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Never push, force-push, or amend without the user asking. Only commit when the user requests it.
