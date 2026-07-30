// Scene — Overlap.
//
// Load two files and compare what they cover. Each file is either a wordlist
// (one password per line) or a PACK statsgen `.masks` file (`mask,count` per
// line); the kind is detected from the content, not the extension.
//
// The comparison domain follows the pair, because the useful question differs:
//   · wordlist × wordlist — compare the passwords themselves. "Do these lists
//     contain the same entries?" Comparing their mask shapes instead would be
//     close to meaningless, since almost any two wordlists share the common
//     shapes regardless of whether they share a single password.
//   · masks × masks       — compare the masks themselves.
//   · wordlist × mask file — the only common ground is mask space, so the
//     wordlist is reduced to the masks its passwords occupy. Flagged in the UI
//     so the weaker reading is never mistaken for the strong one.
//
// Mask-domain comparisons offer two sizings: distinct (each mask weighs 1) and
// weighted (each mask weighs the passwords behind it). Word-domain comparison
// is always distinct — a wordlist carries no counts.
//
// The Venn is area-proportional: circle areas track each side's total and the
// lens area is solved so it tracks the shared total too.
//
// Files are streamed and parsed in the browser — nothing is uploaded. Parsing
// reads from a ReadableStream, so an API source later means handing
// `parseCorpus` a `response.body` instead of a `file.stream()`.

import { parseCorpus, computeOverlap, topSharedMasks, KIND_LABELS } from "../util/masks.js";
import { computeWordOverlap, sampleSharedWords } from "../util/words.js";
import { vennLayout } from "../util/venn.js";
import { listServerFiles, serverFilePickerHtml, wireServerFilePicker } from "../util/serverFiles.js";

export const name = "overlap";

const COLOR_A = "#534AB7"; // mask purple — same accent as the other scenes
const COLOR_B = "#185FA5"; // info blue
const R_MAX = 108;         // px radius of the larger circle
const TOP_SHARED = 15;
const SAMPLE_WORDS = 20;

