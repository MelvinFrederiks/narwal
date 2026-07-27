// Scene — Score histogram.
//
// Upload one or more text files, each with one "<score> word" pair per line
// (a floating-point score of varying precision, a space, then a word — e.g.
// a guess-probability or scoring-model output like `1.234 password`). Bars
// group words by the score's integer part (bucket "2" = scores in [2, 3));
// everything past the cutoff is collected into one overflow bucket so a
// handful of outlier scores can't stretch the axis into an unreadable long
// tail. Multiple files render as grouped bars per bucket, one colour per
// file, so distributions can be compared directly. Click a bar to see a
// sample of the words that landed in that bucket, broken out per file.
// Everything is parsed in the browser — files are never uploaded, keeping
// this plan-only.

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

// Scores at or past this cut off into one shared overflow bucket — see
// module doc above.
const OVERFLOW_AT = 10;
// Sentinel bucket key for "score > OVERFLOW_AT". Infinity sorts after every
// finite key with a plain numeric comparator, so it always lands last.
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

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Score histogram</h2>
      <div class="sub">
        Upload one or more text files, each with one <code>&lt;score&gt; word</code> pair per line — a
        floating-point score, a space, then a word (e.g. <code>1.234 password</code>). Bars group words by
        the score's integer part, so <code>2.0</code>–<code>2.99…</code> all land in bucket "2"; everything
        above ${OVERFLOW_AT} is collected into one <code>&gt;${OVERFLOW_AT}</code> bucket. Multiple files are
        drawn as grouped bars, one colour per file, so distributions can be compared directly. Click a bar to
        see a sample of the words inside it, broken out per file. Parsed in your browser — nothing is uploaded.
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
  const note = mount.querySelector("#note");
  const sampleBox = mount.querySelector("#sample");
  let chart = null;
  let files = [];        // [{ id, name, parsedData }] — parsedData = parseScoreFile() result
  let nextFileId = 0;
  let keys = [];          // sorted bucket keys (union across files), gaps filled
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
      note.classList.add("hidden");
      sampleBox.classList.add("hidden");
      sampleBox.innerHTML = "";
      if (chart) { chart.destroy(); chart = null; }
      return;
    }
    keys = fillBucketRange(files);
    meta.innerHTML = renderMeta(files, keys.length);
    chartWrap.classList.remove("hidden");
    note.classList.remove("hidden");
    note.innerHTML =
      `Bars show each file's share of its own corpus per integer-score bucket (bucket "n" = scores in ` +
      `[n, n+1)), so distributions are comparable across files of different sizes; scores above ` +
      `${OVERFLOW_AT} are pooled into one ">${OVERFLOW_AT}" bucket. Words are sampled — up to ${SAMPLE_CAP} ` +
      `kept per bucket per file by reservoir sampling, so the sample stays representative even for buckets ` +
      `with millions of hits. Click a bar to see its sample, per file.` +
      (files.length > FILE_COLORS.length
        ? ` Only ${FILE_COLORS.length} distinct colours are used — file colours repeat past that many files.`
        : "");
    draw();
    if (selectedKey != null && files.some((f) => f.parsedData.buckets.has(selectedKey))) showSample(selectedKey);
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
      const counts = keys.map((k) => f.parsedData.buckets.get(k)?.count ?? 0);
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
    chart = renderChart(mount.querySelector("#chart"), chart, keys, datasets, files, (key) => {
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
      const b = f.parsedData.buckets.get(key);
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
      <div style="margin-top:14px"><strong>Bucket ${bucketLabel(key)}</strong> <span class="sub" style="margin:0">${bucketRangeLabel(key)}</span></div>
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
    const key = value > OVERFLOW_AT ? OVERFLOW_KEY : Math.trunc(value);
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

// Bucket keys sorted ascending, unioned across every loaded file, with empty
// integer buckets in between filled in (count 0) so the histogram's gaps are
// visible rather than compressed away. The overflow bucket (if present in
// any file) is always appended last.
function fillBucketRange(filesList) {
  const allKeys = new Set();
  for (const f of filesList) for (const k of f.parsedData.buckets.keys()) allKeys.add(k);
  if (!allKeys.size) return [];
  const finite = [...allKeys].filter((k) => Number.isFinite(k)).sort((a, b) => a - b);
  const hasOverflow = allKeys.has(OVERFLOW_KEY);
  if (!finite.length) return hasOverflow ? [OVERFLOW_KEY] : [];
  const lo = finite[0], hi = finite[finite.length - 1];
  const out = [];
  for (let k = lo; k <= hi; k++) out.push(k);
  if (hasOverflow) out.push(OVERFLOW_KEY);
  return out;
}

// Human label for a bucket key — the overflow bucket reads ">10" rather
// than "Infinity".
function bucketLabel(key) {
  return key === OVERFLOW_KEY ? `>${OVERFLOW_AT}` : String(key);
}

// The half-open interval a bucket covers, for tooltips/headers.
function bucketRangeLabel(key) {
  return key === OVERFLOW_KEY ? `(${OVERFLOW_AT}, ∞)` : `[${key}, ${key + 1})`;
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
function renderChart(canvas, prev, keys, datasets, filesList, onPick) {
  if (prev) prev.destroy();

  const chart = new Chart(canvas, {
    type: "bar",
    data: { labels: keys.map(bucketLabel), datasets },
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
        tooltip: {
          callbacks: {
            title: (items) => {
              const key = keys[items[0].dataIndex];
              return `bucket ${bucketLabel(key)} · ${bucketRangeLabel(key)}`;
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
