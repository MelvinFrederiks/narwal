# Narwal — in-flight plan

Living doc. Update as work lands or pivots. Anchored to the TaskList.

## In progress

- **#23 · Keyspace visualization scene** — DONE (feature-complete, no open follow-ups queued). `web/scenes/keyspace.js`, registered in `web/scenes/registry.js`. Upload one or more PACK statsgen `.masks` files (`mask,count` lines, e.g. `~/tools/pack/results/rockyou.masks`) — parsed client-side, nothing uploaded.
  - **Bars**: password-length distribution, normalised to % of each corpus's own total (fair comparison across differently-sized corpora), grouped side-by-side per uploaded file.
  - **Categories**: data-driven, not fixed — `buildCategories()` ranks every character-class combination (by exact mask signature, e.g. lowercase/digits/alpha/alphanum/loweralphanum/all) actually present in the upload(s) by frequency; top 8 offered as toggle chips, top 4 selected by default.
  - **Coverage lines**: per selected category, `count(masks whose class-signature ⊆ category) ÷ alphabet_size^length` — a log-axis line per (corpus × category). 2nd+ corpus drawn with reduced HSL saturation + dashed line so overlapping series stay legible (`withSaturation`, `satFactor`).
  - **Floor slider**: sets the log-axis minimum from 1e-9 down to 1e-100; x-axis view auto-extends to whatever length still clears the floor (`computeView`/`cutFor`).
  - **Trendline**: weighted least-squares exponential fit per (corpus × category), done in log space (`ln(cov) = ln(count) − L·ln(alphabet_size)`) for numerical stability in the deep tail, weighted by password count per length (`weightedLinFit`) so the fit tracks the populous head of the distribution instead of being dragged toward the numerically-larger-but-sparse tail. Clamped at 100% coverage. Fit is computed over the *entire* dataset (all lengths), independent of the floor/displayed depth — moving the slider only changes what's drawn, not the fit or the table below.
  - **Deviation tables**: two tables ("▲ More common than trend" / "▼ Rarer than trend"), each ranked by excess passwords (`|actual − trend-expected|`) descending. Rows need ≥`MIN_ROW_COUNT` (25) passwords at that length/category to qualify, so a handful of outliers can't produce a headline-grabbing ratio with no real support. Known accepted tradeoff: the weighted fit overestimates the deep tail (lengths ~15+) since the fit is anchored to the populous head — acceptable per user, since analysis mostly cares about lengths <15.
  - Validated against real `rockyou.masks` + `words.masks` via throwaway Python mirrors (no `node` available in this environment) — weighted fit lines up with actual coverage at lengths 5–13 within a small factor, vs. the earlier unweighted fit which undershot by 2–3 orders of magnitude there.
  - No outstanding TODOs for this scene as of 2026-07-23.

- **#22 · Overlap·pair Venn — correct overlap geometry + family-coloured circles** — open. Two issues with `web/scenes/overlap_2.js`:
  1. **Overlap math vs. visual.** The circle separation is computed as `dist = r * 2 * (1 - jaccard)` — a quick proxy, not the real two-set Venn geometry. For accurate visuals the centre-to-centre distance should solve the lens-area equation `A_∩(d, r₁, r₂)` for `d` given the actual `|A∩B|`, `|A|`, `|B|` returned by the API. Also account for `|A| ≠ |B|` (radii currently locked to r=80 both sides; should scale with `√(set_size)` so visible area = actual size ratio).
  2. **Circles use hardcoded purple/green** (`A_FILL`/`B_FILL` constants). Each attack already has an icon family colour from `web/util/attack_icons.js` (`iconFor(attack)` returns colour + shape — rockyou=purple, hibp=blue, mask=orange, fla=green). The Venn should pull the per-attack colour and fill each circle with that family colour so the visual matches the chip in the slot above. Same for the SVG `<text>` label fills (currently fixed to `var(--mask-text)` / `var(--success-text)`) — should mirror the circles.

- **#21 · Chart.js text colour in dark mode** — open. Coverage, Compare, Heatmap, and Verdict scenes all use Chart.js with default axis/tick/legend colour `#666`, which reads black on the dark-mode `var(--surface)` background. Chart.js options need to inherit from CSS vars: set `Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary')`, same for gridline (`--border`) and tick (`--text-tertiary`) colours, and re-apply whenever `data-theme` changes (or `prefers-color-scheme` media query fires). Probably best to centralise in `web/util/chart_theme.js` and import from each scene before instantiating its chart. Same fix applies to inline SVG charts (overlap-many force graph axis labels, cluster bubble labels) — currently `fill="#888"` hardcodes.

- **#20 · Polar-unicorn logo + mascot** — open. `logo-polar-unicorn.png` lives at repo root (drop in from the user). Tasks: move to `web/assets/logo-polar-unicorn.png` (or `docs/brand/` if we want a brand folder), reference as the favicon (replaces the current `data:,` stub in `web/index.html:7`), reuse as a small mascot chip next to the `<h1>` in the header, swap into the home hero where the password ticker currently lives so the mascot becomes the visual anchor for the "save bears" framing. Also generate a 64×64 + 256×256 derivative for retina favicons. Keep it cute, keep it on-brand for the polar-bear theme from #16/#19 mockups.

