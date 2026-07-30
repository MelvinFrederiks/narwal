// Scene — Analysis results.
//
// Upload one or more JSON files, each describing one analysis run, or a JSON
// array of several runs:
//   { "name": "<run label>", "type": "histogram", "values": { "<bucket>": <count>, ... }, "axis": "<optional x-axis label>" }
//   { "name": "<run label>", "type": "bivariate", "values": { "<x bucket>": { "<y bucket>": <count>, ... }, ... }, "axis_x": "...", "axis_y": "..." }
//   [ { "name": "...", "type": "...", "values": {...} }, { "name": "...", ... } ]
//
// "axis" (histogram) / "axis_x" + "axis_y" (bivariate) are optional and only
// affect axis labels (default to "bucket" / "axis_x" / "axis_y"); a
// histogram's vertical axis is always "% of corpus". When a group's runs
// disagree, the first run (in upload order) that set the field wins.
//
// The "type" field selects how "values" is interpreted and rendered — modular
// by design, so new analysis types can be added without touching how existing
// ones work (mirrors the attack.type dispatch in backend/pipeline/attack_sim.py:
// a flat dispatch keyed by the type string, one renderer per type, unknown
// types reported rather than silently dropped).
//
// "histogram" values are bucket -> count pairs. Each histogram has zero to a
// few top-right checkboxes depending on the bucket keys' shape:
//   · all integers -> numeric sort, "Dynamic scaling" (on by default) — folds
//     the lowest/highest buckets (each under 1% of the group's combined
//     total) into a head/tail bucket, so a long thin tail can't stretch the
//     axis into an unreadable smear.
//   · anything else -> plain ASCII alphabetical sort by default, plus
//     whichever of these apply to what's actually in the bucket set:
//       - "Case-insensitive" (only if some letter appears in both cases,
//         e.g. both "a" and "A") — merges each such pair into one lowercase
//         bucket, summing their counts; unpaired letters and non-letter
//         buckets pass through untouched. Off restores plain ASCII order.
//       - "Exclude digits" (only if a single-digit bucket exists) — drops
//         those buckets from the chart and from each run's own total.
//       - "Exclude specials" (only if a usual-special-character bucket
//         exists) — same, for those buckets.
//       - "Exclude other" (only if a bucket exists that's none of the
//         above — stray control/non-ASCII bytes that slip into a corpus and
//         show up as a near-empty, unlabelled-looking bar) — same, for
//         those buckets.
//
// "bivariate" values are x-bucket -> (y-bucket -> count) — a 2D histogram,
// drawn as a colour-coded grid (one cell per x/y combination, shaded by that
// cell's share of its run's total). Each axis is bucketed independently using
// exactly the same rules as a "histogram" axis above (its own int-vs-char
// detection), but the checkboxes above are shared across both axes — one
// "Dynamic scaling"/"Case-insensitive"/"Exclude ..." checkbox acts on
// whichever axis (or both) it actually applies to, so a numeric x-axis can
// fold its edges into a head/tail bucket while a char y-axis gets
// case-insensitive merging from the very same toggles. One grid is drawn per
// run (side by side), all sharing the same bucketing so they line up for
// comparison.
//
// Runs are collated onto one chart if and only if their "name" fields agree
// — e.g. a "length" histogram and a "zxcvbn" histogram never share a chart,
// even though both are type "histogram". Series/panels within a chart are
// labelled by their source filename (extension stripped), not by "name"
// (every run in a group shares the same "name" already, so it can't tell
// series apart). Histogram bars use the same styling (accent colour, axes,
// tooltip shape) as the keyspace viz length histogram. Everything is parsed
// in the browser — files are never uploaded.

import { listServerFiles, serverFilePickerHtml, wireServerFilePicker } from "../util/serverFiles.js";

export const name = "analysis-results";

// Same purple accent used for the keyspace viz length-distribution bars, and
// the same fixed per-run colour sequence used by the score histogram, so a
// run's colour stays stable regardless of load order.
const ACCENT = "#534AB7";
const RUN_COLORS = ["#534AB7", "#185FA5", "#BA7517", "#0F6E56", "#A32D2D"];

// "Dynamic scaling" (on by default, toggleable per chart/axis) folds the
// lowest and highest buckets into one head/tail bucket each, growing inward
// from either edge for as long as the folded buckets combined hold under 1%
// of the group's combined total — so a long thin tail on either end can't
// stretch the axis into an unreadable smear. Same idea, and the same 1%
// share, as the overflow-bucket folding in score_histogram.js, applied to
// both ends instead of just the top.
const HEAD_TAIL_SHARE = 0.01;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── modular type registry ───────────────────────────────────────────────
// Each renderer takes (runs, title, colorByRunId, { controls, onToggle }) —
// `controls` is that group's top-right checkbox states (see controlsByGroup
// in render()) and `onToggle(key, checked)` persists one checkbox's change
// and re-renders; which checkboxes exist and what they do is entirely up to
// the renderer. It returns an HTML string plus a `mount(register)` hook to
// wire up any live chart(s) — `register(chart)` hands the Chart.js instance
// back so it gets torn down on the next refresh (renderers with no Chart.js
// instance, e.g. the bivariate grid, may call register() zero times).
// Add a new entry here (and to TYPE_LABELS) to support a new analysis
// "type" — no other code needs to change.
const TYPE_LABELS = {
  histogram: "Histogram",
  bivariate: "Bivariate",
};

