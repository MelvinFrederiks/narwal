// Scene — Mask analysis.
//
// Upload one or more PACK statsgen `.masks` files (mask,count per line — e.g.
// ~/tools/pack/results/rockyou.masks) and compare them:
//   · bars   — password-length distribution as % of each corpus's own total
//              (so different-sized corpora compare fairly), grouped
//              side-by-side across the uploaded corpora.
//   · lines  — per-character-class keyspace coverage: for each set (digits,
//              lowercase, alpha, alphanum) the fraction of that set's keyspace
//              the corpus spans at each length — count(masks fitting the set)
//              ÷ (alphabet ^ length).
//
// Each corpus keeps the same hue per class; the 2nd+ corpus is drawn with
// reduced saturation (and dashed lines) so the comparison is legible. A floor
// slider sets how deep into the coverage tail to look. Everything is parsed in
// the browser — files are never uploaded, keeping this plan-only.

import { listServerFiles, serverFilePickerHtml, wireServerFilePicker } from "../util/serverFiles.js";

export const name = "keyspace";

const ACCENT = "#534AB7"; // length bars (purple — storyboard)

// Length-histogram bars: one color per corpus. Distinct hues (not a
// saturation fade of ACCENT) so the 2nd, 3rd, 4th+ datasets stay legible
// side by side instead of collapsing into similar pale purples.
const BAR_PALETTE = [ACCENT, "#D85A30", "#2E8B6E", "#3B82C4", "#B0447E", "#C9A227"];

// Per-token class bits. A mask's "signature" is the OR of its tokens' bits;
// any non-class token (a literal) sets OTHER_BIT so it can't belong to a set.
const CLASS_BIT = { "?l": 1, "?u": 2, "?d": 4, "?s": 8 };
const OTHER_BIT = 16;

// Character-class categories are derived from the uploaded masks, not fixed
// (see buildCategories): every class-combination present becomes a selectable
// category ranked by frequency. A mask belongs to a category if every token is
// within it (signature ⊆ allowed). These constants drive keyspace size, human
// names, and colours.
const CLASS_SIZE = { 1: 26, 2: 26, 4: 10, 8: 33 }; // ?l ?u ?d ?s
const COMBO_NAMES = {
  0b0001: "lowercase",
  0b0010: "uppercase",
  0b0100: "digits",
  0b1000: "special",
  0b0011: "alpha",         // l+u
  0b0101: "loweralphanum", // l+d
  0b0111: "alphanum",      // l+u+d
  0b1111: "all",           // l+u+d+s
};
const CAT_PALETTE = [
  "#BA7517", "#2E8B6E", "#D85A30", "#3B82C4",
  "#8E5AB8", "#4B9E3A", "#C13A5B", "#3AA0A0",
];
const MAX_CATS = 8;       // how many top categories to offer as toggles
const DEFAULT_CATS = 4;   // how many to pre-select on first load

// Coverage spans an enormous dynamic range (1.0 → below 1e-100). The log-axis
// top is fixed at 100%; the bottom (floor) is user-driven via the slider so the
// analyst chooses how deep into the tail to look. Points below the floor clip
// off the bottom — the tooltip still shows the real value.
const COV_MAX = 1;

const NOTE_BASE =
  "Coverage = (passwords whose mask fits the category) ÷ (alphabet<sup>len</sup>), on a log axis. " +
  "Categories are the most frequent character-class combinations in your file(s) — toggle them above. " +
  "Bars are % of each corpus; the 2nd+ corpus is faded (and dashed). An exponential fit over the whole " +
  "dataset (clamped at 100%), weighted by how many passwords sit at each length so it tracks where the " +
  "corpus actually lives instead of being pulled off by sparse tail lengths, feeds the collapsed " +
  "'more/rarer than trend' tables below. Click a legend entry to toggle a series.";

