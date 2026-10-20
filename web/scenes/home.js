// Scene — Home.
//
// Landing page: a quick census of the server-side wordlist library (see
// backend/routes/wordlists.py) broken down by extension, plus flavour text
// pointing at what the other scenes are for. Purely informational — no
// uploads, no charts, nothing parsed here.

import { listServerFiles, listRuleFiles } from "../util/serverFiles.js";

export const name = "home";

const TRACKED_EXTS = [
  { ext: ".dict", label: "Dictionaries", hint: "plain wordlists — one candidate password per line" },
  { ext: ".rule", label: "Rule files", hint: "Rule files - one rule per line" },
  { ext: ".masks", label: "Mask files", hint: "PACK statsgen output — mask,count per line" },
  { ext: ".json", label: "Analysis runs", hint: "histogram/bivariate results for Analysis results" },
];

const SCENES = [
  {
    id: "keyspace",
    label: "Mask file analysis",
    text: "Upload PACK statsgen .masks files to see password-length distributions and per-character-class " +
      "keyspace coverage — how much of the possible \"?l?l?l?l?l?l\"-shaped space a corpus actually spans, " +
      "plus tables of the most over/under-represented masks and start/end patterns.",
  },
  {
    id: "analysis-results",
    label: "Analysis results",
    text: "Upload JSON analysis runs (histogram or bivariate) and get them rendered as bar charts or " +
      "colour-coded grids, normalised to % of each run's own total so differently-sized corpora compare " +
      "fairly. Any number of runs that share a name are collated onto one chart.",
  },
  {
    id: "overlap",
    label: "Overlap",
    text: "Load two or more wordlists/mask files side by side and see how much they overlap — a Venn-style " +
      "diagram plus a table of the most common shared entries, useful for judging how redundant one corpus " +
      "is against another before merging or deduping them.",
  },
  {
    id: "mergeability",
    label: "Mergeability",
    text: "Craft an attack and see how well it performs against a wordlist of your choice. Find " +
      "redundancies and optimizations. Queue up analyses and come back later when they are done."
  },
  {
    id: "ordering",
    label: "Attack order",
    text: "Already know which attacks you want to run? This works out the sequence that recovers " +
      "passwords soonest. Every permutation is scored exhaustively, off one hashcat run per attack — " +
      "the total haul and total runtime are the same whichever order you pick, but how early you " +
      "get there is not.",
  },
];

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / 1024 ** i;
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Narwal</h2>
      <div class="sub">
        A browser-side password corpus visualizer. Files are parsed entirely in your browser and never
        uploaded — the backend only serves static assets and an optional read-only library of files already
        sitting on the server, browsable below.
      </div>
      <div id="stats" class="grid-3"></div>
    </div>

    <div class="panel">
      <h2>Scenes</h2>
      <div class="sub">What each tab is for.</div>
      <div class="card-list">
        ${SCENES.map((s) => `
          <div class="card">
            <div style="font-weight:500;margin-bottom:4px">
              <a href="#${s.id}" style="color:var(--info-text);text-decoration:none">${escapeHtml(s.label)} →</a>
            </div>
            <div class="sub" style="margin:0">${escapeHtml(s.text)}</div>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  const statsBox = mount.querySelector("#stats");
  statsBox.innerHTML = TRACKED_EXTS.map(
    (t) => `<div class="card"><div class="sub" style="margin:0">${escapeHtml(t.label)}</div><div class="loading">loading…</div></div>`
  ).join("");

  const results = await Promise.all(TRACKED_EXTS.map((t) => {
      if (t.ext == ".rule") {
        return listRuleFiles(t.ext)
      } else {
        return listServerFiles(t.ext)
      }
    }));


  if (results.every((files) => !files.length)) {
    // Could mean either "not configured" or "configured but empty" — either
    // way there's nothing to break down by extension, so say so once instead
    // of three empty-looking cards.
    statsBox.innerHTML = `
      <div class="card" style="grid-column:1/-1">
        <div class="sub" style="margin:0">
          No server-side wordlist library is configured (or it's empty). Set <code>NARWAL_WORDLISTS_DIR</code>
          in <code>.env</code> to enable the "pick from server library" dropdowns and this breakdown.
        </div>
      </div>
    `;
    return;
  }

  statsBox.innerHTML = TRACKED_EXTS.map((t, i) => {
    const files = results[i];
    const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    return `
      <div class="card">
        <div class="sub" style="margin:0">${escapeHtml(t.label)}</div>
        <div style="font-size:24px;font-weight:500;margin:2px 0">${files.length}</div>
        <div class="sub" style="margin:0">${formatBytes(totalBytes)} · <code>${escapeHtml(t.ext)}</code></div>
        <div class="sub" style="margin:6px 0 0;font-size:11px">${escapeHtml(t.hint)}</div>
      </div>
    `;
  }).join("");
}