const TYPE_RENDERERS = {
  histogram: renderHistogramType,
  bivariate: renderBivariateType,
};

export async function render(mount) {
  // Histogram bars read better with more room than the shared #view's
  // default 1200px cap (see app.js: `main { max-width: 1200px }`) — widen
  // just this scene; app.js resets it on the next scene change so it can't
  // leak.
  mount.style.maxWidth = "1600px";
  mount.innerHTML = `
    <div class="panel">
      <h2>Analysis results</h2>
      <div class="sub">
        Upload one or more JSON files. Each file holds either one analysis run — <code>{"name": "...", "type":
        "histogram", "values": {"&lt;bucket&gt;": &lt;count&gt;, ...}}</code> — or a JSON array of several runs.
        The <code>type</code> field selects how it's drawn — <code>histogram</code> (1D) and <code>bivariate</code>
        (2D) are supported today, more types can be added later. Runs are collated onto one chart only when their
        <code>name</code> fields agree (a "length" run and a "zxcvbn" run never share a chart); each chart's series
        are normalised to % of that run's own total so runs of different sizes compare fairly, and labelled by
        source filename. Parsed in your browser — nothing is uploaded.
      </div>

      <div id="drop" style="border:1px dashed var(--border-2);border-radius:8px;padding:24px;text-align:center;color:var(--text-secondary);margin-bottom:10px">
        <input type="file" id="resultfile" multiple style="display:none"/>
        <button id="pick" class="primary" style="padding:10px 18px">Upload files</button>
        <div id="drop-hint" style="font-size:11px;color:var(--text-tertiary);margin-top:8px">
          or drop JSON files here · one analysis run per file
        </div>
        <div id="serverPicker"></div>
      </div>
      <div id="filebox" style="margin-bottom:10px"></div>

      <div id="msg"></div>
      <div id="results"></div>
    </div>
  `;

  const fileInput = mount.querySelector("#resultfile");
  const drop = mount.querySelector("#drop");
  const fileBox = mount.querySelector("#filebox");
  const msg = mount.querySelector("#msg");
  const resultsEl = mount.querySelector("#results");

  let runs = [];       // [{ id, fileName, fileLabel, name, type, values, axis, axisX, axisY }]
  let nextRunId = 0;
  let charts = [];      // live Chart.js instances, torn down on every refresh
  // group name -> its chart's top-right checkbox states. Which checkboxes
  // actually show up (and what they do) depends on the group's type and
  // bucket-key shape — see renderHistogramType / renderBivariateType.
  // Missing keys fall back to DEFAULT_CONTROLS below.
  const controlsByGroup = new Map();
  const DEFAULT_CONTROLS = { dynamicScaling: true, caseInsensitive: false, excludeDigits: false, excludeSpecials: false, excludeOther: false };

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
  serverPickerBox.innerHTML = `<div class="sub" style="margin:8px 0 0">indexing…</div>`;
  listServerFiles(".json").then((files) => {
    serverPickerBox.innerHTML = serverFilePickerHtml(files, "analysis");
    wireServerFilePicker(serverPickerBox, files, "analysis", ".json", (file) => handleFiles([file]));
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

      let json;
      try { json = JSON.parse(text); }
      catch { errors.push(`${escapeHtml(p.name)} is not valid JSON`); continue; }

      // A file may hold a single run object or an array of several.
      const items = Array.isArray(json) ? json : [json];
      if (Array.isArray(json) && !json.length) {
        errors.push(`${escapeHtml(p.name)}: empty array`);
        continue;
      }
      const fileLabel = baseFileName(p.name);
      items.forEach((item, i) => {
        const errLabel = Array.isArray(json) ? `${escapeHtml(p.name)}[${i}]` : escapeHtml(p.name);
        const problem = validateRun(item);
        if (problem) { errors.push(`${errLabel}: ${escapeHtml(problem)}`); return; }
        runs.push({
          id: nextRunId++,
          fileName: p.name,
          fileLabel,
          name: item.name,
          type: item.type,
          values: item.values,
          axis: typeof item.axis === "string" && item.axis.trim() ? item.axis : null,
          axisX: typeof item.axis_x === "string" && item.axis_x.trim() ? item.axis_x : null,
          axisY: typeof item.axis_y === "string" && item.axis_y.trim() ? item.axis_y : null,
        });
      });
    }
    if (errors.length) showError(errors.join("<br>"));
    else { msg.className = ""; msg.innerHTML = ""; }

    refresh();
  }

  function removeRun(id) {
    runs = runs.filter((r) => r.id !== id);
    refresh();
  }

  function renderRunChips() {
    if (!runs.length) { fileBox.innerHTML = ""; return; }
    fileBox.innerHTML = runs.map((r, i) => `
      <span data-id="${r.id}" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border-2);border-radius:14px;font-size:12px;margin:0 6px 6px 0">
        <span style="width:10px;height:10px;border-radius:50%;background:${RUN_COLORS[i % RUN_COLORS.length]};display:inline-block"></span>
        ${escapeHtml(r.fileLabel)} <span class="sub" style="margin:0">(${escapeHtml(r.name)} · ${escapeHtml(r.type)})</span>
        <button title="remove" style="border:0;background:none;cursor:pointer;color:var(--text-secondary);padding:0 2px;font-size:14px;line-height:1">×</button>
      </span>`).join("");
    fileBox.querySelectorAll("[data-id]").forEach((chip) => {
      chip.querySelector("button").addEventListener("click", () => removeRun(Number(chip.dataset.id)));
    });
  }

  function refresh() {
    renderRunChips();
    for (const c of charts) c.destroy();
    charts = [];

    if (!runs.length) { resultsEl.innerHTML = ""; return; }

    // Collate runs into one chart iff their "name" fields agree — a
    // "length" histogram and a "zxcvbn" histogram never share a chart, even
    // though both are type "histogram". Colour every run by its position
    // across the whole upload set (not per-group) so a run's colour stays
    // stable when other groups are added/removed.
    const colorByRunId = new Map(runs.map((r, i) => [r.id, RUN_COLORS[i % RUN_COLORS.length]]));
    const groups = new Map(); // name -> runs[]
    for (const r of runs) {
      if (!groups.has(r.name)) groups.set(r.name, []);
      groups.get(r.name).push(r);
    }

    const sections = [];
    const pendingMounts = [];
    for (const [groupName, nameRuns] of groups) {
      const types = [...new Set(nameRuns.map((r) => r.type))];
      if (types.length > 1) {
        sections.push(`
          <div class="card danger" style="margin-top:14px">
            Analysis <strong>${escapeHtml(groupName)}</strong> has mismatched types across files
            (${types.map(escapeHtml).join(", ")}) — skipped
            (${nameRuns.map((r) => escapeHtml(r.fileLabel)).join(", ")}). Every run sharing a "name" must share
            the same "type".
          </div>`);
        continue;
      }
      const type = types[0];
      const renderer = TYPE_RENDERERS[type];
      const typeLabel = TYPE_LABELS[type] || type;
      if (!renderer) {
        sections.push(`
          <div class="card warning" style="margin-top:14px">
            Analysis <strong>${escapeHtml(groupName)}</strong>'s type <strong>${escapeHtml(type)}</strong>
            isn't supported yet — skipped (${nameRuns.map((r) => escapeHtml(r.fileLabel)).join(", ")}). Add a
            renderer to <code>web/scenes/analysis_results.js</code>'s <code>TYPE_RENDERERS</code> to support it.
          </div>`);
        continue;
      }
      const title = `${groupName} · ${typeLabel}`;
      const controls = { ...DEFAULT_CONTROLS, ...controlsByGroup.get(groupName) };
      const built = renderer(nameRuns, title, colorByRunId, {
        controls,
        onToggle: (key, checked) => {
          controlsByGroup.set(groupName, { ...controls, [key]: checked });
          refresh();
        },
      });
      sections.push(built.html);
      if (built.mount) pendingMounts.push(built.mount);
    }
    // Attach markup first — mount() hooks query the DOM by id, so they can
    // only run once resultsEl's real children exist.
    resultsEl.innerHTML = sections.join("");
    for (const mountFn of pendingMounts) mountFn((chart) => charts.push(chart));
  }

  function showError(html) {
    msg.className = "card danger";
    msg.style.marginTop = "10px";
    msg.innerHTML = html;
  }
}