export async function render(mount) {
  // Charts read better with more room than the shared #view's default
  // 1200px cap (see app.js: `main { max-width: 1200px }`) — widen just this
  // scene; app.js resets it on the next scene change so it can't leak.
  mount.style.maxWidth = "1600px";
  mount.innerHTML = `
    <div class="panel">
      <h2>Overlap</h2>
      <div class="sub">
        Load two files — a wordlist (one password per line) or a PACK statsgen
        <code>.masks</code> file (<code>mask,count</code>). The kind is detected from the content.
        Streamed and parsed in your browser — nothing is uploaded.
      </div>

      <div class="grid-2" id="slots"></div>

      <div id="domain"></div>

      <div id="controls" class="hidden" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:14px 0 6px;font-size:12px;color:var(--text-secondary)">
        <span id="mode-wrap" style="display:flex;gap:8px;align-items:center">
          <span style="white-space:nowrap">Size regions by</span>
          <button data-mode="distinct" class="primary">Distinct</button>
          <button data-mode="weighted">Weighted by passwords</button>
        </span>
        <span style="margin-left:auto;display:flex;gap:8px">
          <button id="swap">swap A / B</button>
          <button id="clear">clear both</button>
        </span>
      </div>

      <div id="venn"></div>
      <div id="stats"></div>
      <div id="note" class="note hidden"></div>
      <div id="shared"></div>
    </div>
  `;

  const slotsBox = mount.querySelector("#slots");
  const domainBox = mount.querySelector("#domain");
  const controls = mount.querySelector("#controls");
  const modeWrap = mount.querySelector("#mode-wrap");
  const vennBox = mount.querySelector("#venn");
  const statsBox = mount.querySelector("#stats");
  const noteBox = mount.querySelector("#note");
  const sharedBox = mount.querySelector("#shared");

  // `token` guards against a slow parse landing after the user has already
  // replaced the file in that slot. `file` is retained so the shared-password
  // sample can re-stream it without a second upload.
  // `forced` is null for auto-detect, or a kind the user picked by hand.
  const slots = [
    { key: "A", color: COLOR_A, name: null, file: null, corpus: null, forced: null, busy: false, error: null, progress: 0, token: 0 },
    { key: "B", color: COLOR_B, name: null, file: null, corpus: null, forced: null, busy: false, error: null, progress: 0, token: 0 },
  ];
  let mode = "distinct";
  let sampleToken = 0;

  // No extension filter — either kind is accepted here, detected from content.
  let serverFiles = [];
  let serverFilesLoaded = false;
  listServerFiles("").then((files) => { serverFiles = files; serverFilesLoaded = true; renderSlots(); });

  renderSlots();
  refresh();

  for (const b of controls.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      for (const o of controls.querySelectorAll("[data-mode]")) {
        o.classList.toggle("primary", o.dataset.mode === mode);
      }
      refresh();
    });
  }
  controls.querySelector("#swap").addEventListener("click", () => {
    const [a, b] = slots;
    for (const f of ["name", "file", "corpus", "error", "forced"]) [a[f], b[f]] = [b[f], a[f]];
    a.token++; b.token++;
    renderSlots();
    refresh();
  });
  controls.querySelector("#clear").addEventListener("click", () => {
    for (const s of slots) clearSlot(s);
    renderSlots();
    refresh();
  });

  function clearSlot(s) {
    s.name = null; s.file = null; s.corpus = null; s.error = null;
    s.forced = null; s.busy = false; s.progress = 0; s.token++;
  }

  // ── slots ────────────────────────────────────────────────────────────────
  function renderSlots() {
    slotsBox.innerHTML = slots.map(slotHtml).join("");
    for (const s of slots) wireSlot(s);
  }

  function slotHtml(s) {
    const c = s.corpus;
    const isWords = c && c.kind === "wordlist";
    // .hcmask lines carry no counts, so "passwords" would be a lie there.
    const itemsLabel = c && c.kind === "hcmask" ? "Mask lines" : "Passwords";

    const body = s.busy
      ? `<div class="sub" style="margin:0">reading ${escapeHtml(s.name || "")}…</div>
         <div style="height:4px;background:var(--surface-3);border-radius:2px;margin-top:8px;overflow:hidden">
           <div style="height:100%;width:${(s.progress * 100).toFixed(1)}%;background:${s.color};transition:width .15s"></div>
         </div>`
      : s.error
        ? `<div class="card danger" style="margin:0">${escapeHtml(s.error)}</div>`
        : c
          ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
               <span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block"></span>
               <b style="font-size:13px">${escapeHtml(baseName(s.name))}</b>
               <span class="pill ${isWords ? "pill-info" : "pill-mask"}">${KIND_LABELS[c.kind]}</span>
               ${s.forced && c.detected && s.forced !== c.detected
                 ? `<span class="pill pill-warning" title="auto-detect said ${KIND_LABELS[c.detected]}">overridden</span>`
                 : ""}
             </div>
             <table class="kv" style="margin-top:8px">
               <tr><td>${itemsLabel}</td><td>${c.items.toLocaleString()}</td></tr>
               ${isWords
                 ? `<tr><td>Distinct passwords</td><td>${(c.words ? c.words.length : 0).toLocaleString()}</td></tr>`
                 : `<tr><td>Distinct masks</td><td>${c.masks.size.toLocaleString()}</td></tr>`}
               ${c.skipped ? `<tr><td>Unparsed lines</td><td>${c.skipped.toLocaleString()}</td></tr>` : ""}
               ${c.custom ? `<tr><td title="custom ?1–?4 charsets with no built-in equivalent; compared literally">Custom-charset lines</td><td>${c.custom.toLocaleString()}</td></tr>` : ""}
             </table>`
          : `<div class="sub" style="margin:0">no file loaded</div>`;

    const opt = (v, text) =>
      `<option value="${v}"${(s.forced || "") === v ? " selected" : ""}>${text}</option>`;

    return `
      <div class="card" data-slot="${s.key}" style="border-style:${c || s.busy ? "solid" : "dashed"};border-color:${c ? s.color : "var(--border-2)"}">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
          <b style="font-size:12px;letter-spacing:.4px;color:var(--text-secondary)">FILE ${s.key}</b>
          <span style="display:flex;gap:6px">
            <button data-pick="${s.key}" style="font-size:12px">${c ? "replace" : "choose file"}</button>
            ${c ? `<button data-rm="${s.key}" style="font-size:12px">remove</button>` : ""}
          </span>
        </div>
        <input type="file" data-input="${s.key}" style="display:none"/>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:var(--text-secondary)">
          <span style="white-space:nowrap">Treat as</span>
          <select data-kind="${s.key}" style="flex:1"${s.file ? "" : " disabled"}>
            ${opt("", c && c.detected ? `Auto-detect — ${KIND_LABELS[c.detected]}` : "Auto-detect")}
            ${opt("wordlist", "Wordlist — one password per line")}
            ${opt("hcmask", "hashcat .hcmask — one mask per line")}
            ${opt("masks", "PACK .masks — mask,count per line")}
          </select>
        </label>
        ${body}
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">or drop a file here</div>
        ${serverFilesLoaded ? serverFilePickerHtml(serverFiles, `overlap-${s.key}`) : `<div class="sub" style="margin:8px 0 0">indexing…</div>`}
      </div>
    `;
  }

  function wireSlot(s) {
    const card = slotsBox.querySelector(`[data-slot="${s.key}"]`);
    if (!card) return;
    const input = card.querySelector(`[data-input="${s.key}"]`);
    card.querySelector(`[data-pick="${s.key}"]`).addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      // A different file may well be a different kind — back to auto.
      if (input.files && input.files[0]) { s.forced = null; loadInto(s, input.files[0]); }
      input.value = "";
    });
    const rm = card.querySelector(`[data-rm="${s.key}"]`);
    if (rm) {
      rm.addEventListener("click", () => { clearSlot(s); renderSlots(); refresh(); });
    }
    // Changing the kind re-reads the retained File under the new
    // interpretation — no re-upload needed.
    card.querySelector(`[data-kind="${s.key}"]`).addEventListener("change", (e) => {
      s.forced = e.target.value || null;
      if (s.file) loadInto(s, s.file);
    });
    wireServerFilePicker(card, serverFiles, `overlap-${s.key}`, "", (file) => {
      s.forced = null;
      return loadInto(s, file);
    });
    card.addEventListener("dragover", (e) => { e.preventDefault(); card.style.borderColor = s.color; });
    card.addEventListener("dragleave", () => { card.style.borderColor = s.corpus ? s.color : "var(--border-2)"; });
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      s.forced = null;
      loadInto(s, files[0]); // dropping two at once fills both slots in order
      const other = slots.find((o) => o !== s);
      if (files[1] && other) { other.forced = null; loadInto(other, files[1]); }
    });
  }

  // ── loading ──────────────────────────────────────────────────────────────
  // Takes a File today. An API source would hand parseCorpus a `response.body`
  // instead — nothing below this line cares where the bytes came from.
  async function loadInto(slot, file) {
    const token = ++slot.token;
    slot.name = file.name;
    slot.file = file;
    slot.corpus = null;
    slot.error = null;
    slot.busy = true;
    slot.progress = 0;
    renderSlots();
    refresh();

    const size = file.size || 0;
    let lastPaint = 0;

    try {
      const corpus = await parseCorpus(file.stream(), {
        words: true,
        kind: slot.forced,
        onChunk: async (bytes) => {
          if (slot.token !== token) return;
          slot.progress = size ? Math.min(1, bytes / size) : 0;
          const now = performance.now();
          if (now - lastPaint > 50) { // ~20 repaints/s, and yield so the bar moves
            lastPaint = now;
            renderSlots();
            await new Promise((r) => setTimeout(r, 0));
          }
        },
      });
      if (slot.token !== token) return; // superseded by a newer file
      if (!corpus.masks.size) {
        slot.error = slot.forced
          ? `${file.name} has no lines readable as ${KIND_LABELS[slot.forced]} — try a different "treat as".`
          : `no usable lines in ${file.name}`;
      } else {
        slot.corpus = corpus;
      }
    } catch (err) {
      if (slot.token !== token) return;
      slot.error = `could not read ${file.name}: ${err.message}`;
    } finally {
      if (slot.token === token) {
        slot.busy = false;
        slot.progress = 0;
        renderSlots();
        refresh();
      }
    }
  }

  // ── results ──────────────────────────────────────────────────────────────
  // Two wordlists compare as words; anything else falls back to mask space.
  function domainOf(a, b) {
    return a.corpus.kind === "wordlist" && b.corpus.kind === "wordlist" ? "words" : "masks";
  }

  function refresh() {
    const [a, b] = slots;
    const ready = a.corpus && b.corpus;
    controls.classList.toggle("hidden", !(a.corpus || b.corpus));
    noteBox.classList.toggle("hidden", !ready);
    sampleToken++;

    if (!ready) {
      domainBox.innerHTML = "";
      vennBox.innerHTML = "";
      statsBox.innerHTML = "";
      sharedBox.innerHTML = "";
      return;
    }

    const domain = domainOf(a, b);
    const weighted = domain === "masks" && mode === "weighted";
    // Sizing choice only exists in mask space — a wordlist carries no counts.
    modeWrap.classList.toggle("hidden", domain !== "masks");

    domainBox.innerHTML = domainHtml(domain, a, b);
    noteBox.innerHTML = noteHtml(domain);

    const ov = domain === "words"
      ? computeWordOverlap(a.corpus.words, b.corpus.words)
      : computeOverlap(a.corpus.masks, b.corpus.masks, { weighted });

    vennBox.innerHTML = vennHtml(ov, a, b, unitLabel(domain, weighted));
    statsBox.innerHTML = statsHtml(ov, a, b, domain, weighted);

    if (domain === "masks") {
      sharedBox.innerHTML = sharedMasksHtml(a, b, weighted);
    } else {
      showWordSample(a, b, ov);
    }
  }

  // Re-stream B, keeping the first few entries that also appear in A. Stops as
  // soon as the cap is reached, so it costs a partial pass rather than a full
  // one — and needs no extra memory, since A is already a sorted hash array.
  async function showWordSample(a, b, ov) {
    const token = sampleToken;
    if (!ov.shared || !b.file) {
      sharedBox.innerHTML = ov.shared
        ? ""
        : `<div class="sub" style="margin-top:14px">No password appears in both files.</div>`;
      return;
    }
    sharedBox.innerHTML = `<div class="sub" style="margin-top:14px">finding example shared passwords…</div>`;
    try {
      const words = await sampleSharedWords(b.file.stream(), a.corpus.words, SAMPLE_WORDS);
      if (token !== sampleToken) return;
      sharedBox.innerHTML = `
        <div style="font-weight:500;margin:18px 0 6px">
          Example shared passwords
          <span class="sub" style="font-weight:400;font-size:11px">(first ${words.length} found in B that also appear in A, of ${ov.shared.toLocaleString()})</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${words.map((w) => `<code style="background:var(--surface-2);border:0.5px solid var(--border);border-radius:4px;padding:2px 7px">${escapeHtml(w)}</code>`).join("")}
        </div>`;
    } catch (err) {
      if (token !== sampleToken) return;
      sharedBox.innerHTML = `<div class="sub" style="margin-top:14px">could not sample shared passwords: ${escapeHtml(err.message)}</div>`;
    }
  }
}

// ── copy ───────────────────────────────────────────────────────────────────
function unitLabel(domain, weighted) {
  if (domain === "words") return "distinct passwords";
  // "mask occurrences" covers both sources: a PACK count, or one per
  // .hcmask line.
  return weighted ? "mask occurrences" : "distinct masks";
}

function domainHtml(domain, a, b) {
  if (domain === "words") {
    return `<div class="card info" style="margin-top:12px">
      Comparing <b>passwords</b> — both files are wordlists, so this is the overlap of their actual entries.
    </div>`;
  }
  // Mask domain. Only a wordlist on one side needs the caveat — two mask
  // files compare exactly, even in different formats.
  const wl = a.corpus.kind === "wordlist" ? "A" : b.corpus.kind === "wordlist" ? "B" : null;
  if (!wl) {
    const same = a.corpus.kind === b.corpus.kind;
    return `<div class="card mask" style="margin-top:12px">
      Comparing <b>masks</b> — both files are mask files${same ? "" : ` (${KIND_LABELS[a.corpus.kind]} vs ${KIND_LABELS[b.corpus.kind]})`}.
    </div>`;
  }
  return `<div class="card warning" style="margin-top:12px">
    Comparing <b>mask shapes</b>, not passwords — ${wl} is a wordlist and the other is a mask file, so the only
    common ground is mask space. Wordlist ${wl} has been reduced to the masks its passwords occupy. Most
    wordlists share the common shapes, so expect a high overlap here even between unrelated files; load two
    wordlists to compare actual passwords.
  </div>`;
}

function noteHtml(domain) {
  if (domain === "words") {
    return "Each distinct password counts once; duplicate lines within a file are collapsed. Circle areas are " +
      "proportional to each file's distinct passwords and the lens area to the shared count, so all three " +
      "regions read at one scale. Jaccard is shared ÷ union. Passwords are compared by a 53-bit hash rather " +
      "than kept as strings, which keeps a rockyou-sized list around 110 MB instead of ~700 MB; at that size " +
      "the expected number of hash collisions is about 0.01, so the counts are exact in practice.";
  }
  return "<b>Distinct</b> counts each unique mask once; <b>weighted</b> counts each mask once per password " +
    "behind it. The shared region is the multiset intersection (per mask, the smaller of the two weights), " +
    "so the circles stay consistent: each circle's own region plus the lens equals its total. Jaccard is " +
    "shared ÷ union.";
}

// ── Venn ───────────────────────────────────────────────────────────────────
function vennHtml(ov, a, b, unit) {
  const { totalA, totalB, shared, onlyA, onlyB } = ov;
  const g = vennLayout(totalA, totalB, shared, { rMax: R_MAX });
  if (!g) return "";
  const { rA, rB, width: w, height: h, cx1, cx2, cy, xOnlyA, xOnlyB, xShared } = g;

  const label = (x, value, sub) => `
    <text x="${x.toFixed(1)}" y="${(cy - 4).toFixed(1)}" text-anchor="middle"
          font-size="15" font-weight="600" fill="var(--text)"
          stroke="var(--surface)" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${value}</text>
    <text x="${x.toFixed(1)}" y="${(cy + 13).toFixed(1)}" text-anchor="middle"
          font-size="10.5" fill="var(--text-secondary)"
          stroke="var(--surface)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${sub}</text>`;

  return `
    <div style="display:flex;justify-content:center;margin:18px 0 6px">
      <svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="100%"
           style="max-width:${Math.min(760, w * 1.4).toFixed(0)}px;height:auto" role="img"
           aria-label="Venn diagram of overlap between ${escapeHtml(baseName(a.name))} and ${escapeHtml(baseName(b.name))}">
        <circle cx="${cx1.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rA.toFixed(1)}"
                fill="${COLOR_A}" fill-opacity="0.42" stroke="${COLOR_A}" stroke-width="1.5"/>
        <circle cx="${cx2.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rB.toFixed(1)}"
                fill="${COLOR_B}" fill-opacity="0.42" stroke="${COLOR_B}" stroke-width="1.5"/>
        ${onlyA > 0 ? label(xOnlyA, formatN(onlyA), "only A") : ""}
        ${shared > 0 ? label(xShared, formatN(shared), "shared") : ""}
        ${onlyB > 0 ? label(xOnlyB, formatN(onlyB), "only B") : ""}
      </svg>
    </div>
    <div style="display:flex;gap:18px;justify-content:center;flex-wrap:wrap;font-size:12px;color:var(--text-secondary)">
      <span><span style="width:10px;height:10px;border-radius:2px;background:${COLOR_A};display:inline-block;margin-right:6px"></span>A · ${escapeHtml(baseName(a.name))}</span>
      <span><span style="width:10px;height:10px;border-radius:2px;background:${COLOR_B};display:inline-block;margin-right:6px"></span>B · ${escapeHtml(baseName(b.name))}</span>
      <span>areas proportional to ${unit}</span>
    </div>
  `;
}

