// Scene — Score histogram / strength×entropy heatmap.
//
// Upload one or more text files. Two line formats are accepted, auto-detected
// per file from whichever format its first parseable line matches:
//   "<score> word"                      — a single-score histogram
//   "<strength> <entropy> word"         — a strength×entropy heatmap
// Both floats are of varying precision, and the format is locked once a
// file's first matching line establishes it — later lines in that file that
// don't fit are skipped rather than switching format mid-file.
//
// Histogram mode buckets words by the score's integer part (bucket "2" =
// scores in [2, 3)); the highest-scoring buckets are folded into one overflow
// bucket, grown dynamically from the top down for as long as it holds
// strictly less than OVERFLOW_SHARE of the (combined, across every loaded
// file) corpus — so a long thin tail of outlier scores can't stretch the
// axis into an unreadable smear. Multiple files render as grouped bars per
// bucket (as a % of each file's own corpus, so distributions are comparable
// across differently-sized files), one colour per file, shaded behind by a
// fixed score-quality rubric.
//
// Heatmap mode buckets words by the integer parts of both strength and
// entropy, with the same top-down overflow folding applied independently to
// each axis. One heatmap grid is rendered per file, all sharing the same
// axis buckets and the same locked intensity scale, so density is
// comparable across files.
//
// In both modes, click a bar/cell to see a sample of the words that landed
// in it, broken out per file. Everything is parsed in the browser — files
// are never uploaded, keeping this plan-only.

import { mountFinishButton } from "../util/finish_step.js";

export const name = "score-histogram";

// Fixed categorical order, reusing the app's existing status/accent hues
// (mask/info/warning/success/danger) so a file's colour never changes as
// other files are added or removed — colour follows the entity, not its
// rank. These border-color values are identical in light and dark theme.
const FILE_COLORS = ["#534AB7", "#185FA5", "#BA7517", "#0F6E56", "#A32D2D"];

// Extra border width applied to every series' bar at the selected bucket,
// so the selection is visible without repainting any file's identity colour.
const SELECTED_BORDER_WIDTH = 3;
// Outline colour for a selected heatmap cell (same role as SELECTED_BORDER_WIDTH).
const SELECTED_OUTLINE = "#D85A30";
// Single sequential hue for heatmap cell intensity (magnitude, not identity —
// same hue for every file so heatmaps are comparable; only alpha varies).
const HEAT_COLOR = "#534AB7";

// Entropy buckets are grouped in bands this many integers wide (rather than
// one column per integer) — the heatmap otherwise grows one column per
// integer entropy value, which gets unreadably wide fast. Strength stays at
// one row per integer; only entropy (the axis rendered as columns) is banded.
const ENTROPY_BUCKET_WIDTH = 3;

// The overflow bucket collects the highest-scoring integer buckets, growing
// downward from the top, for as long as their combined share of the (all
// loaded files combined) corpus stays strictly below this fraction. Datasets
// tend to have a long, thin tail of high scores — this keeps that tail from
// stretching the axis into an unreadable smear while capping how much of
// the corpus it can hide. Recomputed on every add/remove, independently per
// axis in heatmap mode — see computeCutoffFromCounts.
const OVERFLOW_SHARE = 0.01;
// Sentinel bucket key for "the dynamic overflow bucket". Infinity sorts
// after every finite key with a plain numeric comparator, so it always
// lands last.
const OVERFLOW_KEY = Infinity;

// Cap on how many words we keep per bucket/cell, via reservoir sampling — so
// a multi-million-line file doesn't balloon browser memory just to show a
// sample. Every word still counts toward the total; only the *kept sample*
// is capped and unbiased (see addToReservoir).
const SAMPLE_CAP = 500;
// How many sampled words to actually display at once, per file.
const SAMPLE_SHOW = 20;

// Chart.js can't resolve CSS custom properties — resolve to real hex/rgb so
// axis labels/ticks pick up the current theme. (Same trick as keyspace.js.)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Fixed score-quality rubric, shaded behind the histogram bars as a
// stoplight ramp (red → orange → yellow → light green → green) so a
// bucket's score band reads at a glance regardless of which file(s) are
// loaded. `max` is exclusive — a zone covers [previous max, this max).
const SCORE_ZONES = [
  { label: "horrible", max: 3, color: "#C0392B" },
  { label: "bad", max: 6, color: "#E07B39" },
  { label: "moderate", max: 8, color: "#E1B93A" },
  { label: "okay", max: 10, color: "#9ACD65" },
  { label: "good", max: Infinity, color: "#4C9A4C" },
];

function renderZoneLegend() {
  return SCORE_ZONES.map((z, i) => {
    const lo = i === 0 ? null : SCORE_ZONES[i - 1].max;
    const range = lo == null ? `&lt;${z.max}` : Number.isFinite(z.max) ? `${lo}&ndash;&lt;${z.max}` : `&ge;${lo}`;
    return `
      <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-secondary)">
        <span style="width:10px;height:10px;border-radius:2px;background:${z.color};display:inline-block"></span>
        ${z.label} (${range})
      </span>`;
  }).join("");
}

