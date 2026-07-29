<p align="center">
  <img src="web/assets/favicon-180.png" width="160" alt="Narwal logo — rainbow-haired cartoon narwhal"/>
</p>

<h1 align="center">Narwal</h1>

**A browser-side password corpus visualizer.** Upload the output of your own analysis tooling and get readable charts back. Everything is parsed in the browser — files are never uploaded, and the backend only serves static assets.

## Scenes

### Keyspace viz — `#keyspace`

Upload one or more PACK `statsgen` `.masks` files (`mask,count` per line) and compare corpora:

- **bars** — password-length distribution as % of each corpus's own total, so different-sized corpora compare fairly.
- **lines** — per-character-class keyspace coverage: for each category, `count(masks fitting the category) ÷ (alphabet ^ length)`, on a log axis.

Categories are derived from the uploaded masks (the most frequent character-class combinations), not hardcoded. A floor slider sets how deep into the coverage tail to look. A weighted exponential fit is drawn per series, and the largest departures from it are tabled below the chart.

### Analysis results — `#analysis-results`

Upload one or more JSON files, each describing an analysis run (or a JSON array of several):

```json
{ "name": "length", "type": "histogram", "values": { "8": 1200, "9": 830 }, "axis": "length" }
{ "name": "pos-char", "type": "bivariate", "values": { "0": { "a": 12, "b": 4 } }, "axis_x": "position", "axis_y": "char" }
```

Runs are collated onto one chart when their `name` fields agree. `histogram` renders bar charts with bucket-shape-aware toggles (dynamic scaling, case-insensitive merging, excluding digits/specials/other); `bivariate` renders a colour-coded 2D grid per run.

## Quick start

### With Docker

```bash
docker compose up
open http://localhost:7070
```

### Local (no Docker)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi 'uvicorn[standard]'
PYTHONPATH=. uvicorn backend.main:app --host 127.0.0.1 --port 7070
open http://127.0.0.1:7070
```

## Architecture

```
backend/
  main.py          FastAPI app — CORS, /healthz, static mount of web/
  routes/          seam for future API routers (empty; none needed yet)
web/
  index.html       shell: theme variables, design-system CSS, nav
  app.js           hash router + theme toggle
  scenes/
    registry.js    add a scene here to put it in the nav
    keyspace.js
    analysis_results.js
```

Both scenes are entirely client-side, so there are currently no API endpoints. To add one, drop a module exposing `router` into `backend/routes/` and register it in the include loop in `backend/main.py`.

To add a scene, export `name` and `render(mountEl)` from a module in `web/scenes/` and add it to `registry.js`.

Charts use [Chart.js](https://www.chartjs.org/) 4.4 loaded from a CDN.

## License

MIT.