function statsHtml(ov, a, b, domain, weighted) {
  const unit = unitLabel(domain, weighted);
  const noun = domain === "words" ? "Passwords in both" : "Masks in both";
  const extra = domain === "words" ? null : ov.sharedMasks;
  const cell = (v) => `<td style="text-align:right;font-variant-numeric:tabular-nums">${v}</td>`;
  const row = (label, n, share) =>
    `<tr><td style="padding:3px 14px 3px 0">${label}</td>${cell(n)}${cell(share)}</tr>`;
  return `
    <div style="overflow:auto;margin-top:16px">
      <table style="border-collapse:collapse;font-size:12px;min-width:420px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 14px 4px 0;font-weight:500">Measure</th>
          <th style="padding:4px 14px 4px 0;font-weight:500;text-align:right">${unit}</th>
          <th style="padding:4px 0;font-weight:500;text-align:right">share</th>
        </tr></thead>
        <tbody>
          ${row(`A · ${escapeHtml(baseName(a.name))}`, ov.totalA.toLocaleString(), "—")}
          ${row(`B · ${escapeHtml(baseName(b.name))}`, ov.totalB.toLocaleString(), "—")}
          ${row("Shared", ov.shared.toLocaleString(), pct(ov.shared, ov.union) + "% of union")}
          ${row("Only in A", ov.onlyA.toLocaleString(), pct(ov.onlyA, ov.totalA) + "% of A")}
          ${row("Only in B", ov.onlyB.toLocaleString(), pct(ov.onlyB, ov.totalB) + "% of B")}
          ${row("A covered by B", "—", pct(ov.shared, ov.totalA) + "%")}
          ${row("B covered by A", "—", pct(ov.shared, ov.totalB) + "%")}
          ${row("<b>Jaccard</b>", "—", "<b>" + pct(ov.jaccard, 1) + "%</b>")}
          ${extra != null ? row(noun, extra.toLocaleString(), "—") : ""}
        </tbody>
      </table>
    </div>
  `;
}