- **#19 · Hero animation — more memes, more fun** — open. Current ticker (`hunter2`, xkcd `correct horse battery staple`, `Tr0ub4dor&3`, etc.) is one joke deep. Ideas: a tiny "this is fine" doge frame around the sim core, animated `*******` revealing the underlying password mid-scroll, a "galaxy brain" progression (brute force → wordlist → wordlist+rules → mask → FLA), a frantic gear with `password123 cracked` floating off as confetti. Pick one or two; keep tone professional-cheeky, not Reddit-cringe (NFI audience).

- **#18 · Precompute heatmap + coverage for instant first paint** — open. Scenes already lean on `backend/pipeline/pregenerate.warm_all_in_background()` (lifespan hook in `backend/main.py:38`), but the first hit per scene is still spinner-on-screen if the user navigates faster than the warm completes. Need to (a) measure: what's the warm-time on a cold cache for each of coverage / heatmap / cluster / features?  (b) wait for the lifespan warm to *finish* (or at least the user-selected datasets) before serving `/`?  Or (c) keep the lifespan hook but block the scene's first request behind the warm task and surface a progress badge in the header? Decide once we have the (a) numbers. Until then, anything keeping first-paint above ~300 ms is a regression vs. the storyboard promise.

- **#16 · Dark mode** — DONE. `web/index.html` now ships three CSS variable blocks: light at `:root`, dark at `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, and `:root[data-theme="dark"]` override. A cycling icon button in the header (auto / sun / moon) writes the choice to `localStorage.nrw-theme` and a synchronous bootstrap script applies it before first paint (no flash-of-light).

- **#17 · Streaming reference intersect** — PARTIAL.
  - **Done**: `attack_sim.simulate` no longer materialises the reference as `frozenset[str]`. New helpers: `_iter_reference` (gzipped line stream), `reference_size` (cached uniq count), `_intersect_streaming` (build candidate set, then stream reference past it). `_stream_mask_filter` handles mask attacks in constant RAM. `OversizeReferenceError` / `OVERSIZE_REFS` stopgap reverted. Verified: `rockyou_best64 × linkedin` completed in 5 min, used ~11 GiB RSS, no OOM kill (previously: swap-thrash + eventual OOM).
  - **Open**: peak RAM is now bounded by the *candidate* set, not the reference. `rockyou × d3ad0ne.rule` produces ~600M unique candidates (~50 GiB set) and still OOM-kills. Fix is the same disk-based merge-join, applied to candidates: sink hashcat `--stdout` to a temp file, `LC_ALL=C sort -u`, then `comm -12` with a pre-sorted reference. RAM bounded by hits only. ~½ day work. Same approach also unlocks LinkedIn as a fully-supported reference.

- **#10 · Implement FLA via MAYA subprocess** — scaffolded, not yet trained.

  Done:
  1. Flipped CLAUDE.md "DL-based guessers — out of scope" rule.
  2. Cloned `williamcorrias/MAYA-Password-Benchmarking` to `third_party/maya/` (gitignored).
  3. Installed PyTorch (CPU-only), transformers, accelerate, heapcy, tqdm, gdown, scipy etc. into `.venv`.
  4. Added `type = "fla"` to `AttackType` in `backend/models.py`.
  5. `backend/pipeline/fla_runner.py` — corpus → MAYA pickle conversion, train + generate subprocess wrappers, candidate streaming. Imports clean.
  6. `attack_sim.simulate` branch for `type == "fla"` — streams from `fla_runner.stream_candidates`, intersects with reference, caches like other attacks.
  7. `fla_rockyou_1e7` attack registered in `backend/config/attacks.toml` (rockyou-trained, 10⁷ guesses).
  8. Server restarted; `/api/compose/library` lists the FLA attack alongside the rest.

  Not done — the actual training:
  - MAYA ships no pretrained checkpoint; we have to train.
  - This host: no GPU, 3.8 GB RAM, 3.8 GB swap (60-80% utilised already). LSTM(1000) × 20 epochs × 14M rockyou rows on CPU is conservatively a **24-48 hour run** and would compete with the sim warmup currently running.
  - Even a "tiny" config (hidden=128, 3 epochs) would burn ~3-4 h of CPU and most of the remaining RAM headroom.
  - Calling `attack_sim.simulate(fla_rockyou_1e7, …)` right now will surface a `RuntimeError("FLA checkpoint missing … Run train('rockyou') first")` — that's by design, not a bug.

  Verified reproduction attempt:
  - Patched MAYA's `script/plotters/rq1.py` to tolerate non-standard n_samples (KeyError on missing dicts).
  - Discovered (and documented in `fla.md`) that `--test_datasets X` with same X as `--train_datasets` produces zero combinations in `generate_combinations` — omit `--test_datasets` for same-corpus train/eval.
  - Started a real paper-config training run via `systemd-run --user --unit=narwal-fla-train`. Reached `Epoch 0/20: 36 it/s` — **~45 h per epoch, ~37 days for the full 20-epoch run on this CPU**. Stopped after confirming.
  - `GET /api/maya/curves?model=fla&training_dataset=<id>` exposes the paper's published crack rates for FLA + 5 other DL models across 8 corpora.
  - `fla.md` is the canonical how-to for both paths.

  Path forward (still user decision):
  - **(a) GPU access** — move the training run to a CUDA host, ~hours instead of days. Drop `checkpoint20.pt` back into `third_party/maya/checkpoints/fla/<train-hash>/`.
  - **(b) accept the published-CSV-only path** — Verdict surfaces FLA's curve from MAYA's results; no arbitrary-target Overlap for FLA.
  - **(c) park** — scaffolding stays, revisit later.