// Chart.js can't resolve CSS custom properties — resolve to real hex/rgb so
// axis labels/ticks pick up the current theme. (Same trick as coverage.js.)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export async function render(mount) {
  // Charts read better with more room than the shared #view's default
  // 1200px cap (see app.js: `main { max-width: 1200px }`) — widen just this
  // scene; app.js resets it on the next scene change so it can't leak.
  mount.style.maxWidth = "1600px";
  mount.innerHTML = `
    <div class="panel">
      <h2>Mask analysis</h2>
      <div class="sub">
        Upload one or more PACK statsgen <code>.masks</code> files (<code>mask,count</code> per line)
        to compare corpora. Bars are length distributions (grouped by corpus); lines are per-class
        keyspace coverage. Parsed in your browser — nothing is uploaded.
      </div>

      <div id="drop" style="border:1px dashed var(--border-2);border-radius:8px;padding:24px;text-align:center;color:var(--text-secondary);margin-bottom:10px">
        <input type="file" id="statsfile" accept=".masks,.txt,.csv,text/plain" multiple style="display:none"/>
        <button id="pick" class="primary" style="padding:10px 18px">Upload .masks file(s)</button>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">or drop files here · e.g. <code>rockyou.masks</code> + <code>words.masks</code></div>
        <div id="serverPicker"></div>
      </div>
      <div id="files" style="margin-bottom:10px"></div>

      <div id="msg"></div>
      <div id="meta"></div>
      <div id="cats" class="hidden" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 10px;font-size:12px;color:var(--text-secondary)"></div>
      <div id="controls" class="hidden" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:4px 0 10px;font-size:12px;color:var(--text-secondary)">
        <label style="display:flex;align-items:center;gap:8px;flex:1;min-width:280px">
          <span style="white-space:nowrap">Coverage floor</span>
          <input type="range" id="floor" min="9" max="50" step="1" value="9" style="flex:1;min-width:160px"/>
          <span id="floor-val" style="font-variant-numeric:tabular-nums;white-space:nowrap;min-width:64px">1e-9</span>
        </label>
        <span class="sub" style="margin:0">deepen the floor to watch coverage extend to longer lengths</span>
      </div>
      <div class="chart-wrap hidden" id="chart-wrap">
        <canvas id="chart"></canvas>
      </div>
      <div id="note" class="note hidden"></div>
      <div id="fluct"></div>
      <div id="maskAnalysis"></div>
      <div id="patternAnalysis"></div>
    </div>
  `;

  const fileInput = mount.querySelector("#statsfile");
  const drop = mount.querySelector("#drop");
  const filesBox = mount.querySelector("#files");
  const msg = mount.querySelector("#msg");
  const meta = mount.querySelector("#meta");
  const chartWrap = mount.querySelector("#chart-wrap");
  const note = mount.querySelector("#note");
  const controls = mount.querySelector("#controls");
  const catsBox = mount.querySelector("#cats");
  const fluctBox = mount.querySelector("#fluct");
  const maskAnalysisBox = mount.querySelector("#maskAnalysis");
  const patternAnalysisBox = mount.querySelector("#patternAnalysis");
  const floorInput = mount.querySelector("#floor");
  const floorVal = mount.querySelector("#floor-val");
  let chart = null;
  const datasets = [];   // [{ name, parsed }]
  let categories = [];   // ranked category list for current datasets
  let selected = null;   // Set of selected category keys (allowed-bits); null = uninitialised
  let maskMaster = null; // name of the dataset used as the mask-analysis master corpus
  let maskTop = 15;      // how many top masks to show (15/25/50)
  let maskSort = { key: "count", dir: "desc" }; // current mask-table sort column/direction
  let patternMaster = null;       // name of the dataset used as the pattern-analysis master corpus
  let patternTop = 15;            // how many top patterns to show (15/25/50)
  let patternGrouping = "start1"; // current pattern grouping key (see PATTERN_GROUPINGS)

  // ── uploads ────────────────────────────────────────────────────────────────
  mount.querySelector("#pick").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = ACCENT; });
  drop.addEventListener("dragleave", () => { drop.style.borderColor = "var(--border-2)"; });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.style.borderColor = "var(--border-2)";
    handleFiles(e.dataTransfer.files);
  });

  const serverPickerBox = mount.querySelector("#serverPicker");
  listServerFiles(".masks").then((files) => {
    serverPickerBox.innerHTML = serverFilePickerHtml(files, "keyspace");
    wireServerFilePicker(serverPickerBox, files, "keyspace", ".masks", (file) => handleFiles([file]));
  });

  async function handleFiles(fileList) {
    const files = [...(fileList || [])];
    let added = 0;
    const errors = [];
    for (const file of files) {
      let text;
      try { text = await file.text(); }
      catch { errors.push(`could not read ${file.name}`); continue; }
      const parsed = parseMasks(text);
      if (!parsed.lengths.length) { errors.push(`no masks in ${file.name}`); continue; }
      const existing = datasets.findIndex((d) => d.name === file.name);
      if (existing >= 0) datasets[existing] = { name: file.name, parsed };
      else datasets.push({ name: file.name, parsed });
      added++;
    }
    fileInput.value = ""; // let the same file be re-picked later
    if (errors.length && !added) {
      showError(errors.map(escapeHtml).join("<br>") +
        "<br>Expecting <code>mask,count</code> lines like <code>?l?l?l?l?l?l,601152</code>.");
    } else if (errors.length) {
      showError(errors.map(escapeHtml).join("<br>") + "<br>(other files loaded)");
    } else {
      msg.className = ""; msg.innerHTML = "";
    }
    refresh();
  }

  function removeAt(i) { datasets.splice(i, 1); refresh(); }
  function clearAll() { datasets.length = 0; if (msg) { msg.className = ""; msg.innerHTML = ""; } refresh(); }

  // Rebuild file chips + categories + meta + chart from the current datasets.
  function refresh() {
    renderFileChips(filesBox, datasets, { removeAt, clearAll });
    if (!datasets.length) {
      meta.innerHTML = "";
      catsBox.innerHTML = "";
      fluctBox.innerHTML = "";
      maskAnalysisBox.innerHTML = "";
      patternAnalysisBox.innerHTML = "";
      maskMaster = null;
      patternMaster = null;
      categories = [];
      chartWrap.classList.add("hidden");
      controls.classList.add("hidden");
      catsBox.classList.add("hidden");
      note.classList.add("hidden");
      if (chart) { chart.destroy(); chart = null; }
      return;
    }
    // Re-rank categories from the current files; keep the user's selection where
    // possible, else default to the top few on first load.
    categories = buildCategories(datasets);
    const present = new Set(categories.map((c) => c.allowed));
    if (selected === null) {
      selected = new Set(categories.slice(0, DEFAULT_CATS).map((c) => c.allowed));
    } else {
      selected = new Set([...selected].filter((k) => present.has(k)));
      if (!selected.size) selected = new Set(categories.slice(0, DEFAULT_CATS).map((c) => c.allowed));
    }
    renderCatChips();
    meta.innerHTML = renderMeta(datasets);
    updateMaskAnalysis();
    updatePatternAnalysis();
    chartWrap.classList.remove("hidden");
    controls.classList.remove("hidden");
    catsBox.classList.remove("hidden");
    note.classList.remove("hidden");
    draw();
  }

  function renderCatChips() {
    renderCategoryChips(catsBox, categories, selected, (bits) => {
      if (selected.has(bits)) selected.delete(bits);
      else selected.add(bits);
      renderCatChips();
      draw();
    });
  }

  // Keep maskMaster pointed at a dataset that still exists (fall back to the
  // first one), then (re)render the mask-analysis table for it.
  function updateMaskAnalysis() {
    if (maskMaster && !datasets.some((d) => d.name === maskMaster)) maskMaster = null;
    if (!maskMaster && datasets.length) maskMaster = datasets[0].name;
    renderMaskAnalysis(
      maskAnalysisBox, datasets, maskMaster,
      (name) => { maskMaster = name; updateMaskAnalysis(); },
      maskTop,
      (n) => { maskTop = n; updateMaskAnalysis(); },
      maskSort,
      (key) => {
        maskSort = maskSort.key === key
          ? { key, dir: maskSort.dir === "asc" ? "desc" : "asc" }
          : { key, dir: key === "mask" || key === "category" ? "asc" : "desc" };
        updateMaskAnalysis();
      },
    );
  }

  // Keep patternMaster pointed at a dataset that still exists (fall back to
  // the first one), then (re)render the pattern-analysis table for it.
  function updatePatternAnalysis() {
    if (patternMaster && !datasets.some((d) => d.name === patternMaster)) patternMaster = null;
    if (!patternMaster && datasets.length) patternMaster = datasets[0].name;
    renderPatternAnalysis(
      patternAnalysisBox, datasets, patternMaster,
      (name) => { patternMaster = name; updatePatternAnalysis(); },
      patternTop,
      (n) => { patternTop = n; updatePatternAnalysis(); },
      patternGrouping,
      (key) => { patternGrouping = key; updatePatternAnalysis(); },
    );
  }

  // (Re)draw the chart at the current coverage floor for the selected
  // categories. The floor sets the log-axis minimum; the x-axis extends to the
  // longest length whose coverage (in any corpus) still clears it.
  function draw() {
    if (!datasets.length) return;
    const exp = +floorInput.value; // 9..100 → floor = 1e-<exp>
    const floor = Math.pow(10, -exp);
    floorVal.textContent = `1e-${exp}`;
    const active = categories.filter((c) => selected.has(c.allowed));
    const view = computeView(datasets, floor, active);
    note.innerHTML = NOTE_BASE + capNoteHtml(view);
    const series = buildSeries(datasets, active, view.labels);
    chart = renderChart(mount.querySelector("#chart"), chart, datasets, view.labels, floor, series);
    renderFluctuationTable(fluctBox, series);
  }
  floorInput.addEventListener("input", draw);

  function showError(html) {
    msg.className = "card danger";
    msg.style.marginTop = "10px";
    msg.innerHTML = html;
  }

  mountFinishButton(mount, { sceneId: "keyspace", label: "Mask analysis" });
}

