// Scene — Score histogram.
//
// Upload one or more text files, each with one "<score> word" pair per line
// (a floating-point score of varying precision, a space, then a word — e.g.
// a guess-probability or scoring-model output like `1.234 password`). Bars
// group words by the score's integer part (bucket "2" = scores in [2, 3));
// the highest-scoring buckets are folded into one overflow bucket, grown
// dynamically from the top down for as long as it holds strictly less than
// OVERFLOW_SHARE of the (combined, across every loaded file) corpus — so a
// long thin tail of outlier scores can't stretch the axis into an unreadable
// smear.
// Multiple files render as grouped bars per bucket (as a % of each file's
// own corpus, so distributions are comparable across differently-sized
// files), one colour per file. Click a bar to see a sample of the words
// that landed in that bucket, broken out per file. Everything is parsed in
// the browser — files are never uploaded, keeping this plan-only.

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

// The overflow bucket collects the highest-scoring integer buckets, growing
// downward from the top, for as long as their combined share of the (all
// loaded files combined) corpus stays strictly below this fraction. Datasets
// tend to have a long, thin tail of high scores — this keeps that tail from
// stretching the axis into an unreadable smear while capping how much of
// the corpus it can hide. Recomputed on every add/remove — see computeCutoff.
const OVERFLOW_SHARE = 0.01;
// Sentinel bucket key for "the dynamic overflow bucket". Infinity sorts
// after every finite key with a plain numeric comparator, so it always
// lands last.
const OVERFLOW_KEY = Infinity;

// Cap on how many words we keep per bucket, via reservoir sampling — so a
// multi-million-line file doesn't balloon browser memory just to show a
// sample. Every word still counts toward the bucket total; only the *kept
// sample* is capped and unbiased (see addToReservoir).
const SAMPLE_CAP = 500;
// How many sampled words to actually display at once, per file.
const SAMPLE_SHOW = 20;