function validateRun(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "expected a JSON object";
  if (typeof json.name !== "string" || !json.name.trim()) return 'missing or invalid "name"';
  if (typeof json.type !== "string" || !json.type.trim()) return 'missing or invalid "type"';
  if (!json.values || typeof json.values !== "object" || Array.isArray(json.values)) {
    return 'missing or invalid "values"';
  }
  return null;
}

// ── shared bucket classification + axis planning ────────────────────────
const isSingleLetter = (b) => /^[A-Za-z]$/.test(b);
const oppositeCase = (b) => (b === b.toLowerCase() ? b.toUpperCase() : b.toLowerCase());
const isDigitBucket = (b) => /^[0-9]$/.test(b);
// The usual ASCII punctuation/symbol characters — printable, non-alphanumeric,
// non-whitespace. Deliberately an explicit set rather than "not alphanumeric",
// which would also sweep in whitespace, control characters, and non-ASCII
// glyphs.
const isSpecialBucket = (b) => /^[!-\/:-@[-`{-~]$/.test(b);
// Anything left over — not a letter, digit, or usual special character.
// Occasional stray bytes (control characters, non-ASCII glyphs) can slip
// into a corpus and show up as a near-empty bar with no readable label.
const isOtherBucket = (b) => !isSingleLetter(b) && !isDigitBucket(b) && !isSpecialBucket(b);

// Decides how one axis' raw bucket keys should be grouped/ordered/displayed,
// and which checkboxes should control that — shared by the 1D histogram
// (one axis) and the 2D bivariate grid (called once per axis). `keyTotals`
// is a Map of raw bucket key -> combined count across the whole group,
// used only by the int-mode dynamic-scaling fold decision. `keySuffix` (""
// for a 1D histogram, "X"/"Y" for a bivariate axis) disambiguates each
// checkbox's persisted control key.
function planAxisBuckets(rawKeys, keyTotals, axisCtrl, keySuffix) {
  const allInts = rawKeys.every((b) => Number.isInteger(Number(b)) && b.trim() !== "");
  let displayBuckets, note, controlDefs, workingBuckets;

  if (allInts) {
    const buckets = rawKeys.slice().sort((a, b) => Number(a) - Number(b));
    workingBuckets = buckets;

    const combined = buckets.map((b) => keyTotals.get(b) || 0);
    const total = combined.reduce((a, b) => a + b, 0);
    let headFold = 0, tailFold = 0;
    if (axisCtrl.dynamicScaling) {
      headFold = computeEdgeFoldCount(combined, total);
      tailFold = computeEdgeFoldCount(combined.slice(headFold).reverse(), total);
    }

    displayBuckets = [];
    if (headFold > 0) displayBuckets.push({ label: `head (≤${buckets[headFold - 1]})`, keys: buckets.slice(0, headFold) });
    for (let i = headFold; i < buckets.length - tailFold; i++) displayBuckets.push({ label: String(buckets[i]), keys: [buckets[i]] });
    if (tailFold > 0) displayBuckets.push({ label: `tail (≥${buckets[buckets.length - tailFold]})`, keys: buckets.slice(buckets.length - tailFold) });

    const foldParts = [];
    if (headFold > 0) foldParts.push(`lowest ${headFold} bucket${headFold === 1 ? "" : "s"}`);
    if (tailFold > 0) foldParts.push(`highest ${tailFold} bucket${tailFold === 1 ? "" : "s"}`);
    note = foldParts.length
      ? `Dynamic scaling folded the ${foldParts.join(" and the ")} — each under ${HEAD_TAIL_SHARE * 100}% of the combined total — into a head/tail bucket.`
      : null;
    controlDefs = [{
      key: `dynamicScaling${keySuffix}`,
      label: "Dynamic scaling",
      checked: axisCtrl.dynamicScaling,
      title: `Fold the lowest and highest buckets — each holding under ${HEAD_TAIL_SHARE * 100}% of the combined total — into one head/tail bucket, so a long thin tail can't stretch the axis into an unreadable smear.`,
    }];
  } else {
    const hasCasePair = rawKeys.some((b) => isSingleLetter(b) && rawKeys.includes(oppositeCase(b)));
    const hasDigits = rawKeys.some(isDigitBucket);
    const hasSpecials = rawKeys.some(isSpecialBucket);
    const hasOther = rawKeys.some(isOtherBucket);
    const caseInsensitive = hasCasePair && axisCtrl.caseInsensitive;
    const excludeDigits = hasDigits && axisCtrl.excludeDigits;
    const excludeSpecials = hasSpecials && axisCtrl.excludeSpecials;
    const excludeOther = hasOther && axisCtrl.excludeOther;

    const buckets = rawKeys.filter((b) =>
      !(excludeDigits && isDigitBucket(b)) &&
      !(excludeSpecials && isSpecialBucket(b)) &&
      !(excludeOther && isOtherBucket(b))
    );
    workingBuckets = buckets;

    if (caseInsensitive) {
      // Group a letter's two cases together so pairs stay adjacent while
      // merging. `consumed` skips the second half of a pair once merged.
      buckets.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : 1));
      const consumed = new Set();
      displayBuckets = [];
      for (const b of buckets) {
        if (consumed.has(b)) continue;
        const other = isSingleLetter(b) ? oppositeCase(b) : null;
        if (other && buckets.includes(other)) {
          consumed.add(b);
          consumed.add(other);
          displayBuckets.push({ label: b.toLowerCase(), keys: [b, other] });
        } else {
          consumed.add(b);
          displayBuckets.push({ label: b, keys: [b] });
        }
      }
    } else {
      // Case-insensitive off (or unavailable) — plain ASCII order.
      buckets.sort();
      displayBuckets = buckets.map((b) => ({ label: b, keys: [b] }));
    }

    const mergedCount = displayBuckets.filter((db) => db.keys.length > 1).length;
    const noteParts = [];
    if (mergedCount > 0) noteParts.push(`combined ${mergedCount} upper/lower-case bucket pair${mergedCount === 1 ? "" : "s"} (e.g. "A" + "a") into one lowercase bucket each`);
    if (excludeDigits) noteParts.push("excluded digit buckets");
    if (excludeSpecials) noteParts.push("excluded special-character buckets");
    if (excludeOther) noteParts.push("excluded other/unusual-character buckets");
    note = noteParts.length ? `This chart ${noteParts.join("; ")}.` : null;

    controlDefs = [];
    if (hasCasePair) {
      controlDefs.push({
        key: `caseInsensitive${keySuffix}`,
        label: "Case-insensitive",
        checked: axisCtrl.caseInsensitive,
        title: `Combine each letter's upper- and lower-case buckets (e.g. "A" + "a") into one lowercase bucket, summing their counts. Off restores plain ASCII order.`,
      });
    }
    if (hasDigits) {
      controlDefs.push({
        key: `excludeDigits${keySuffix}`,
        label: "Exclude digits",
        checked: axisCtrl.excludeDigits,
        title: `Hide single-digit buckets (0-9) from the chart and from each run's own total.`,
      });
    }
    if (hasSpecials) {
      controlDefs.push({
        key: `excludeSpecials${keySuffix}`,
        label: "Exclude specials",
        checked: axisCtrl.excludeSpecials,
        title: `Hide the usual special-character buckets (e.g. ! @ # $ %) from the chart and from each run's own total.`,
      });
    }
    if (hasOther) {
      controlDefs.push({
        key: `excludeOther${keySuffix}`,
        label: "Exclude other",
        checked: axisCtrl.excludeOther,
        title: `Hide buckets that aren't a letter, digit, or usual special character from the chart and from each run's own total — catches stray characters that would otherwise show up as a near-empty, unlabelled-looking bar.`,
      });
    }
  }

  return { displayBuckets, note, controlDefs, workingBuckets, allInts };
}