// Background box annotations shading each score-quality zone behind the
// histogram bars, mapped from score-space onto the category (bucket) axis.
// Buckets are contiguous integers starting at keys[0], so bucket "score"
// sits at index (score - keys[0]); a zone boundary at `score` falls on the
// left edge of that bucket's column, i.e. index (score - keys[0]) - 0.5. The
// overflow bucket (if present) is the last column and has no internal
// boundary — a zone edge landing inside it just splits that one column.
function scoreZoneAnnotations(keys) {
  if (!keys.length) return {};
  const lo = keys[0];
  const leftEdge = -0.5;
  const rightEdge = keys.length - 1 + 0.5;
  const annotations = {};
  let from = -Infinity;
  SCORE_ZONES.forEach((zone, i) => {
    const to = zone.max;
    const xMin = Number.isFinite(from) ? Math.max(leftEdge, (from - lo) - 0.5) : leftEdge;
    const xMax = Number.isFinite(to) ? Math.min(rightEdge, (to - lo) - 0.5) : rightEdge;
    if (xMax > xMin) {
      annotations[`zone-${i}`] = {
        type: "box",
        xScaleID: "x",
        xMin, xMax,
        backgroundColor: hexA(zone.color, 0.16),
        borderWidth: 0,
        drawTime: "beforeDatasetsDraw",
      };
    }
    from = to;
  });
  return annotations;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Score histogram</h2>
      <div class="sub">
        Upload one or more text files. Two line formats are accepted, auto-detected per file: one
        <code>&lt;score&gt; word</code> pair per line (a floating-point score, a space, then a word — e.g.
        <code>1.234 password</code>) draws a histogram; one <code>&lt;strength&gt; &lt;entropy&gt; word</code>
        triple per line (two floating-point values, then a word) draws a strength×entropy heatmap instead.
        Either way, values are grouped by their integer part (entropy is banded ${ENTROPY_BUCKET_WIDTH} at a
        time to keep the heatmap from getting too wide), and the highest buckets are folded into one overflow
        bucket — grown from the top down for as long as it holds under ${OVERFLOW_SHARE * 100}% of the corpus
        — so a long thin tail can't stretch the axis into an unreadable smear. Multiple single-score files are
        compared side by side, one colour per file; heatmap files are limited to one at a time. Click a
        bar/cell to see a sample of the words inside it, broken out per file. Parsed in your browser — nothing
        is uploaded.
      </div>

      <div id="drop" style="border:1px dashed var(--border-2);border-radius:8px;padding:24px;text-align:center;color:var(--text-secondary);margin-bottom:10px">
        <input type="file" id="scorefile" accept=".txt,.csv,text/plain" multiple style="display:none"/>
        <button id="pick" class="primary" style="padding:10px 18px">Upload files</button>
        <div id="drop-hint" style="font-size:11px;color:var(--text-tertiary);margin-top:8px"></div>
      </div>
      <div id="filebox" style="margin-bottom:10px"></div>

      <div id="msg"></div>
      <div id="meta"></div>
      <div class="chart-wrap hidden" id="chart-wrap" style="height:360px">
        <canvas id="chart"></canvas>
      </div>
      <div id="zone-legend" class="hidden" style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px">${renderZoneLegend()}</div>
      <div id="heatmap-grids" class="hidden" style="display:flex;flex-direction:column;gap:20px"></div>
      <div id="note" class="note hidden"></div>
      <div id="sample" class="hidden"></div>
      <div id="heatmap-sample" class="hidden"></div>
    </div>
  `;

  const fileInput = mount.querySelector("#scorefile");
  const drop = mount.querySelector("#drop");
  const dropHint = mount.querySelector("#drop-hint");
  const fileBox = mount.querySelector("#filebox");
  const msg = mount.querySelector("#msg");
  const meta = mount.querySelector("#meta");
  const chartWrap = mount.querySelector("#chart-wrap");
  const zoneLegend = mount.querySelector("#zone-legend");
  const heatmapGridsEl = mount.querySelector("#heatmap-grids");
  const note = mount.querySelector("#note");
  const sampleBox = mount.querySelector("#sample");
  const heatmapSampleBox = mount.querySelector("#heatmap-sample");
  let chart = null;
  let files = [];        // [{ id, name, parsedData }] — parsedData = parseFile() result
  let nextFileId = 0;

  // Histogram-mode state.
  let keys = [];          // sorted bucket keys (union across files), gaps filled
  let cutoff = null;      // smallest integer key folded into the overflow bucket (null = no overflow)
  let selectedKey = null;

  // Heatmap-mode state.
  let sCutoff = null, eCutoff = null; // per-axis overflow cutoffs
  let sKeys = [], eKeys = [];         // per-axis display buckets
  let heatGrids = new Map();          // file id -> Map("sKey,eKey" -> { count, pools: [] })
  let heatMaxShare = 0;               // locked intensity-scale denominator (max % across all files/cells)
  let selectedCell = null;            // { fileId, sKey, eKey }

  updateDropHint();

  mount.querySelector("#pick").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = FILE_COLORS[0]; });
  drop.addEventListener("dragleave", () => { drop.style.borderColor = "var(--border-2)"; });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.style.borderColor = "var(--border-2)";
    handleFiles(e.dataTransfer.files);
  });

  async function handleFiles(fileList) {
    const picked = [...(fileList || [])];
    fileInput.value = ""; // let the same file be re-picked later
    if (!picked.length) return;

    const errors = [];
    for (const p of picked) {
      let text;
      try { text = await p.text(); }
      catch { errors.push(`could not read ${escapeHtml(p.name)}`); continue; }
      const parsed = parseFile(text);
      if (!parsed.parsed) {
        errors.push(
          `no <code>&lt;score&gt; word</code> or <code>&lt;strength&gt; &lt;entropy&gt; word</code> pairs found in ${escapeHtml(p.name)}`
        );
        continue;
      }
      // Re-read on every iteration — a file added earlier in this same batch
      // already locks the mode (and, for heatmaps, occupies the one slot)
      // for the rest of the batch.
      const currentMode = files.length ? files[0].parsedData.mode : null;
      if (currentMode && parsed.mode !== currentMode) {
        errors.push(
          `${escapeHtml(p.name)} looks like ${describeMode(parsed.mode)} data, but already-loaded files are ` +
          `${describeMode(currentMode)} — remove them first to switch formats`
        );
        continue;
      }
      // Heatmap mode renders one grid at a time — multi-upload is a
      // histogram-only feature.
      if (parsed.mode === "2d" && files.length > 0) {
        errors.push(`${escapeHtml(p.name)}: heatmap files are limited to one at a time — remove the current file first`);
        continue;
      }
      files.push({ id: nextFileId++, name: p.name, parsedData: parsed });
    }
    if (errors.length) showError(errors.join("<br>"));
    else { msg.className = ""; msg.innerHTML = ""; }

    selectedKey = null;
    selectedCell = null;
    refresh();
  }

  function removeFile(id) {
    files = files.filter((f) => f.id !== id);
    selectedKey = null;
    selectedCell = null;
    refresh();
  }

  function updateDropHint() {
    const mode = files.length ? files[0].parsedData.mode : null;
    dropHint.innerHTML = mode === "2d"
      ? "heatmap files are limited to one at a time · remove the current file to load another"
      : "or drop files here · <code>&lt;score&gt; word</code> or <code>&lt;strength&gt; &lt;entropy&gt; word</code> per line · " +
        "multiple single-score files are compared side by side; heatmap files are limited to one at a time";
  }

  function refresh() {
    renderFileChips();
    updateDropHint();
    if (!files.length) {
      meta.innerHTML = "";
      chartWrap.classList.add("hidden");
      zoneLegend.classList.add("hidden");
      sampleBox.classList.add("hidden"); sampleBox.innerHTML = "";
      heatmapGridsEl.classList.add("hidden"); heatmapGridsEl.innerHTML = "";
      heatmapSampleBox.classList.add("hidden"); heatmapSampleBox.innerHTML = "";
      note.classList.add("hidden");
      if (chart) { chart.destroy(); chart = null; }
      return;
    }

    const mode = files[0].parsedData.mode;
    note.classList.remove("hidden");

    if (mode === "2d") {
      if (chart) { chart.destroy(); chart = null; }
      chartWrap.classList.add("hidden");
      zoneLegend.classList.add("hidden");
      sampleBox.classList.add("hidden"); sampleBox.innerHTML = "";
      heatmapGridsEl.classList.remove("hidden");

      const axisCutoffs = computeAxisCutoffs(files);
      sCutoff = axisCutoffs.strengthCutoff;
      eCutoff = axisCutoffs.entropyCutoff;
      sKeys = axisRange(files, "sx", sCutoff);
      eKeys = axisRange(files, "ey", eCutoff, ENTROPY_BUCKET_WIDTH);
      heatGrids = new Map(files.map((f) => [f.id, buildDisplayGrid(f, sCutoff, eCutoff)]));
      heatMaxShare = 0;
      for (const f of files) {
        const total = f.parsedData.parsed;
        for (const cell of heatGrids.get(f.id).values()) {
          const share = total ? (cell.count / total) * 100 : 0;
          if (share > heatMaxShare) heatMaxShare = share;
        }
      }

      meta.innerHTML = renderMeta2D(files);
      note.innerHTML =
        `Each cell is a (strength, entropy) integer-bucket pair; shading is a single-hue intensity scale, ` +
        `locked to the highest-density cell across every loaded file so intensity is comparable between ` +
        `heatmaps. Both axes fold their highest buckets into one overflow bin the same way as the ` +
        `single-score histogram — grown from the top down for as long as it holds under ` +
        `${OVERFLOW_SHARE * 100}% of the combined corpus. Click a cell to see a sample of its words.` +
        (files.length > FILE_COLORS.length
          ? ` Only ${FILE_COLORS.length} distinct colours are used for file accents — they repeat past that many files.`
          : "");

      if (selectedCell && !files.some((f) => f.id === selectedCell.fileId)) selectedCell = null;
      renderHeatmapGrids();
      if (selectedCell) showHeatmapSample(selectedCell);
      else { heatmapSampleBox.classList.add("hidden"); heatmapSampleBox.innerHTML = ""; }
      return;
    }

    // mode === "1d"
    heatmapGridsEl.classList.add("hidden"); heatmapGridsEl.innerHTML = "";
    heatmapSampleBox.classList.add("hidden"); heatmapSampleBox.innerHTML = "";
    chartWrap.classList.remove("hidden");
    zoneLegend.classList.remove("hidden");

    cutoff = computeCutoff(files);
    keys = fillBucketRange(files, cutoff);
    meta.innerHTML = renderMeta(files, keys.length);
    const overflowNote = cutoff != null
      ? ` Scores &ge;${cutoff} are pooled into one ${bucketLabel(OVERFLOW_KEY, cutoff)} bucket — ` +
        `combined across all loaded files it holds under ${OVERFLOW_SHARE * 100}% of the corpus.`
      : "";
    note.innerHTML =
      `Bars show each file's share of its own corpus per integer-score bucket (bucket "n" = scores in ` +
      `[n, n+1)), so distributions are comparable across files of different sizes.${overflowNote} Words are ` +
      `sampled — up to ${SAMPLE_CAP} kept per bucket per file by reservoir sampling, so the sample stays ` +
      `representative even for buckets with millions of hits. Click a bar to see its sample, per file.` +
      (files.length > FILE_COLORS.length
        ? ` Only ${FILE_COLORS.length} distinct colours are used — file colours repeat past that many files.`
        : "");
    if (selectedKey != null && !keys.includes(selectedKey)) selectedKey = null;
    draw();
    if (selectedKey != null) showSample(selectedKey);
    else { sampleBox.classList.add("hidden"); sampleBox.innerHTML = ""; }
  }

  function renderFileChips() {
    if (!files.length) { fileBox.innerHTML = ""; return; }
    fileBox.innerHTML = files.map((f, i) => `
      <span data-id="${f.id}" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border-2);border-radius:14px;font-size:12px;margin:0 6px 6px 0">
        <span style="width:10px;height:10px;border-radius:50%;background:${FILE_COLORS[i % FILE_COLORS.length]};display:inline-block"></span>
        ${escapeHtml(f.name)}
        <button title="remove" style="border:0;background:none;cursor:pointer;color:var(--text-secondary);padding:0 2px;font-size:14px;line-height:1">×</button>
      </span>`).join("");
    fileBox.querySelectorAll("[data-id]").forEach((chip) => {
      chip.querySelector("button").addEventListener("click", () => removeFile(Number(chip.dataset.id)));
    });
  }

  // ── histogram mode ─────────────────────────────────────────────────────
  function draw() {
    const datasets = files.map((f, i) => {
      const color = FILE_COLORS[i % FILE_COLORS.length];
      const total = f.parsedData.parsed;
      const counts = keys.map((k) => bucketDataForFile(f, k, cutoff).count);
      const shares = counts.map((c) => (total ? (c / total) * 100 : 0));
      return {
        label: f.name,
        data: shares,
        backgroundColor: hexA(color, 0.55),
        borderColor: color,
        borderWidth: keys.map((k) => (k === selectedKey ? SELECTED_BORDER_WIDTH : 1)),
        _counts: counts,
      };
    });
    chart = renderChart(mount.querySelector("#chart"), chart, keys, datasets, files, cutoff, (key) => {
      selectedKey = selectedKey === key ? null : key;
      draw(); // redraw so the selected bucket's border re-highlights
      if (selectedKey != null) showSample(selectedKey);
      else { sampleBox.classList.add("hidden"); sampleBox.innerHTML = ""; }
    });
  }

  function showSample(key) {
    sampleBox.classList.remove("hidden");
    const sections = files.map((f, i) => {
      const color = FILE_COLORS[i % FILE_COLORS.length];
      const b = bucketDataForFile(f, key, cutoff);
      const swatch = `<span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block"></span>`;
      if (!b || !b.count) {
        return `
          <div class="card" style="margin-top:10px">
            <div style="display:flex;align-items:center;gap:8px">
              ${swatch}<strong>${escapeHtml(f.name)}</strong>
              <span class="sub" style="margin:0">no words in this bucket</span>
            </div>
          </div>`;
      }
      const shown = b.sample.slice(0, SAMPLE_SHOW);
      const sampledNote = b.count > b.sample.length
        ? ` (reservoir-sampled from ${b.count.toLocaleString()} words)`
        : "";
      return `
        <div class="card" style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px">
            <div style="display:flex;align-items:center;gap:8px">${swatch}<strong>${escapeHtml(f.name)}</strong></div>
            <div class="sub" style="margin:0">
              ${b.count.toLocaleString()} words · ${pct(b.count, f.parsedData.parsed)}% of file ·
              showing ${shown.length.toLocaleString()}${sampledNote}
            </div>
          </div>
          <div style="max-height:220px;overflow:auto;border:0.5px solid var(--border);border-radius:var(--radius-md);padding:8px 10px;background:var(--surface-2)">
            <div style="display:flex;flex-wrap:wrap;gap:6px 10px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px">
              ${shown.map((w) => `<span>${escapeHtml(w)}</span>`).join("")}
            </div>
          </div>
        </div>`;
    }).join("");
    sampleBox.innerHTML = `
      <div style="margin-top:14px"><strong>Bucket ${bucketLabel(key, cutoff)}</strong> <span class="sub" style="margin:0">${bucketRangeLabel(key, cutoff)}</span></div>
      ${sections}
    `;
  }

  // ── heatmap mode ───────────────────────────────────────────────────────
  function renderHeatmapGrids() {
    if (!sKeys.length || !eKeys.length) { heatmapGridsEl.innerHTML = ""; return; }
    const rows = [...sKeys].reverse(); // highest strength at top
    heatmapGridsEl.innerHTML = files.map((f, i) => renderOneHeatmap(f, i, rows, eKeys)).join("");
    heatmapGridsEl.querySelectorAll("[data-cell]").forEach((el) => {
      el.addEventListener("click", () => {
        const fid = Number(el.dataset.fileId);
        const sKey = el.dataset.skey === "inf" ? OVERFLOW_KEY : Number(el.dataset.skey);
        const eKey = el.dataset.ekey === "inf" ? OVERFLOW_KEY : Number(el.dataset.ekey);
        const same = selectedCell && selectedCell.fileId === fid && selectedCell.sKey === sKey && selectedCell.eKey === eKey;
        selectedCell = same ? null : { fileId: fid, sKey, eKey };
        renderHeatmapGrids();
        if (selectedCell) showHeatmapSample(selectedCell);
        else { heatmapSampleBox.classList.add("hidden"); heatmapSampleBox.innerHTML = ""; }
      });
    });
  }

  function renderOneHeatmap(f, i, rows, cols) {
    const color = FILE_COLORS[i % FILE_COLORS.length];
    const grid = heatGrids.get(f.id);
    const total = f.parsedData.parsed;
    const colHeaderCells = cols.map((eKey) =>
      `<div style="font-size:11px;color:var(--text-secondary);text-align:center;padding:2px">${bucketLabel(eKey, eCutoff, ENTROPY_BUCKET_WIDTH)}</div>`
    ).join("");
    const bodyRows = rows.map((sKey) => {
      const rowLabel = `<div style="font-size:11px;color:var(--text-secondary);display:flex;align-items:center;justify-content:flex-end;padding-right:4px">${bucketLabel(sKey, sCutoff)}</div>`;
      const rowCells = cols.map((eKey) => {
        const cell = grid.get(`${sKey},${eKey}`);
        const count = cell ? cell.count : 0;
        const share = total ? (count / total) * 100 : 0;
        const intensity = heatMaxShare > 0 ? Math.min(1, share / heatMaxShare) : 0;
        const bg = count ? hexA(HEAT_COLOR, Math.min(0.92, 0.1 + intensity * 0.82)) : cssVar("--surface-2");
        const selected = selectedCell && selectedCell.fileId === f.id && selectedCell.sKey === sKey && selectedCell.eKey === eKey;
        const border = selected ? `2px solid ${SELECTED_OUTLINE}` : "1px solid var(--border)";
        const skeyAttr = sKey === OVERFLOW_KEY ? "inf" : sKey;
        const ekeyAttr = eKey === OVERFLOW_KEY ? "inf" : eKey;
        return `<div data-cell data-file-id="${f.id}" data-skey="${skeyAttr}" data-ekey="${ekeyAttr}"
          title="strength ${bucketRangeLabel(sKey, sCutoff)} × entropy ${bucketRangeLabel(eKey, eCutoff, ENTROPY_BUCKET_WIDTH)}: ${count.toLocaleString()} words (${round1(share)}%)"
          style="aspect-ratio:1;border-radius:3px;cursor:pointer;background:${bg};border:${border}"></div>`;
      }).join("");
      return `<div style="display:contents">${rowLabel}${rowCells}</div>`;
    }).join("");
    return `
      <div class="card">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;border-left:4px solid ${color};padding-left:8px">
          <strong>${escapeHtml(f.name)}</strong>
          <span class="sub" style="margin:0">${total.toLocaleString()} pairs</span>
        </div>
        <div style="display:grid;grid-template-columns:auto repeat(${cols.length}, minmax(22px,1fr));gap:2px">
          <div></div>${colHeaderCells}${bodyRows}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-tertiary);margin-top:4px">
          <span>entropy (integer part) &rarr;</span>
          <span>&uarr; strength (integer part)</span>
        </div>
      </div>`;
  }

  function showHeatmapSample(sel) {
    const f = files.find((x) => x.id === sel.fileId);
    heatmapSampleBox.classList.remove("hidden");
    if (!f) { heatmapSampleBox.innerHTML = ""; return; }
    const grid = heatGrids.get(f.id);
    const cell = grid.get(`${sel.sKey},${sel.eKey}`);
    if (!cell || !cell.count) {
      heatmapSampleBox.innerHTML = `
        <div class="card" style="margin-top:10px">
          <strong>${escapeHtml(f.name)}</strong>
          <span class="sub" style="margin:0">no words in this cell</span>
        </div>`;
      return;
    }
    const sample = shuffled(cell.pools.flat());
    const shown = sample.slice(0, SAMPLE_SHOW);
    const sampledNote = cell.count > sample.length
      ? ` (reservoir-sampled from ${cell.count.toLocaleString()} words)`
      : "";
    heatmapSampleBox.innerHTML = `
      <div class="card" style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px">
          <div>
            <strong>${escapeHtml(f.name)}</strong>
            <span class="sub" style="margin:0">strength ${bucketRangeLabel(sel.sKey, sCutoff)} · entropy ${bucketRangeLabel(sel.eKey, eCutoff, ENTROPY_BUCKET_WIDTH)}</span>
          </div>
          <div class="sub" style="margin:0">
            ${cell.count.toLocaleString()} words · ${pct(cell.count, f.parsedData.parsed)}% of file ·
            showing ${shown.length.toLocaleString()}${sampledNote}
          </div>
        </div>
        <div style="max-height:220px;overflow:auto;border:0.5px solid var(--border);border-radius:var(--radius-md);padding:8px 10px;background:var(--surface-2)">
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px">
            ${shown.map((w) => `<span>${escapeHtml(w)}</span>`).join("")}
          </div>
        </div>
      </div>`;
  }

  function showError(html) {
    msg.className = "card danger";
    msg.style.marginTop = "10px";
    msg.innerHTML = html;
  }

  mountFinishButton(mount, { sceneId: "score-histogram", label: "Score histogram" });
}

