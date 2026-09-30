<p align="center">
  <img src="web/assets/favicon-180.png" width="160" alt="Narwal logo — rainbow-haired cartoon narwhal"/>
</p>

<h1 align="center">Narwal</h1>

**A password corpus visualizer.** Upload the output of your own analysis tooling and get readable charts back.

Three of the four scenes are entirely client-side: files are parsed in the browser and never uploaded. The fourth, **Mergeability**, cannot be — it needs hashcat to expand a real keyspace — so it queues a job that a worker container runs in the background.

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

### Overlap — `#overlap`

Load two files — a wordlist or a PACK `.masks` file, detected from content — and see what they share, as an area-proportional Venn plus a Jaccard index. Two wordlists compare as passwords; anything else falls back to mask space.

### Mergeability — `#mergeability`

Answers a question the other scenes can't: **given a goal wordlist, how much does a second attack add on top of the first?** Two attacks can both crack a lot and still be nearly redundant — or look unimpressive individually and be highly complementary. This measures which.

You pick a goal wordlist and describe two or more attacks (wordlist + rules, mask, or hybrid). A worker runs each attack against the goal list *independently*, then compares what each recovered. For attacks A and B with recovered sets S<sub>A</sub>, S<sub>B</sub>:

```
mergeability = (|S_A ∪ S_B| − max(|S_A|, |S_B|)) / max(|S_A|, |S_B|)
```

0% means the weaker attack finds nothing the stronger one missed; 100% means they recover disjoint sets of equal size, so running both doubles the yield. This is the Mergeability Index from [arXiv:2504.16651](https://arxiv.org/abs/2504.16651). Jaccard is shown alongside it, because a pair can score low on similarity and still be worth merging — that difference is the point.

The measurement uses hashcat's mode 99999 (`Plaintext`), which treats the goal wordlist *as the hash list*: each line is its own "hash" and a candidate cracks it by being byte-identical. Nothing is hashed, so hashcat becomes a fast GPU-parallel set-membership test and "which goal entries would this attack find?" is just its outfile.

Jobs run in the background and results persist, so you can close the tab — a finished analysis lives at `#mergeability/<job-id>`.

Requires `NARWAL_WORDLISTS_DIR` (see below): a job runs on the server, so its inputs must be files the server can already see.

## Quick start

### With Docker

```bash
docker compose up          # web UI + mergeability worker
open http://localhost:7070
```

The worker runs hashcat on the CPU by default, so the stack works anywhere. For GPU:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

That override requires the NVIDIA Container Toolkit on the host; see the file's header for the AMD/Intel variant.

### Local (no Docker)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install fastapi 'uvicorn[standard]'
PYTHONPATH=. uvicorn backend.main:app --host 127.0.0.1 --port 7070
open http://127.0.0.1:7070
```

The three client-side scenes work as-is. For Mergeability you also need hashcat on `PATH` and a worker running:

```bash
PYTHONPATH=. python3 -m worker.main
```

## Configuration

Copy `.env.example` to `.env`. The one setting that unlocks anything is `NARWAL_WORDLISTS_DIR` — a read-only directory of wordlists/masks files. It gives every scene a "pick from server library" dropdown, and it is what the Mergeability scene draws its goal lists and attack wordlists from. Everything else has a working default; see the comments in `.env.example`.

## Architecture

```
backend/
  main.py          FastAPI app — CORS, /healthz, static mount of web/
  config.py        reads .env: wordlist library, runs dir, hashcat settings
  routes/
    wordlists.py   read-only browsing of the server wordlist library
    jobs.py        mergeability job queue API
  jobs/
    db.py          SQLite queue — shared with the worker over a volume
    spec.py        attack-spec validation (the browser/hashcat trust boundary)
    metrics.py     mergeability + Jaccard
worker/
  main.py          claim a job, run its attacks, write the result
  hashcat.py       argv construction, process supervision, output parsing
  Dockerfile       hashcat + OpenCL; no web dependencies
web/
  index.html       shell: theme variables, design-system CSS, nav
  app.js           hash router (`#scene/param`) + theme toggle
  scenes/
    registry.js    add a scene here to put it in the nav
    keyspace.js  analysis_results.js  overlap.js  mergeability.js
  util/            masks.js, words.js, venn.js, serverFiles.js
runs/              job queue + per-job artifacts (gitignored, created at runtime)
```

The API and the worker are separate containers and share nothing but the `runs/` volume: the API enqueues and reads, the worker claims and writes. That keeps the web image free of hashcat and the GPU runtime, and means moving the worker to a dedicated GPU box is a mount change rather than a rewrite.

To add an endpoint, drop a module exposing `router` into `backend/routes/` and register it in the include loop in `backend/main.py`.

To add a scene, export `name` and `render(mountEl, route)` from a module in `web/scenes/` and add it to `registry.js`.

Charts use [Chart.js](https://www.chartjs.org/) 4.4 loaded from a CDN.

## Tests

```bash
PYTHONPATH=. python3 -m pytest              # unit tests
NARWAL_HASHCAT_BIN=/path/to/hashcat NARWAL_HASHCAT_FORCE=1 \
  PYTHONPATH=. python3 -m pytest            # ...plus the hashcat integration tests
```

Tests marked `integration` drive a real hashcat and skip themselves when none is runnable. `scripts/e2e_mergeability.sh` runs the whole stack through docker compose against a throwaway wordlist library and prints the expected numbers next to the actual ones.

## License

MIT.