// ── histogram renderer ──────────────────────────────────────────────────
// values: { "<bucket>": <count>, ... }. `nameRuns` all share the same "name"
// (the collation key — see refresh()), so chart series are labelled by
// source filename instead, which is what actually distinguishes them.
function renderHistogramType(nameRuns, title, colorByRunId, { controls, onToggle }) {
  const allBucketSet = new Set();
  for (const r of nameRuns) for (const k of Object.keys(r.values)) allBucketSet.add(k);
  const rawBuckets = [...allBucketSet];
  const axisLabel = nameRuns.find((r) => r.axis)?.axis || "bucket";

  // Combined (across every run in the group) count per bucket — only used
  // by planAxisBuckets' int-mode dynamic-scaling fold decision, same as
  // score_histogram's multi-file overflow cutoff.
  const keyTotals = new Map(rawBuckets.map((b) => [b, nameRuns.reduce((sum, r) => sum + (Number(r.values[b]) || 0), 0)]));

  const { displayBuckets, note, controlDefs, workingBuckets } = planAxisBuckets(rawBuckets, keyTotals, controls, "");

  const id = `hist-${Math.random().toString(36).slice(2, 9)}`;
  const controlsHtml = controlDefs.map((def) => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer" title="${escapeHtml(def.title)}">
      <input type="checkbox" data-ctrl-key="${escapeHtml(def.key)}" ${def.checked ? "checked" : ""}/>
      ${escapeHtml(def.label)}
    </label>`).join("");
  const noteHtml = note ? `<div class="sub" style="margin-top:6px">${escapeHtml(note)}</div>` : "";

  const html = `
    <div class="card" style="margin-top:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <strong>${escapeHtml(title)}</strong>
          <span class="sub" style="margin:0">${nameRuns.length} run${nameRuns.length === 1 ? "" : "s"}</span>
        </div>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap" id="${id}-controls">
          ${controlsHtml}
        </div>
      </div>
      <div class="chart-wrap" style="height:360px">
        <canvas id="${id}"></canvas>
      </div>
      ${noteHtml}
    </div>`;

  return {
    html,
    mount(register) {
      wireControls(id, onToggle);

      const canvas = document.getElementById(id);
      if (!canvas) return;
      const datasets = nameRuns.map((r) => {
        const color = colorByRunId.get(r.id) || ACCENT;
        const runTotal = workingBuckets.reduce((sum, b) => sum + (Number(r.values[b]) || 0), 0);
        const counts = displayBuckets.map((db) => db.keys.reduce((sum, k) => sum + (Number(r.values[k]) || 0), 0));
        return {
          label: r.fileLabel,
          data: counts.map((c) => (runTotal ? (c / runTotal) * 100 : 0)),
          backgroundColor: hexA(color, 0.55),
          borderColor: color,
          borderWidth: 1,
          _counts: counts,
        };
      });

      const chart = new Chart(canvas, {
        type: "bar",
        data: { labels: displayBuckets.map((db) => db.label), datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: datasets.length > 1,
              labels: { color: cssVar("--text-secondary") },
            },
            tooltip: {
              callbacks: {
                title: (items) => `bucket ${items[0].label}`,
                label: (ctx) => {
                  const count = ctx.dataset._counts?.[ctx.dataIndex] ?? 0;
                  return `${ctx.dataset.label}: ${round1(ctx.parsed.y)}% of run (${count.toLocaleString()})`;
                },
              },
            },
          },
          scales: {
            x: {
              title: { display: true, text: axisLabel, color: cssVar("--text-secondary") },
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
      register(chart);
    },
  };
}

// ── bivariate (2D histogram) renderer ───────────────────────────────────
// values: { "<x bucket>": { "<y bucket>": <count>, ... }, ... }. Each axis is
// planned independently with planAxisBuckets, exactly like a histogram axis,
// but the two axes share one set of controls — a single "Dynamic scaling" /
// "Case-insensitive" / "Exclude ..." checkbox acts on whichever axis (or
// axes) it actually applies to, rather than doubling up into separate x and
// y checkboxes. One coloured grid is drawn per run (all sharing the same
// bucketing), shaded by that cell's share of the run's own total (over the
// working — i.e. post-exclusion — buckets).
function renderBivariateType(nameRuns, title, colorByRunId, { controls, onToggle }) {
  const rawXSet = new Set(), rawYSet = new Set();
  for (const r of nameRuns) {
    for (const xk of Object.keys(r.values)) {
      rawXSet.add(xk);
      const inner = r.values[xk];
      if (inner && typeof inner === "object") for (const yk of Object.keys(inner)) rawYSet.add(yk);
    }
  }
  const rawXBuckets = [...rawXSet];
  const rawYBuckets = [...rawYSet];
  const axisLabelX = nameRuns.find((r) => r.axisX)?.axisX || "axis_x";
  const axisLabelY = nameRuns.find((r) => r.axisY)?.axisY || "axis_y";

  const cellValue = (r, xk, yk) => {
    const inner = r.values[xk];
    return inner ? Number(inner[yk]) || 0 : 0;
  };

  const xTotals = new Map(rawXBuckets.map((xk) => [
    xk, nameRuns.reduce((sum, r) => sum + rawYBuckets.reduce((s, yk) => s + cellValue(r, xk, yk), 0), 0),
  ]));
  const yTotals = new Map(rawYBuckets.map((yk) => [
    yk, nameRuns.reduce((sum, r) => sum + rawXBuckets.reduce((s, xk) => s + cellValue(r, xk, yk), 0), 0),
  ]));

  // Both axes read the same controls object and the same (unsuffixed)
  // control keys — so toggling e.g. "Case-insensitive" affects whichever
  // axis (or both) actually has a case pair, instead of each axis getting
  // its own separate checkbox.
  const xPlan = planAxisBuckets(rawXBuckets, xTotals, controls, "");
  const yPlan = planAxisBuckets(rawYBuckets, yTotals, controls, "");

  // Dedup by key: a control (e.g. "Dynamic scaling") only needs one
  // checkbox even when both axes independently qualify for it.
  const controlDefsByKey = new Map();
  for (const def of [...xPlan.controlDefs, ...yPlan.controlDefs]) {
    if (!controlDefsByKey.has(def.key)) controlDefsByKey.set(def.key, def);
  }
  const controlDefs = [...controlDefsByKey.values()];
  const note = [xPlan.note, yPlan.note].filter(Boolean).join(" ") || null;

  const id = `biv-${Math.random().toString(36).slice(2, 9)}`;
  const controlsHtml = controlDefs.map((def) => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer" title="${escapeHtml(def.title)}">
      <input type="checkbox" data-ctrl-key="${escapeHtml(def.key)}" ${def.checked ? "checked" : ""}/>
      ${escapeHtml(def.label)}
    </label>`).join("");
  const noteHtml = note ? `<div class="sub" style="margin-top:6px">${escapeHtml(note)}</div>` : "";

  const panels = nameRuns.map((r) => {
    const color = colorByRunId.get(r.id) || ACCENT;
    const runTotal = xPlan.workingBuckets.reduce((sum, xk) =>
      sum + yPlan.workingBuckets.reduce((s, yk) => s + cellValue(r, xk, yk), 0), 0);
    const grid = xPlan.displayBuckets.map((xdb) =>
      yPlan.displayBuckets.map((ydb) => {
        let v = 0;
        for (const xk of xdb.keys) for (const yk of ydb.keys) v += cellValue(r, xk, yk);
        return v;
      })
    );
    return {
      run: r,
      color,
      grid,
      svg: buildHeatmapSvg(
        xPlan.displayBuckets.map((db) => db.label),
        yPlan.displayBuckets.map((db) => db.label),
        grid, runTotal, color, axisLabelX, axisLabelY
      ),
    };
  });

  // One grid per card, stacked vertically — never more than one bivariate
  // grid sharing a box, even when several runs share this group's "name"
  // and bucketing. The controls/note sit above the stack once, since
  // they're shared across every run in the group.
  const html = `
    <div style="margin-top:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <strong>${escapeHtml(title)}</strong>
          <span class="sub" style="margin:0">${nameRuns.length} run${nameRuns.length === 1 ? "" : "s"}</span>
        </div>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap" id="${id}-controls">
          ${controlsHtml}
        </div>
      </div>
      ${panels.map((p) => `
        <div class="card" style="margin-bottom:14px;overflow-x:auto">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px">
            <span style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block"></span>
            <strong>${escapeHtml(p.run.fileLabel)}</strong>
          </div>
          ${p.svg}
        </div>`).join("")}
      <div class="sub" style="margin-top:-8px;margin-bottom:6px">
        Cell shade = that cell's share of the run's own total, on a logarithmic scale (see the legend under each
        grid) so a handful of dominant cells can't wash out everything else to near-white.
      </div>
      ${noteHtml}
    </div>`;

  return {
    html,
    mount() {
      wireControls(id, onToggle);
    },
  };
}