function describeMode(mode) {
  return mode === "2d" ? "strength+entropy" : "single-score";
}

// ── parser ───────────────────────────────────────────────────────────────
// "<score> word" — a leading floating-point score, whitespace, then the
// word (the rest of the line, trimmed).
const LINE_RE_1 = /^\s*(-?\d+(?:\.\d+)?)\s+(\S.*?)\s*$/;
// "<strength> <entropy> word" — two floating-point values, then the word.
const LINE_RE_2 = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\S.*?)\s*$/;

// Auto-detects the line format from whichever pattern the first parseable
// line matches (2-value tried first, since a 2-value line's second number
// would otherwise get swallowed into a 1-value line's "word" capture), then
// locks the file to that format — lines that don't fit are skipped rather
// than switching mode mid-file. Blank lines are always skipped.
export function parseFile(text) {
  const lines = text.split(/\r?\n/);
  let mode = null;
  let parsed = 0, skipped = 0;

  // 1D ("histogram") accumulators.
  const buckets = new Map(); // integer key -> { count, sample: [] }
  let min = Infinity, max = -Infinity;

  // 2D ("heatmap") accumulators.
  const cells = new Map(); // "sx,ey" -> { sx, ey, count, sample: [] }
  let minS = Infinity, maxS = -Infinity, minE = Infinity, maxE = -Infinity;

  for (const raw of lines) {
    if (!raw) continue;

    if (mode !== "1d") {
      const m2 = raw.match(LINE_RE_2);
      if (m2) {
        const s = parseFloat(m2[1]);
        const e = parseFloat(m2[2]);
        const word = m2[3];
        if (Number.isFinite(s) && Number.isFinite(e) && word) {
          mode = "2d";
          parsed++;
          if (s < minS) minS = s;
          if (s > maxS) maxS = s;
          if (e < minE) minE = e;
          if (e > maxE) maxE = e;
          const sx = Math.trunc(s);
          const ey = Math.floor(e / ENTROPY_BUCKET_WIDTH) * ENTROPY_BUCKET_WIDTH;
          const key = `${sx},${ey}`;
          let c = cells.get(key);
          if (!c) { c = { sx, ey, count: 0, sample: [] }; cells.set(key, c); }
          addToReservoir(c, word);
          continue;
        }
      }
    }

    if (mode !== "2d") {
      const m1 = raw.match(LINE_RE_1);
      if (m1) {
        const value = parseFloat(m1[1]);
        const word = m1[2];
        if (Number.isFinite(value) && word) {
          mode = "1d";
          parsed++;
          if (value < min) min = value;
          if (value > max) max = value;
          const key = Math.trunc(value);
          let b = buckets.get(key);
          if (!b) { b = { count: 0, sample: [] }; buckets.set(key, b); }
          addToReservoir(b, word);
          continue;
        }
      }
    }

    if (raw.trim()) skipped++;
  }

  if (mode === "2d") {
    return {
      mode, cells, parsed, skipped,
      minS: parsed ? minS : null, maxS: parsed ? maxS : null,
      minE: parsed ? minE : null, maxE: parsed ? maxE : null,
    };
  }
  return { mode: "1d", buckets, parsed, skipped, min: parsed ? min : null, max: parsed ? max : null };
}