function sharedMasksHtml(a, b, weighted) {
  const rows = topSharedMasks(a.corpus.masks, b.corpus.masks, { weighted, top: TOP_SHARED });
  if (!rows.length) {
    return `<div class="sub" style="margin-top:14px">No mask appears in both files.</div>`;
  }
  const num = "text-align:right;font-variant-numeric:tabular-nums";
  return `
    <div style="font-weight:500;margin:18px 0 6px">
      Top shared masks
      <span class="sub" style="font-weight:400;font-size:11px">(by contribution to the shared region)</span>
    </div>
    <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--text-secondary);text-align:left">
        <th style="padding:4px 14px 4px 0;font-weight:500">Mask</th>
        <th style="padding:4px 14px 4px 0;font-weight:500">Len</th>
        <th style="padding:4px 14px 4px 0;font-weight:500;${num}">In A</th>
        <th style="padding:4px 14px 4px 0;font-weight:500;${num}">In B</th>
        <th style="padding:4px 0;font-weight:500;${num}">Shared</th>
      </tr></thead>
      <tbody>
        ${rows.map((r) => `<tr>
          <td style="padding:3px 14px 3px 0"><code>${escapeHtml(r.mask)}</code></td>
          <td style="padding:3px 14px 3px 0;${num}">${maskLength(r.mask)}</td>
          <td style="padding:3px 14px 3px 0;${num}">${r.countA.toLocaleString()}</td>
          <td style="padding:3px 14px 3px 0;${num}">${r.countB.toLocaleString()}</td>
          <td style="padding:3px 0;${num}">${r.weight.toLocaleString()}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>
  `;
}

// ── helpers ────────────────────────────────────────────────────────────────
function maskLength(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "?" && i + 1 < mask.length) i++;
    n++;
  }
  return n;
}

function pct(part, whole) {
  if (!whole) return "0.0";
  return ((part / whole) * 100).toFixed(1);
}

function formatN(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}

function baseName(n) {
  return String(n || "").replace(/\.(masks|txt|csv|lst|dic)$/i, "");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