// Wires every checkbox in a chart's controls box to `onToggle(key, checked)`
// — shared by both renderers so the wiring logic lives in one place.
function wireControls(chartId, onToggle) {
  const controlsBox = document.getElementById(`${chartId}-controls`);
  if (!controlsBox) return;
  controlsBox.querySelectorAll("input[data-ctrl-key]").forEach((cb) => {
    cb.addEventListener("change", (e) => onToggle(cb.dataset.ctrlKey, e.target.checked));
  });
}

// Renders an x-by-y grid of coloured cells plus axis titles and a colour
// legend, as a single inline SVG string — same hand-drawn-grid approach as
// the per-position heatmap.js scene (no Chart.js heatmap plugin is loaded).
// Cells are shaded on a log scale (see logIntensity) rather than linearly,
// so a handful of dominant cells can't wash the rest out to near-white.
function buildHeatmapSvg(xLabels, yLabels, grid, runTotal, color, axisLabelX, axisLabelY) {
  const cellW = 22, cellH = 22; // square cells, ~1/3 smaller than the original 34x24
  const titleTop = 14, tickTop = 40, topPad = titleTop + tickTop;
  const titleLeft = 14, tickLeft = 40, leftPad = titleLeft + tickLeft;
  const rightPad = 8, bottomPad = 6;
  const legendGap = 12, legendBarH = 10, legendLabelH = 14;
  const legendH = legendGap + legendBarH + legendLabelH;

  const gridW = cellW * xLabels.length;
  const gridH = cellH * yLabels.length;
  const W = leftPad + gridW + rightPad;
  const H = topPad + gridH + legendH + bottomPad;
  // Recomputed from `grid` on every call — `grid` already reflects the
  // current checkbox configuration (dynamic scaling folds, exclusions,
  // case-insensitive merges), so the colour scale and legend rescale to
  // whatever's actually on screen instead of clinging to a stale max from
  // before the last toggle.
  const maxV = Math.max(0, ...grid.flat());

  const parts = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="bivariate heatmap" xmlns="http://www.w3.org/2000/svg">`];

  parts.push(`<text x="${leftPad + gridW / 2}" y="12" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-secondary)">${escapeHtml(axisLabelX)}</text>`);
  parts.push(`<text x="12" y="${topPad + gridH / 2}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-secondary)" transform="rotate(-90 12 ${topPad + gridH / 2})">${escapeHtml(axisLabelY)}</text>`);

  for (let xi = 0; xi < xLabels.length; xi++) {
    const x = leftPad + xi * cellW + cellW / 2;
    parts.push(`<text x="${x}" y="${topPad - 6}" text-anchor="start" font-size="10" fill="var(--text-secondary)" transform="rotate(-45 ${x} ${topPad - 6})">${escapeHtml(xLabels[xi])}</text>`);
  }
  for (let yi = 0; yi < yLabels.length; yi++) {
    const y = topPad + yi * cellH + cellH / 2;
    parts.push(`<text x="${leftPad - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--text-secondary)">${escapeHtml(yLabels[yi])}</text>`);
  }
  for (let xi = 0; xi < xLabels.length; xi++) {
    for (let yi = 0; yi < yLabels.length; yi++) {
      const v = grid[xi][yi];
      const t = logIntensity(v, maxV);
      const pct = runTotal ? (v / runTotal) * 100 : 0;
      const x = leftPad + xi * cellW;
      const y = topPad + yi * cellH;
      parts.push(`<rect x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${mixWithWhite(color, t)}" stroke="var(--surface)" stroke-width="0.5"><title>${escapeHtml(xLabels[xi])} × ${escapeHtml(yLabels[yi])}: ${round1(pct)}% (${v.toLocaleString()})</title></rect>`);
    }
  }

  // Legend: a smooth gradient bar (log-scaled, matching the cells above) with
  // percentage ticks at t = 0/0.25/0.5/0.75/1, so the shading can be read
  // back as an actual % range rather than just "darker = more".
  const legendY = topPad + gridH + legendGap;
  const legendW = Math.max(cellW * 2, Math.min(220, gridW));
  const segs = 24;
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs;
    const segX = (i / segs) * legendW;
    parts.push(`<rect x="${segX}" y="${legendY}" width="${legendW / segs + 0.5}" height="${legendBarH}" fill="${mixWithWhite(color, t)}"/>`);
  }
  parts.push(`<rect x="0" y="${legendY}" width="${legendW}" height="${legendBarH}" fill="none" stroke="var(--border-2)" stroke-width="0.5"/>`);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const v = t === 0 ? 0 : Math.expm1(t * Math.log1p(maxV));
    const pct = runTotal ? (v / runTotal) * 100 : 0;
    const x = t * legendW;
    const anchor = t === 0 ? "start" : t === 1 ? "end" : "middle";
    const label = formatSigFigPercent(pct);
    parts.push(`<text x="${x}" y="${legendY + legendBarH + 11}" text-anchor="${anchor}" font-size="9" fill="var(--text-secondary)">${label}%</text>`);
  }

  parts.push("</svg>");
  return parts.join("");
}