- **#11 · Build overlap-2 + overlap-many scenes** — DONE.
  - `web/util/attack_icons.js` — deterministic color-by-family (rockyou=purple, hibp=blue, mask=orange, fla=green), shape-by-djb2-mod-8 (circle, square, triangle, diamond, hexagon, pentagon, star, cross).
  - `web/scenes/overlap_2.js` — drag-and-drop chip tray + two A/B slots, Venn + verdict + clickable ranked pair list.
  - `web/scenes/overlap_many.js` — force-directed graph (inline Verlet sim, no d3 dep). Edges colored by verdict (red/amber/green), thickness ∝ Jaccard, hover tooltip, click for pair focus card. Dragging nodes pins them mid-sim.
  - `registry.js` and `home.js` updated; old `overlap.js` deleted.
  - Backend: added a JSON cache for `/api/overlap` matrices keyed by `(reference, mode, attack_set_hash)`. First request still ~24s for 9 cached attacks on rockyou (loading 9 large pickled frozensets + 36 pairwise intersections); subsequent requests are 46ms.
  - Known cosmetic limitation: with 10 attacks across 4 families and 8 shapes, some shape collisions (e.g. `rockyou_best64` and `rockyou_dive` both get the purple circle). Labels disambiguate. Could be fixed by index-within-family assignment.

- **#8 · Precompute real overlap sims**
  - Running as `narwal-warmup.service` (systemd-run --user).
  - Ref-outer loop frees each reference's plaintext set before loading the next — fixed the first round of OOMs but **LinkedIn (60.9M unique) still OOMs** on its own: Python `set[str]` needs ~5GB for it, larger than total RAM (3.8GB) + swap can hold without thrash.
  - **Workaround in place**: LinkedIn is skipped via `_OVERSIZE_REFS` in `tools/warm_sim.py`. Reduces grid from 72 to 63 pairs (9 attacks × 7 refs).
  - Caches land in `data/cache/sim/<attack>__<reference>.pkl`.
  - **TODO**: re-enable LinkedIn with a disk-based streaming intersect. Approach: pre-sort the reference once, dump hashcat output to a sorted file, merge-join on disk. ~half a day of work; not blocking the demo.

- **#12 · Maintain plan.md** — this file.

## Done since last clean state

- VSCode installed.
- Server + warmup now run under `systemd-run --user` (`narwal-server.service`, `narwal-warmup.service`) so they survive bash sandbox teardowns.
- Setup dataset selection: clickable cards, "select all" / "clear", localStorage persistence, propagation to Coverage / Compare / Overlap / Cluster / Heatmap dropdowns.
- Home landing scene + 9-card workflow with auto-generated icons.
- Composer moved to position 7 in the nav so flow reads: setup → understand → compose → verdict.
- Find-Optimal button on Setup — calls `/api/verdict` with the user's selected refs + budget, surfaces the top step inline.
- Overlap numbers fixed (real hashcat sim by default; wordlist/mask fast paths skip hashcat entirely).
- Playwright + headless Chromium + `tools/screenshot.py`. I can now see what users see.

## Open questions / next decisions

- Hashtopolis bridge is still preview-only. Closing the loop (`?execute=1` → real POST → status view) is the demo-ability question.
- OMEN is a TOML stub. `attack_sim` raises NotImplementedError for `type=omen`. Same MAYA subprocess pattern as FLA would unify the two.
- Real RockYou cumulative coverage hits 67.19% at row 30 (not row 25 like Van Heijningen's headline). Documented in `tests/test_mask_histogram.py`; would require shipping the other 9 leaks Van Heijningen used to apply his multi-leak filter.

## Scope guardrails (current)

- Plan-only. Narwal simulates against reference corpora; Hashtopolis cracks.
- Hashtopolis bridge: preview-only.
- ~~DL-based guessers out of scope.~~ **FLA now in scope** (user override on 2026-06-02).
- Targeted attacks: out of scope.
- No invented datasets — MAYA Table 2 + HIBP top10M.