// ── .masks parser ─────────────────────────────────────────────────────────
// PACK statsgen `-o` emits one `mask,count` line per distinct mask, e.g.
//   ?l?l?l?l?l?l,601152
//   ?d?d?d?d,6359
// We aggregate total count per length (token count) and track counts keyed by
// (length, class-signature) so coverage for any set is a subset sum. Banner /
// [*] lines are skipped.
export function parseMasks(text) {
  const lines = text.split(/\r?\n/);
  const byLen = new Map();          // length -> total count
  const byLenSig = new Map();       // length -> Map(signature-bits -> count)
  const byMask = new Map();         // exact mask string -> count

  const lineRe = /^([^,]+),\s*(\d+)\s*$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("[") || line.startsWith("_") ||
        /MaskGen|StatsGen|iphelix/i.test(line)) continue;
    const m = line.match(lineRe);
    if (!m) continue;
    const mask = m[1];
    const count = +m[2];
    const toks = tokenizeMask(mask);
    if (!toks.length) continue;
    const L = toks.length;
    byLen.set(L, (byLen.get(L) || 0) + count);
    byMask.set(mask, (byMask.get(mask) || 0) + count);

    let sig = 0;
    for (const t of toks) sig |= CLASS_BIT[t] || OTHER_BIT;
    let sigMap = byLenSig.get(L);
    if (!sigMap) { sigMap = new Map(); byLenSig.set(L, sigMap); }
    sigMap.set(sig, (sigMap.get(sig) || 0) + count);
  }

  const lengths = [...byLen.entries()]
    .map(([length, count]) => ({ length, count }))
    .sort((a, b) => a.length - b.length);
  const countByLen = byLen;
  const analyzed = lengths.reduce((s, l) => s + l.count, 0);

  const nameMatch = text.match(/Analyzing masks in \[([^\]]*)\]/);
  const corpus = nameMatch ? nameMatch[1] : null;

  return { corpus, analyzed, lengths, byLenSig, countByLen, byMask };
}

// Split a hashcat mask into tokens: `?x` pairs, or single literal chars.
function tokenizeMask(mask) {
  const toks = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "?" && i + 1 < mask.length) {
      toks.push(mask.slice(i, i + 2));
      i++;
    } else {
      toks.push(mask[i]);
    }
  }
  return toks;
}

// Summed count of masks at a length whose class signature fits an alphabet
// (signature ⊆ allowed).
function countForCat(p, length, allowed) {
  const sigMap = p.byLenSig.get(length);
  if (!sigMap) return 0;
  let c = 0;
  for (const [sig, n] of sigMap) {
    if (sig && (sig & allowed) === sig) c += n;
  }
  return c;
}

// Coverage of a set at a given length: countForCat ÷ (size^length). null if no
// such masks exist.
function coverageAt(p, length, s) {
  const c = countForCat(p, length, s.allowed);
  return c > 0 ? c / Math.pow(s.size, length) : null;
}