// Reservoir sampling (Algorithm R) — keeps an unbiased sample of up to
// SAMPLE_CAP words per bucket/cell without ever holding the whole thing in
// memory.
function addToReservoir(bucket, word) {
  bucket.count++;
  if (bucket.sample.length < SAMPLE_CAP) {
    bucket.sample.push(word);
  } else {
    const j = Math.floor(Math.random() * bucket.count);
    if (j < SAMPLE_CAP) bucket.sample[j] = word;
  }
}

// Finds the smallest integer key K such that folding every bucket >= K
// keeps its combined share (against `total`) strictly below OVERFLOW_SHARE.
// Grows from the top down, one integer bucket at a time, stopping the
// moment adding the next one down would reach the threshold. Returns null
// when there's nothing worth folding (fewer than two buckets, or even the
// single highest bucket already meets/exceeds the threshold alone). Shared
// by the histogram's single axis and the heatmap's two independent axes.
function computeCutoffFromCounts(countsByKey, total) {
  if (!total) return null;
  const keysDesc = [...countsByKey.keys()].sort((a, b) => b - a);
  if (keysDesc.length < 2) return null;

  let cumulative = 0;
  let cutoff = null;
  for (const k of keysDesc) {
    const tentative = cumulative + countsByKey.get(k);
    if (tentative / total >= OVERFLOW_SHARE) break;
    cumulative = tentative;
    cutoff = k;
  }
  return cutoff !== null && cutoff !== keysDesc[0] ? cutoff : null;
}