// Chart.js can't resolve CSS custom properties — resolve to real hex/rgb so
// axis labels/ticks pick up the current theme. (Same trick as keyspace.js.)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Fixed score-quality rubric, shaded behind the bars as a stoplight ramp
// (red → orange → yellow → light green → green) so a bucket's score band
// reads at a glance regardless of which file(s) are loaded. `max` is
// exclusive — a zone covers [previous max, this max).
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
// bars, mapped from score-space onto the category (bucket) axis. Buckets
// are contiguous integers starting at keys[0], so bucket "score" sits at
// index (score - keys[0]); a zone boundary at `score` falls on the left
// edge of that bucket's column, i.e. index (score - keys[0]) - 0.5. The
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
        Upload one or more text files, each with one <code>&lt;score&gt; word</code> pair per line — a
        floating-point score, a space, then a word (e.g. <code>1.234 password</code>). Bars group words by
        the score's integer part, so <code>2.0</code>–<code>2.99…</code> all land in bucket "2"; the highest
        buckets are folded into one overflow bucket, grown from the top down for as long as it holds under
        ${OVERFLOW_SHARE * 100}% of the corpus, so a long thin tail can't stretch the axis into an unreadable
        smear. Multiple files are drawn as grouped bars, one colour per file, so
        distributions can be compared directly. Click a bar to see a sample of the words inside it, broken
        out per file. Parsed in your browser — nothing is uploaded.
      </div>

      <div id="drop" style="border:1px dashed var(--border-2);border-radius:8px;padding:24px;text-align:center;color:var(--text-secondary);margin-bottom:10px">
        <input type="file" id="scorefile" accept=".txt,.csv,text/plain" multiple style="display:none"/>
        <button id="pick" class="primary" style="padding:10px 18px">Upload files</button>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">or drop files here · one <code>&lt;score&gt; word</code> pair per line · multiple files are compared side by side</div>
      </div>
      <div id="filebox" style="margin-bottom:10px"></div>

      <div id="msg"></div>
      <div id="meta"></div>
      <div class="chart-wrap hidden" id="chart-wrap" style="height:360px">
        <canvas id="chart"></canvas>
      </div>
      <div id="zone-legend" class="hidden" style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px">${renderZoneLegend()}</div>
      <div id="note" class="note hidden"></div>
      <div id="sample" class="hidden"></div>
    </div>
  `;

  const fileInput = mount.querySelector("#scorefile");
  const drop = mount.querySelector("#drop");
  const fileBox = mount.querySelector("#filebox");
  const msg = mount.querySelector("#msg");
  const meta = mount.querySelector("#meta");
  const chartWrap = mount.querySelector("#chart-wrap");
  const zoneLegend = mount.querySelector("#zone-legend");
  const note = mount.querySelector("#note");
  const sampleBox = mount.querySelector("#sample");
  let chart = null;
  let files = [];        // [{ id, name, parsedData }] — parsedData = parseScoreFile() result
  let nextFileId = 0;
  let keys = [];          // sorted bucket keys (union across files), gaps filled
  let cutoff = null;      // smallest integer key folded into the overflow bucket (null = no overflow)
  let selectedKey = null;

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
      const parsed = parseScoreFile(text);
      if (!parsed.parsed) {
        errors.push(`no <code>&lt;score&gt; word</code> pairs found in ${escapeHtml(p.name)}`);
        continue;
      }
      files.push({ id: nextFileId++, name: p.name, parsedData: parsed });
    }
    if (errors.length) showError(errors.join("<br>"));
    else { msg.className = ""; msg.innerHTML = ""; }

    selectedKey = null;
    refresh();
  }

  function removeFile(id) {
    files = files.filter((f) => f.id !== id);
    selectedKey = null;
    refresh();
  }

  function refresh() {
    renderFileChips();
    if (!files.length) {
      meta.innerHTML = "";
      chartWrap.classList.add("hidden");
      zoneLegend.classList.add("hidden");
      note.classList.add("hidden");
      sampleBox.classList.add("hidden");
      sampleBox.innerHTML = "";
      if (chart) { chart.destroy(); chart = null; }
      return;
    }
    cutoff = computeCutoff(files);
    keys = fillBucketRange(files, cutoff);
    meta.innerHTML = renderMeta(files, keys.length);
    chartWrap.classList.remove("hidden");
    zoneLegend.classList.remove("hidden");
    note.classList.remove("hidden");
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

  function showError(html) {
    msg.className = "card danger";
    msg.style.marginTop = "10px";
    msg.innerHTML = html;
  }

  mountFinishButton(mount, { sceneId: "score-histogram", label: "Score histogram" });
}

// ── "<score> word" parser ───────────────────────────────────────────────────
// One "<float> word" pair per line — a leading floating-point score of any
// precision, whitespace, then the word (the rest of the line, trimmed).
// Blank lines are skipped; lines that don't match are counted as skipped
// rather than aborting the whole file.
const LINE_RE = /^\s*(-?\d+(?:\.\d+)?)\s+(\S.*?)\s*$/;

export function parseScoreFile(text) {
  const lines = text.split(/\r?\n/);
  const buckets = new Map(); // integer-part key -> { count, sample: [] }
  let parsed = 0, skipped = 0;
  let min = Infinity, max = -Infinity;

  for (const raw of lines) {
    if (!raw) continue;
    const m = raw.match(LINE_RE);
    if (!m) { if (raw.trim()) skipped++; continue; }
    const value = parseFloat(m[1]);
    const word = m[2];
    if (!Number.isFinite(value) || !word) { skipped++; continue; }
    parsed++;
    if (value < min) min = value;
    if (value > max) max = value;
    const key = Math.trunc(value);
    let b = buckets.get(key);
    if (!b) { b = { count: 0, sample: [] }; buckets.set(key, b); }
    addToReservoir(b, word);
  }

  return { buckets, parsed, skipped, min: parsed ? min : null, max: parsed ? max : null };
}

// Reservoir sampling (Algorithm R) — keeps an unbiased sample of up to
// SAMPLE_CAP words per bucket without ever holding the whole bucket in memory.
function addToReservoir(bucket, word) {
  bucket.count++;
  if (bucket.sample.length < SAMPLE_CAP) {
    bucket.sample.push(word);
  } else {
    const j = Math.floor(Math.random() * bucket.count);
    if (j < SAMPLE_CAP) bucket.sample[j] = word;
  }
}

// Finds the smallest integer key K such that folding every bucket >= K into
// one overflow bucket keeps its combined share (summed across every loaded
// file, against the combined corpus size) strictly below OVERFLOW_SHARE.
// Grows from the top down, one integer bucket at a time, stopping the
// moment adding the next one down would reach the threshold. Returns null
// when there's nothing worth folding (fewer than two buckets, or even the
// single highest bucket already meets/exceeds the threshold alone).
function computeCutoff(filesList) {
  const combined = new Map(); // integer key -> count summed across files
  let total = 0;
  for (const f of filesList) {
    total += f.parsedData.parsed;
    for (const [k, b] of f.parsedData.buckets) combined.set(k, (combined.get(k) || 0) + b.count);
  }
  if (!total) return null;
  const keysDesc = [...combined.keys()].sort((a, b) => b - a);
  if (keysDesc.length < 2) return null;

  let cumulative = 0;
  let cutoff = null;
  for (const k of keysDesc) {
    const tentative = cumulative + combined.get(k);
    if (tentative / total >= OVERFLOW_SHARE) break;
    cumulative = tentative;
    cutoff = k;
  }
  // Only worth an overflow bucket if it folds in more than one integer bucket.
  return cutoff !== null && cutoff !== keysDesc[0] ? cutoff : null;
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

// Human label for a bucket key — the overflow bucket reads "≥N" rather
// than "Infinity".
function bucketLabel(key, cutoff) {
  return key === OVERFLOW_KEY ? `≥${cutoff}` : String(key);
}

// The half-open interval a bucket covers, for tooltips/headers.
function bucketRangeLabel(key, cutoff) {
  return key === OVERFLOW_KEY ? `[${cutoff}, ∞)` : `[${key}, ${key + 1})`;
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

// ── chart ──────────────────────────────────────────────────────────────────
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