// Logarithmic colour intensity for a cell: 0 at v=0, 1 at v=maxV, but
// compressed so mid-sized nonzero counts still land well above "barely
// tinted" — unlike a plain v/maxV ratio, which a handful of dominant cells
// can drag every other nonzero cell down toward.
function logIntensity(v, maxV) {
  if (v <= 0 || maxV <= 0) return 0;
  return Math.log1p(v) / Math.log1p(maxV);
}

// Blends `hex` toward white by (1 - t) — t=0 is white, t=1 is the full
// colour — used to shade heatmap cells by intensity while keeping each run's
// panel tinted by its own assigned colour.
function mixWithWhite(hex, t) {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const mix = (c) => Math.round(255 + (parseInt(c, 16) - 255) * t);
  return `rgb(${mix(m[1])},${mix(m[2])},${mix(m[3])})`;
}

// Grows a fold from the start of `countsFromEdge` (already ordered from the
// edge inward) for as long as the running total stays strictly under
// HEAD_TAIL_SHARE of `total`. Returns how many leading entries to fold — 0
// if there's nothing worth folding (fewer than two buckets, or even the
// single edge-most bucket alone already meets/exceeds the threshold, in
// which case folding it alone would just rename it without changing what's
// shown).
function computeEdgeFoldCount(countsFromEdge, total) {
  if (!total || countsFromEdge.length < 2) return 0;
  let cumulative = 0;
  let foldCount = 0;
  for (let i = 0; i < countsFromEdge.length; i++) {
    const tentative = cumulative + countsFromEdge[i];
    if (tentative / total >= HEAD_TAIL_SHARE) break;
    cumulative = tentative;
    foldCount = i + 1;
  }
  return foldCount >= 2 ? foldCount : 0;
}

// ── helpers ──────────────────────────────────────────────────────────────
// "rockyou.json" -> "rockyou" — used to label chart series by source file.
function baseFileName(fileName) {
  return fileName.replace(/\.[^./]+$/, "");
}

function round1(x) { return Math.round(x * 10) / 10; }

// 1 decimal place down to 1%, then just enough decimals to show a single
// significant digit below that — plain round1() would otherwise round tiny
// legend-tick percentages (e.g. from the low end of a log scale) down to a
// misleading "0.00".
function formatSigFigPercent(pct) {
  if (!(pct > 0)) return "0";
  if (pct >= 1) return String(round1(pct));
  return pct.toPrecision(1);
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