// ── 1D (histogram) helpers ───────────────────────────────────────────────
function computeCutoff(filesList) {
  const combined = new Map(); // integer key -> count summed across files
  let total = 0;
  for (const f of filesList) {
    total += f.parsedData.parsed;
    for (const [k, b] of f.parsedData.buckets) combined.set(k, (combined.get(k) || 0) + b.count);
  }
  return computeCutoffFromCounts(combined, total);
}

// Bucket keys sorted ascending, unioned across every loaded file, with empty
// integer buckets in between filled in (count 0) so the histogram's gaps are
// visible rather than compressed away. Everything from `cutoff` up is
// replaced by a single trailing overflow key (see computeCutoff).
function fillBucketRange(filesList, cutoff) {
  const allKeys = new Set();
  for (const f of filesList) for (const k of f.parsedData.buckets.keys()) allKeys.add(k);
  if (!allKeys.size) return [];
  const finite = [...allKeys].sort((a, b) => a - b);
  const lo = finite[0];
  const hi = cutoff != null ? cutoff - 1 : finite[finite.length - 1];
  const out = [];
  for (let k = lo; k <= hi; k++) out.push(k);
  if (cutoff != null) out.push(OVERFLOW_KEY);
  return out;
}

// Aggregates one file's count + a pooled sample for a displayed bucket key.
// For the overflow key this sums every one of the file's integer buckets
// >= cutoff and pools their samples (each source sample is already a random
// subset of its own bucket — shuffling the pooled union keeps sample.slice()
// unbiased for display, at the same "for illustration, not exact stats"
// fidelity as the per-bucket reservoir it draws from).
function bucketDataForFile(f, key, cutoff) {
  if (key !== OVERFLOW_KEY) {
    const b = f.parsedData.buckets.get(key);
    return b ? b : { count: 0, sample: [] };
  }
  let count = 0;
  const pools = [];
  for (const [k, b] of f.parsedData.buckets) {
    if (k >= cutoff) { count += b.count; pools.push(b.sample); }
  }
  return { count, sample: shuffled(pools.flat()) };
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Human label for a bucket key — the overflow bucket reads "≥N" rather than
// "Infinity"; a bucket wider than 1 (the heatmap's entropy axis) reads as
// "N–M" for its inclusive integer span. Shared by both axes of the heatmap
// and the histogram.
function bucketLabel(key, cutoff, width = 1) {
  if (key === OVERFLOW_KEY) return `≥${cutoff}`;
  return width > 1 ? `${key}–${key + width - 1}` : String(key);
}

// The half-open interval a bucket covers, for tooltips/headers.
function bucketRangeLabel(key, cutoff, width = 1) {
  return key === OVERFLOW_KEY ? `[${cutoff}, ∞)` : `[${key}, ${key + width})`;
}

// ── 2D (heatmap) helpers ─────────────────────────────────────────────────
function computeAxisCutoffs(filesList) {
  const sCounts = new Map(), eCounts = new Map();
  let total = 0;
  for (const f of filesList) {
    total += f.parsedData.parsed;
    for (const c of f.parsedData.cells.values()) {
      sCounts.set(c.sx, (sCounts.get(c.sx) || 0) + c.count);
      eCounts.set(c.ey, (eCounts.get(c.ey) || 0) + c.count);
    }
  }
  return {
    strengthCutoff: computeCutoffFromCounts(sCounts, total),
    entropyCutoff: computeCutoffFromCounts(eCounts, total),
  };
}

// Same idea as fillBucketRange, but for one axis of the heatmap — pulls
// keys from cell.sx or cell.ey (per `axisProp`) across every loaded file.
// `step` is the bucket width along this axis (1 for strength, entropy uses
// ENTROPY_BUCKET_WIDTH — cell.ey is already pre-aligned to that band at
// parse time, so keys here are naturally spaced `step` apart).
function axisRange(filesList, axisProp, cutoff, step = 1) {
  const allKeys = new Set();
  for (const f of filesList) for (const c of f.parsedData.cells.values()) allKeys.add(c[axisProp]);
  if (!allKeys.size) return [];
  const finite = [...allKeys].sort((a, b) => a - b);
  const lo = finite[0];
  const hi = cutoff != null ? cutoff - step : finite[finite.length - 1];
  const out = [];
  for (let k = lo; k <= hi; k += step) out.push(k);
  if (cutoff != null) out.push(OVERFLOW_KEY);
  return out;
}

// Re-buckets one file's raw (sx, ey) cells onto the displayed axis keys
// (folding anything past each axis's cutoff into that axis's overflow key),
// merging counts and pooling samples for cells that collapse together.
function buildDisplayGrid(f, sCutoff, eCutoff) {
  const grid = new Map();
  for (const c of f.parsedData.cells.values()) {
    const sKey = (sCutoff != null && c.sx >= sCutoff) ? OVERFLOW_KEY : c.sx;
    const eKey = (eCutoff != null && c.ey >= eCutoff) ? OVERFLOW_KEY : c.ey;
    const key = `${sKey},${eKey}`;
    let g = grid.get(key);
    if (!g) { g = { count: 0, pools: [] }; grid.set(key, g); }
    g.count += c.count;
    g.pools.push(c.sample);
  }
  return grid;
}

// ── meta ─────────────────────────────────────────────────────────────────
function renderMeta(filesList, bucketCount) {
  const perFile = filesList.map((f, i) => {
    const p = f.parsedData;
    const color = FILE_COLORS[i % FILE_COLORS.length];
    return `
      <div class="card" style="min-width:220px;flex:1 1 220px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block"></span>
          <strong style="font-size:13px">${escapeHtml(f.name)}</strong>
        </div>
        <table class="kv">
          <tr><td>Parsed pairs</td><td>${p.parsed.toLocaleString()}</td></tr>
          <tr><td>Skipped lines</td><td>${p.skipped.toLocaleString()}</td></tr>
          <tr><td>Score range</td><td>${formatScore(p.min)} – ${formatScore(p.max)}</td></tr>
        </table>
      </div>`;
  }).join("");
  return `
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px">${perFile}</div>
    <div class="sub" style="margin:0 0 6px">Buckets spanned: ${bucketCount.toLocaleString()}</div>
  `;
}

function renderMeta2D(filesList) {
  const perFile = filesList.map((f, i) => {
    const p = f.parsedData;
    const color = FILE_COLORS[i % FILE_COLORS.length];
    return `
      <div class="card" style="min-width:220px;flex:1 1 220px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block"></span>
          <strong style="font-size:13px">${escapeHtml(f.name)}</strong>
        </div>
        <table class="kv">
          <tr><td>Parsed pairs</td><td>${p.parsed.toLocaleString()}</td></tr>
          <tr><td>Skipped lines</td><td>${p.skipped.toLocaleString()}</td></tr>
          <tr><td>Strength range</td><td>${formatScore(p.minS)} – ${formatScore(p.maxS)}</td></tr>
          <tr><td>Entropy range</td><td>${formatScore(p.minE)} – ${formatScore(p.maxE)}</td></tr>
        </table>
      </div>`;
  }).join("");
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px">${perFile}</div>`;
}

// ── chart (histogram mode) ───────────────────────────────────────────────
function renderChart(canvas, prev, keys, datasets, filesList, cutoff, onPick) {
  if (prev) prev.destroy();

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: keys.map((k) => bucketLabel(k, cutoff)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onHover: (evt, elements) => {
        evt.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
      onClick: (evt) => {
        const points = chart.getElementsAtEventForMode(evt, "nearest", { intersect: true }, true);
        if (!points.length) return;
        onPick(keys[points[0].index]);
      },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: cssVar("--text-secondary") },
        },
        annotation: { annotations: scoreZoneAnnotations(keys) },
        tooltip: {
          callbacks: {
            title: (items) => {
              const key = keys[items[0].dataIndex];
              return `bucket ${bucketLabel(key, cutoff)} · ${bucketRangeLabel(key, cutoff)}`;
            },
            label: (ctx) => {
              const count = ctx.dataset._counts?.[ctx.dataIndex] ?? 0;
              return `${ctx.dataset.label}: ${round1(ctx.parsed.y)}% of corpus (${count.toLocaleString()} words) — click to see a sample`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "score (integer part)", color: cssVar("--text-secondary") },
          ticks: { color: cssVar("--text-secondary") },
          grid: { color: cssVar("--surface-3") },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "% of corpus", color: cssVar("--text-secondary") },
          ticks: { color: cssVar("--text-secondary"), callback: (v) => `${round1(v)}%` },
          grid: { color: cssVar("--surface-3") },
        },
      },
    },
  });
  return chart;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function pct(part, whole) {
  if (!whole) return "0.0";
  return ((part / whole) * 100).toFixed(1);
}

function round1(x) { return Math.round(x * 10) / 10; }

function formatScore(v) {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function hexA(hex, alpha) {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `#${m[1]}${a}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