// ── data-driven categories ─────────────────────────────────────────────────
// A category is a character-class combination (allowed bits). We rank every
// combination present in the uploaded masks by total passwords whose *exact*
// signature matches it — i.e. the most frequent mask class-palettes — then draw
// coverage for the selected ones using subset membership (signature ⊆ allowed).
function buildCategories(datasets) {
  const sigCount = new Map();
  let total = 0;
  for (const d of datasets) {
    total += d.parsed.analyzed;
    for (const [, sigMap] of d.parsed.byLenSig) {
      for (const [sig, c] of sigMap) {
        if (!sig || (sig & OTHER_BIT)) continue; // skip empty / literal-bearing
        sigCount.set(sig, (sigCount.get(sig) || 0) + c);
      }
    }
  }
  const cats = [...sigCount.entries()]
    .map(([allowed, count]) => ({
      allowed,
      size: sizeFor(allowed),
      label: nameFor(allowed),
      count,
      share: total ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CATS);
  cats.forEach((c, i) => { c.color = CAT_PALETTE[i % CAT_PALETTE.length]; });
  return cats;
}

function sizeFor(bits) {
  let s = 0;
  for (const b of [1, 2, 4, 8]) if (bits & b) s += CLASS_SIZE[b];
  return s;
}

function nameFor(bits) {
  if (COMBO_NAMES[bits]) return COMBO_NAMES[bits];
  const parts = [];
  if (bits & 1) parts.push("l");
  if (bits & 2) parts.push("u");
  if (bits & 4) parts.push("d");
  if (bits & 8) parts.push("s");
  return parts.join("+");
}

function renderCategoryChips(box, cats, selected, onToggle) {
  const chips = cats.map((c) => {
    const on = selected.has(c.allowed);
    const dot = on ? c.color : "var(--text-tertiary)";
    return `<button data-bits="${c.allowed}" class="${on ? "primary" : ""}"
      title="alphabet size ${c.size}" style="display:inline-flex;align-items:center;gap:6px;font-size:12px">
      <span style="width:9px;height:9px;border-radius:2px;background:${dot};display:inline-block"></span>
      ${c.label} <span style="opacity:0.7">${(c.share * 100).toFixed(1)}%</span>
    </button>`;
  }).join("");
  box.innerHTML =
    `<span style="white-space:nowrap;margin-right:2px">Categories <span class="sub" style="margin:0;font-size:11px">(by frequency)</span></span>` +
    chips;
  for (const b of box.querySelectorAll("[data-bits]")) {
    b.addEventListener("click", () => onToggle(+b.dataset.bits));
  }
}

// ── file chips + comparison meta ──────────────────────────────────────────
function renderFileChips(box, datasets, { removeAt, clearAll }) {
  if (!datasets.length) { box.innerHTML = ""; return; }
  box.innerHTML = datasets.map((d, i) => {
    const swatch = barColorFor(i);
    const faded = i > 0 ? ` <span class="sub" style="margin:0;font-size:10px">dashed line</span>` : "";
    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border-2);border-radius:14px;font-size:12px;margin:0 6px 6px 0">
      <span style="width:10px;height:10px;border-radius:50%;background:${swatch};display:inline-block"></span>
      ${escapeHtml(d.name)}${faded}
      <button data-rm="${i}" title="remove" style="border:0;background:none;cursor:pointer;color:var(--text-secondary);padding:0 2px;font-size:14px;line-height:1">×</button>
    </span>`;
  }).join("") +
    `<button id="clear-all" style="font-size:12px">clear all</button>`;
  for (const b of box.querySelectorAll("[data-rm]")) {
    b.addEventListener("click", () => removeAt(+b.dataset.rm));
  }
  box.querySelector("#clear-all").addEventListener("click", clearAll);
}

function renderMeta(datasets) {
  const stat = (p) => {
    const total = p.analyzed;
    const min = p.lengths[0].length;
    const max = p.lengths[p.lengths.length - 1].length;
    const mean = total ? p.lengths.reduce((s, l) => s + l.length * l.count, 0) / total : 0;
    const mode = p.lengths.reduce((a, b) => (b.count > a.count ? b : a), p.lengths[0]);
    return {
      corpus: p.corpus,
      total: total.toLocaleString(),
      range: `${min}–${max}`,
      mean: mean.toFixed(1),
      mode: `${mode.length} (${pct(mode.count, total)}%)`,
    };
  };
  const cols = datasets.map((d) => ({ name: d.name, s: stat(d.parsed) }));
  const row = (label, get) =>
    `<tr><td>${label}</td>${cols.map((c) => `<td>${get(c)}</td>`).join("")}</tr>`;
  return `
    <table class="kv">
      <tr><td></td>${cols.map((c) => `<td style="font-weight:600">${escapeHtml(baseName(c.name))}</td>`).join("")}</tr>
      ${row("Corpus", (c) => (c.s.corpus ? escapeHtml(c.s.corpus) : "—"))}
      ${row("Passwords", (c) => c.s.total)}
      ${row("Length range", (c) => c.s.range)}
      ${row("Mean length", (c) => c.s.mean)}
      ${row("Most common length", (c) => c.s.mode)}
    </table>
  `;
}

// ── series + exponential fit ────────────────────────────────────────────────
// Build one plotted series per (corpus × selected category). The fit and the
// residual table are computed over the ENTIRE dataset (every length present) —
// independent of the displayed depth — so they depend only on the selected
// masks, not the floor slider. Only covData (what's drawn) is restricted to
// the displayed `labels`. The fit itself isn't plotted on the chart — it only
// feeds the "more/rarer than trend" tables below.
//
// The fit is a least-squares line ln(cov) = m·L + b (a straight line on the log
// axis). To stay numerically stable in the deep tail (where coverage underflows
// to 0 as a float), everything is done in log space: ln(cov) = ln(count) −
// L·ln(size). The trend is clamped at 100% (coverage's ceiling). Deviations are
// ranked by *excess passwords* — |actual count − trend-expected count| — so the
// table reflects fluctuations that matter, not lone deep-tail outliers.
function buildSeries(datasets, cats, labels) {
  const series = [];
  datasets.forEach((d, i) => {
    const sat = satFactor(i);
    for (const cat of cats) {
      const color = withSaturation(cat.color, sat);
      const lnSize = Math.log(cat.size);

      // full-data points in log space (independent of displayed depth), weighted
      // by password count so the fit tracks the populous head of the
      // distribution instead of being dragged around by sparse tail lengths.
      const pts = [];
      for (const { length: L } of d.parsed.lengths) {
        const c = countForCat(d.parsed, L, cat.allowed);
        if (c > 0) pts.push({ x: L, c, lny: Math.log(c) - L * lnSize, w: c });
      }
      const fit = weightedLinFit(pts);

      // what's drawn — restricted to the displayed labels
      const covData = labels.map((L) => coverageAt(d.parsed, L, cat));
      const residuals = [];
      if (fit && pts.length >= 3) {
        const predLnCov = (L) => Math.min(0, fit.m * L + fit.b); // clamp cov ≤ 1
        for (const p of pts) {
          const plc = predLnCov(p.x);
          const expected = Math.exp(plc + p.x * lnSize); // trend-expected count
          if (!Number.isFinite(expected)) continue;
          residuals.push({
            L: p.x,
            count: p.c,
            cov: Math.exp(p.lny),
            pred: Math.exp(plc),
            logres: p.lny - plc,
            excess: Math.abs(p.c - expected),
          });
        }
      }
      series.push({ name: baseName(d.name), corpusIndex: i, cat, color, covData, residuals });
    }
  });
  return series;
}

// Weighted least-squares fit of lny = m·x + b over points {x, lny, w}. Points
// are weighted by password count (w) so lengths carrying most of the corpus
// dominate the fit — an unweighted fit treats a length with 2 passwords the
// same as one with 2 million, which drags the line toward the (usually much
// more numerous) sparse tail and away from the populous head.
function weightedLinFit(points) {
  const n = points.length;
  if (n < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const { x, lny, w } of points) {
    sw += w; swx += w * x; swy += w * lny; swxx += w * x * x; swxy += w * x * lny;
  }
  const denom = sw * swxx - swx * swx;
  if (denom === 0) return null;
  const m = (sw * swxy - swx * swy) / denom;
  const b = (swy - m * swx) / sw;
  return { m, b };
}

// A handful of real passwords at a length can produce an enormous deviation
// ratio purely because the trend-expected count is tiny there (e.g. 2 words
// vs. an expected 0.0004) — that's noise, not a fluctuation worth reporting.
// Rows need at least this many passwords at that length/category to qualify.
const MIN_ROW_COUNT = 25;

// Two tables of the largest deviations of real points from their trend —
// split by direction (more passwords than trend predicted vs. fewer) — each
// ranked by excess passwords, across all plotted series. Computed over the
// full dataset, so it depends only on the selected masks — not the floor /
// displayed depth. Rows backed by too few passwords are dropped so a wild
// ratio from a handful of outliers can't crowd out real fluctuations.
function renderFluctuationTable(box, series, top = 10) {
  const rows = [];
  for (const s of series) {
    for (const r of s.residuals) {
      if (r.count < MIN_ROW_COUNT) continue;
      rows.push({ name: s.name, cat: s.cat.label, color: s.color, ...r });
    }
  }
  const above = rows.filter((r) => r.logres > 0).sort((a, b) => b.excess - a.excess).slice(0, top);
  const below = rows.filter((r) => r.logres < 0).sort((a, b) => b.excess - a.excess).slice(0, top);

  if (!above.length && !below.length) {
    box.innerHTML = series.length
      ? `<div class="sub" style="margin-top:12px">Not enough points per series to fit a trend (need ≥3, ≥${MIN_ROW_COUNT} passwords).</div>`
      : "";
    return;
  }

  const th = (t, extra = "") => `<th style="padding:4px 12px 4px 0;font-weight:500;${extra}">${t}</th>`;
  const td = (t, extra = "") => `<td style="padding:3px 12px 3px 0;${extra}">${t}</td>`;
  const numeric = "text-align:right;font-variant-numeric:tabular-nums";

  function table(title, hint, picked, col) {
    if (!picked.length) return "";
    return `
      <div style="flex:1;min-width:320px">
        <div style="font-weight:500;margin:14px 0 6px">${title} <span class="sub" style="font-weight:400;font-size:11px">${hint}</span></div>
        <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px">
          <thead><tr style="color:var(--text-secondary);text-align:left">
            ${th("Corpus")}${th("Category")}${th("Len", "text-align:right")}
            ${th("Passwords", "text-align:right")}${th("Actual", "text-align:right")}${th("Trend", "text-align:right")}${th("×", "text-align:right")}
          </tr></thead>
          <tbody>
            ${picked.map((r) => `<tr>
              ${td(escapeHtml(r.name))}
              ${td(`<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color};margin-right:5px"></span>${escapeHtml(r.cat)}`)}
              ${td(r.L, numeric)}
              ${td(r.count.toLocaleString(), numeric)}
              ${td(formatFrac(r.cov), numeric)}
              ${td(formatFrac(r.pred), numeric)}
              ${td(`<span style="color:${col}">${Math.exp(Math.abs(r.logres)).toFixed(Math.exp(Math.abs(r.logres)) >= 10 ? 0 : 1)}×</span>`, numeric)}
            </tr>`).join("")}
          </tbody>
        </table></div>
      </div>
    `;
  }

  box.innerHTML = `
    <details style="margin-top:12px">
      <summary style="cursor:pointer;font-weight:500">Trend deviations <span class="sub" style="font-weight:400;font-size:11px">(more/rarer than the exponential fit predicts)</span></summary>
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:6px">
        ${table("▲ More common than trend", `(≥${MIN_ROW_COUNT} passwords, by excess)`, above, "var(--success-text, #2E8B6E)")}
        ${table("▼ Rarer than trend", `(≥${MIN_ROW_COUNT} passwords, by excess)`, below, "var(--danger-text, #C13A5B)")}
      </div>
    </details>
  `;
}

// ── mask analysis ────────────────────────────────────────────────────────
// The category view groups masks by class-combination (e.g. "loweralphanum"),
// which hides structure within a category: ?l?l?l?l?d?d?d?d (letters-then-
// digits) and ?l?d?l?d?l?d?l?d look identical there. This table surfaces the
// actual top masks — from one chosen "master" corpus — whose tokens aren't
// all the same single class, i.e. masks with real internal structure, ranked
// by raw count in that corpus. The other uploaded corpora each get their own
// column so the same masks can be compared side by side (e.g. % of rockyou
// vs. % of hashmob), independent of the category toggles / floor slider above.
function isUniformMask(mask) {
  const toks = tokenizeMask(mask);
  let sig = 0;
  for (const t of toks) sig |= CLASS_BIT[t] || OTHER_BIT;
  return sig !== 0 && (sig & (sig - 1)) === 0; // exactly one bit set (single class, no literal)
}

function maskCategoryLabel(mask) {
  const toks = tokenizeMask(mask);
  let sig = 0;
  for (const t of toks) sig |= CLASS_BIT[t] || OTHER_BIT;
  const hasLiteral = !!(sig & OTHER_BIT);
  const classBits = sig & ~OTHER_BIT;
  const base = classBits ? nameFor(classBits) : "";
  if (hasLiteral) return base ? `${base}+literal` : "literal";
  return base;
}

// Compress a mask into its run-length parts, e.g. "?l?l?l?d?d" -> ["3l", "2d"];
// consecutive literal characters are kept verbatim in quotes, e.g.
// "pass?d?d?d?d" -> ["\"pass\"", "4d"]. Each part is one "token" in the
// pattern-analysis sense below (n = run length, t = character class).
function compressMaskParts(mask) {
  const toks = tokenizeMask(mask);
  const parts = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (CLASS_BIT[t]) {
      let j = i;
      while (j < toks.length && toks[j] === t) j++;
      parts.push(`${j - i}${t[1]}`);
      i = j;
    } else {
      let j = i, lit = "";
      while (j < toks.length && !CLASS_BIT[toks[j]]) { lit += toks[j]; j++; }
      parts.push(`"${lit}"`);
      i = j;
    }
  }
  return parts;
}

function compressMask(mask) {
  return compressMaskParts(mask).join(" ");
}

const MASK_TOP_OPTIONS = [15, 25, 50];

function buildTopNonUniformMasks(dataset, top = 15) {
  const rows = [];
  const total = dataset.parsed.analyzed;
  for (const [mask, count] of dataset.parsed.byMask) {
    if (isUniformMask(mask)) continue;
    rows.push({
      mask,
      count,
      length: tokenizeMask(mask).length,
      share: total ? count / total : 0,
      label: maskCategoryLabel(mask),
    });
  }
  return rows.sort((a, b) => b.count - a.count).slice(0, top);
}

// Column sort comparators; `share` doubles for the "% of master" column since
// that's what's actually displayed as the master's own share.
const MASK_SORT_KEYS = {
  mask: (r) => r.mask,
  length: (r) => r.length,
  category: (r) => r.label,
  count: (r) => r.count,
  share: (r) => r.share,
};

function sortMaskRows(rows, sort) {
  const key = MASK_SORT_KEYS[sort.key] || MASK_SORT_KEYS.count;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = key(a), bv = key(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function renderMaskAnalysis(box, datasets, masterName, onMasterChange, top, onTopChange, sort, onSortChange) {
  if (!datasets.length) { box.innerHTML = ""; return; }
  const master = datasets.find((d) => d.name === masterName) || datasets[0];
  const others = datasets.filter((d) => d !== master);
  const rows = sortMaskRows(buildTopNonUniformMasks(master, top), sort);

  const masterSelect = `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px">
      <span class="sub" style="margin:0">Master corpus</span>
      <select id="mask-master">
        ${datasets.map((d) => `<option value="${escapeHtml(d.name)}" ${d === master ? "selected" : ""}>${escapeHtml(baseName(d.name))}</option>`).join("")}
      </select>
    </label>
  `;
  const topSelect = `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-left:auto">
      <span class="sub" style="margin:0">Show</span>
      <select id="mask-top">
        ${MASK_TOP_OPTIONS.map((n) => `<option value="${n}" ${n === top ? "selected" : ""}>${n}</option>`).join("")}
      </select>
    </label>
  `;
  const header = `
    <div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;flex-wrap:wrap">
      <span style="font-weight:500">Mask analysis</span>
      <span class="sub" style="font-weight:400;font-size:11px">
        top masks in the master corpus that mix character classes (not lost inside a broad category like "loweralphanum")
      </span>
      ${masterSelect}
      ${topSelect}
    </div>
  `;

  if (!rows.length) {
    box.innerHTML = `<div style="margin-top:18px">${header}<div class="sub">No non-uniform masks found in ${escapeHtml(baseName(master.name))}.</div></div>`;
    box.querySelector("#mask-master").addEventListener("change", (e) => onMasterChange(e.target.value));
    box.querySelector("#mask-top").addEventListener("change", (e) => onTopChange(+e.target.value));
    return;
  }

  const td = (t, extra = "") => `<td style="padding:3px 12px 3px 0;${extra}">${t}</td>`;
  const numeric = "text-align:right;font-variant-numeric:tabular-nums";
  const sortableTh = (label, key, extra = "") => {
    const active = sort.key === key;
    const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    return `<th data-sort-key="${key}" style="padding:4px 12px 4px 0;font-weight:500;cursor:pointer;user-select:none;${active ? "color:var(--text-primary)" : ""}${extra}">${label}${arrow}</th>`;
  };

  box.innerHTML = `
    <div style="margin-top:18px">
      ${header}
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          ${sortableTh("Mask", "mask")}${sortableTh("Length", "length", numeric)}${sortableTh("Category", "category")}${sortableTh("Count", "count", numeric)}${sortableTh(`% of ${escapeHtml(baseName(master.name))}`, "share", numeric)}
          ${others.map((d) => `<th style="padding:4px 12px 4px 0;font-weight:500;${numeric}">% of ${escapeHtml(baseName(d.name))}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const otherCells = others.map((d) => {
              const c = d.parsed.byMask.get(r.mask) || 0;
              const share = d.parsed.analyzed ? c / d.parsed.analyzed : 0;
              return td(c ? formatPct1(share) : "—", numeric);
            }).join("");
            return `<tr>
              ${td(`<code title="${escapeHtml(r.mask)}">${escapeHtml(compressMask(r.mask))}</code>`)}
              ${td(r.length, numeric)}
              ${td(escapeHtml(r.label))}
              ${td(r.count.toLocaleString(), numeric)}
              ${td(formatPct1(r.share), numeric)}
              ${otherCells}
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>
  `;
  box.querySelector("#mask-master").addEventListener("change", (e) => onMasterChange(e.target.value));
  box.querySelector("#mask-top").addEventListener("change", (e) => onTopChange(+e.target.value));
  box.querySelectorAll("th[data-sort-key]").forEach((el) => {
    el.addEventListener("click", () => onSortChange(el.dataset.sortKey));
  });
}

// ── pattern analysis (start/end token groupings) ───────────────────────────
// Masks that look distinct as whole strings often share the same structure at
// the edges — "6l4d" and "7l4d" both "end in 4d". Rather than judge which
// groupings are worthwhile, we fix a static lookup of the obvious ones (first
// token, last token, first two, last two, first+last) and let the frequency
// counts speak for themselves. A "token" here is one compressed run (e.g.
// "5l", "2d", or a quoted literal run) from compressMaskParts.
const PATTERN_GROUPINGS = [
  { key: "start1", label: "Starts with", pick: (p) => (p.length >= 1 ? p.slice(0, 1) : null), join: " " },
  { key: "end1", label: "Ends with", pick: (p) => (p.length >= 1 ? p.slice(-1) : null), join: " " },
  { key: "start2", label: "Starts with", pick: (p) => (p.length >= 2 ? p.slice(0, 2) : null), join: " " },
  { key: "end2", label: "Ends with", pick: (p) => (p.length >= 2 ? p.slice(-2) : null), join: " " },
  { key: "startend", label: "Starts/ends with", pick: (p) => (p.length >= 2 ? [p[0], p[p.length - 1]] : null), join: " … " },
];

// Aggregate counts per pattern for one dataset under a grouping. Returns
// { counts: Map(pattern -> count), total } where total is the dataset's
// analyzed count (patterns too short for the grouping are simply excluded).
function buildPatternCounts(dataset, grouping) {
  const counts = new Map();
  for (const [mask, count] of dataset.parsed.byMask) {
    const picked = grouping.pick(compressMaskParts(mask));
    if (!picked) continue;
    const pattern = picked.join(grouping.join);
    counts.set(pattern, (counts.get(pattern) || 0) + count);
  }
  return { counts, total: dataset.parsed.analyzed };
}

function buildTopPatternRows(dataset, grouping, top = 15) {
  const { counts, total } = buildPatternCounts(dataset, grouping);
  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

function renderPatternAnalysis(box, datasets, masterName, onMasterChange, top, onTopChange, groupingKey, onGroupingChange) {
  if (!datasets.length) { box.innerHTML = ""; return; }
  const master = datasets.find((d) => d.name === masterName) || datasets[0];
  const others = datasets.filter((d) => d !== master);
  const grouping = PATTERN_GROUPINGS.find((g) => g.key === groupingKey) || PATTERN_GROUPINGS[0];
  const rows = buildTopPatternRows(master, grouping, top);
  const otherCounts = others.map((d) => buildPatternCounts(d, grouping));

  const groupingSelect = `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px">
      <span class="sub" style="margin:0">Grouping</span>
      <select id="pattern-grouping">
        ${PATTERN_GROUPINGS.map((g) => `<option value="${g.key}" ${g.key === grouping.key ? "selected" : ""}>${escapeHtml(patternGroupingOptionLabel(g))}</option>`).join("")}
      </select>
    </label>
  `;
  const masterSelect = `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px">
      <span class="sub" style="margin:0">Master corpus</span>
      <select id="pattern-master">
        ${datasets.map((d) => `<option value="${escapeHtml(d.name)}" ${d === master ? "selected" : ""}>${escapeHtml(baseName(d.name))}</option>`).join("")}
      </select>
    </label>
  `;
  const topSelect = `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-left:auto">
      <span class="sub" style="margin:0">Show</span>
      <select id="pattern-top">
        ${MASK_TOP_OPTIONS.map((n) => `<option value="${n}" ${n === top ? "selected" : ""}>${n}</option>`).join("")}
      </select>
    </label>
  `;
  const header = `
    <div style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;flex-wrap:wrap">
      <span style="font-weight:500">Pattern analysis</span>
      <span class="sub" style="font-weight:400;font-size:11px">
        how often masks in the master corpus start/end with a given run of characters (e.g. "ends with 4d")
      </span>
      ${groupingSelect}
      ${masterSelect}
      ${topSelect}
    </div>
  `;

  const wireControls = () => {
    box.querySelector("#pattern-grouping").addEventListener("change", (e) => onGroupingChange(e.target.value));
    box.querySelector("#pattern-master").addEventListener("change", (e) => onMasterChange(e.target.value));
    box.querySelector("#pattern-top").addEventListener("change", (e) => onTopChange(+e.target.value));
  };

  if (!rows.length) {
    box.innerHTML = `<div style="margin-top:18px">${header}<div class="sub">No masks in ${escapeHtml(baseName(master.name))} are long enough for this grouping.</div></div>`;
    wireControls();
    return;
  }

  const td = (t, extra = "") => `<td style="padding:3px 12px 3px 0;${extra}">${t}</td>`;
  const numeric = "text-align:right;font-variant-numeric:tabular-nums";

  box.innerHTML = `
    <div style="margin-top:18px">
      ${header}
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">${grouping.label}</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${numeric}">Count</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${numeric}">% of ${escapeHtml(baseName(master.name))}</th>
          ${others.map((d) => `<th style="padding:4px 12px 4px 0;font-weight:500;${numeric}">% of ${escapeHtml(baseName(d.name))}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const otherCells = otherCounts.map(({ counts, total }) => {
              const c = counts.get(r.pattern) || 0;
              const share = total ? c / total : 0;
              return td(c ? formatPct1(share) : "—", numeric);
            }).join("");
            return `<tr>
              ${td(`<code>${escapeHtml(r.pattern)}</code>`)}
              ${td(r.count.toLocaleString(), numeric)}
              ${td(formatPct1(r.share), numeric)}
              ${otherCells}
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>
  `;
  wireControls();
}

function patternGroupingOptionLabel(g) {
  switch (g.key) {
    case "start1": return "First token";
    case "end1": return "Last token";
    case "start2": return "First two tokens";
    case "end2": return "Last two tokens";
    case "startend": return "First + last token";
    default: return g.key;
  }
}

// ── chart ──────────────────────────────────────────────────────────────────
function renderChart(canvas, prev, datasets, labels, floor, series) {
  if (prev) prev.destroy();

  const chartDatasets = [];
  // grouped length bars (one bar per corpus per length). Normalised to % of each
  // corpus's own total so corpora of very different sizes compare fairly; the
  // raw count is kept for the tooltip.
  datasets.forEach((d, i) => {
    const barColor = barColorFor(i);
    const counts = labels.map((L) => (d.parsed.countByLen.get(L) ?? null));
    const analyzed = d.parsed.analyzed;
    chartDatasets.push({
      type: "bar",
      label: `${baseName(d.name)} · share`,
      data: counts.map((c) => (c == null ? null : (c / analyzed) * 100)),
      backgroundColor: hexA(barColor, 0.55),
      borderColor: barColor,
      borderWidth: 1,
      yAxisID: "y",
      order: 10,
      _counts: counts,
    });
  });
  // per series (corpus × selected category): the coverage line.
  for (const s of series) {
    chartDatasets.push({
      type: "line",
      label: `${s.name} · ${s.cat.label}`,
      data: s.covData,
      borderColor: s.color,
      backgroundColor: s.color,
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      borderDash: s.corpusIndex === 0 ? [] : [5, 3],
      spanGaps: false,
      fill: false,
      tension: 0,
      yAxisID: "yCov",
      order: 1,
    });
  }

  return new Chart(canvas, {
    data: { labels: labels.map(String), datasets: chartDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: {
            color: cssVar("--text-secondary"),
            boxWidth: 12,
            font: { size: 11 },
          },
        },
        tooltip: {
          filter: (item) => item.parsed.y != null,
          callbacks: {
            title: (items) => `length ${items[0].label}`,
            label: (ctx) => {
              const ds = ctx.dataset;
              if (ds.yAxisID === "yCov") {
                const v = ctx.parsed.y;
                return `${ds.label}: ${formatFrac(v)}${v > 0 ? ` · ~1 in ${formatN(1 / v)}` : ""}`;
              }
              const c = ds._counts ? ds._counts[ctx.dataIndex] : null;
              return `${ds.label}: ${ctx.parsed.y.toFixed(1)}%${c != null ? ` (${c.toLocaleString()})` : ""}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "password length", color: cssVar("--text-secondary") },
          ticks: { color: cssVar("--text-secondary") },
          grid: { color: cssVar("--surface-3") },
        },
        y: {
          position: "left",
          beginAtZero: true,
          title: { display: true, text: "% of corpus", color: cssVar("--text-secondary") },
          ticks: { color: cssVar("--text-secondary"), callback: (v) => `${v}%` },
          grid: { color: cssVar("--surface-3") },
        },
        yCov: {
          position: "right",
          type: "logarithmic",
          min: floor,
          max: COV_MAX,
          title: { display: true, text: "keyspace coverage", color: cssVar("--text-secondary") },
          ticks: {
            color: cssVar("--text-secondary"),
            maxTicksLimit: 12, // a deep floor spans up to 100 decades — keep labels sparse
            callback: (v) => formatFrac(v),
          },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

// ── view range (floor-driven, across all corpora) ──────────────────────────
// Choose the plotted length range for the current floor. Cut at the larger of:
//   · the histogram baseline — shortest length covering 99.5% of a corpus's
//     passwords (≥16), maxed across corpora, and
//   · the deepest length where any corpus's coverage still clears the floor.
// x labels are the union of lengths present in any corpus, up to the cut.
// Whatever is beyond is reported so truncation is never silent.
function cutFor(p, floor, cats, threshold = 0.995) {
  const lengths = p.lengths;
  const total = p.analyzed;
  const maxLen = lengths[lengths.length - 1].length;
  let cum = 0, base = maxLen;
  for (const l of lengths) {
    cum += l.count;
    if (cum / total >= threshold) { base = l.length; break; }
  }
  base = Math.max(base, Math.min(16, maxLen));
  let cut = base;
  for (const l of lengths) {
    if (l.length <= cut) continue;
    for (const s of cats) {
      const c = coverageAt(p, l.length, s);
      if (c != null && c >= floor) { cut = l.length; break; }
    }
  }
  return cut;
}

function computeView(datasets, floor, cats) {
  let cut = 1, maxLen = 1, total = 0;
  const all = new Set();
  for (const d of datasets) {
    cut = Math.max(cut, cutFor(d.parsed, floor, cats));
    const p = d.parsed;
    maxLen = Math.max(maxLen, p.lengths[p.lengths.length - 1].length);
    for (const l of p.lengths) { all.add(l.length); total += l.count; }
  }
  const labels = [...all].filter((L) => L <= cut).sort((a, b) => a - b);
  let hiddenCount = 0;
  const hidden = new Set();
  for (const d of datasets) {
    for (const l of d.parsed.lengths) {
      if (l.length > cut) { hiddenCount += l.count; hidden.add(l.length); }
    }
  }
  return { labels, cut, maxLen, hiddenBuckets: hidden.size, hiddenCount, total, floor };
}

function capNoteHtml(v) {
  const exp = Math.round(Math.log10(v.floor));
  const lo = v.labels.length ? v.labels[0] : 1;
  let s = ` <span style="color:var(--text-secondary)">Showing lengths ${lo}–${v.cut} down to a 1e${exp} floor.`;
  if (v.hiddenBuckets) {
    s += ` ${v.hiddenBuckets} longer bucket${v.hiddenBuckets === 1 ? "" : "s"} ` +
      `(up to ${v.maxLen}, ${v.hiddenCount.toLocaleString()} passwords · ${pct(v.hiddenCount, v.total)}%) beyond the view.`;
  }
  return s + "</span>";
}

// ── helpers ──────────────────────────────────────────────────────────────────
// Saturation multiplier per corpus index: first full, later ones progressively
// faded so overlapping same-hue coverage lines stay distinguishable (paired
// with a dashed stroke for i > 0 — see renderChart).
function satFactor(i) {
  return Math.pow(0.45, i);
}

// Bar color per corpus index — cycles through BAR_PALETTE's distinct hues
// rather than fading one hue, so 3+ datasets remain easy to tell apart.
function barColorFor(i) {
  return BAR_PALETTE[i % BAR_PALETTE.length];
}

function pct(part, whole) {
  if (!whole) return "0.0";
  return ((part / whole) * 100).toFixed(1);
}

// Mask-analysis table percentages: always one decimal; anything that would
// round to 0.0% is shown as "<0.1%" instead, so a nonzero share never reads
// as absent.
function formatPct1(v) {
  if (v == null) return "—";
  if (!v) return "0.0%";
  const p = v * 100;
  return p < 0.05 ? "<0.1%" : `${p.toFixed(1)}%`;
}

// Coverage fractions span many orders of magnitude. Show human percentages when
// reasonable, else compact scientific notation.
function formatFrac(v) {
  if (v == null) return "—";
  if (!v) return "0";
  if (v >= 0.01) return `${(v * 100).toFixed(1)}%`;
  if (v >= 0.0001) return `${(v * 100).toFixed(3)}%`;
  return v.toExponential(1); // e.g. "2.9e-11"
}

function hexA(hex, alpha) {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `#${m[1]}${a}`;
}

// Reduce a hex colour's HSL saturation by `factor` (0..1), nudging lightness up
// a touch as it fades so faded series read lighter too. Hue is preserved so the
// character-class colour is still recognisable across corpora.
function withSaturation(hex, factor) {
  const { h, s, l } = hexToHsl(hex);
  const nl = Math.min(1, l + (1 - factor) * 0.12);
  return hslToHex(h, Math.max(0, Math.min(1, s * factor)), nl);
}

function hexToHsl(hex) {
  const m = hex.replace("#", "");
  let r = parseInt(m.slice(0, 2), 16) / 255;
  let g = parseInt(m.slice(2, 4), 16) / 255;
  let b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToHex(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function formatN(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function baseName(n) {
  return n.replace(/\.masks$/i, "");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
