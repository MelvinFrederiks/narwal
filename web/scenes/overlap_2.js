// Scene — Pairwise overlap with drag-and-drop attack tokens.
//
// Tokens for every attack sit in a draggable tray at the top. Drop one
// onto slot A or B, and the Venn + verdict box rerender. Same Jaccard
// numbers as the underlying /api/overlap endpoint; this scene just makes
// pair selection tactile.

import { getSelected, labelFor, subscribe } from "../util/selection.js";
import { iconFor, iconChip, renderIconSvg } from "../util/attack_icons.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "overlap-2";

const A_FILL = "#534AB7", A_STROKE = "#3C3489";
const B_FILL = "#1D9E75", B_STROKE = "#0F6E56";

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Overlap · pairwise</h2>
      <div class="sub">
        Drag any two attacks into the slots. The Venn shows their overlap on the chosen reference;
        colour = wordlist family, shape = deterministic per attack id.
      </div>

      <div id="select-warning" class="card warning hidden" style="margin-bottom:10px">
        No datasets selected in Setup. <a href="#setup">Go to Setup</a>.
      </div>

      <form id="ctrl" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <label>Reference
          <select id="reference"></select>
        </label>
        <label>Mode
          <select id="mode">
            <option value="real" selected>real (hashcat hits cached)</option>
            <option value="approx">approx (PACK histogram · instant)</option>
          </select>
        </label>
      </form>

      <div style="font-weight:500;font-size:12px;margin-bottom:6px;color:var(--text-secondary)">Attack tray</div>
      <div id="tray" class="tray"></div>

      <div class="slot-row">
        <div class="slot" id="slotA"><span class="slot-hint">drop attack A here</span></div>
        <span style="font-size:18px;color:var(--text-secondary)">vs</span>
        <div class="slot" id="slotB"><span class="slot-hint">drop attack B here</span></div>
      </div>

      <div class="grid-2" style="align-items:start;margin-top:14px">
        <div style="position:relative;min-height:260px">
          <div id="venn-overlay" class="overlay hidden">
            <div class="spinner"></div>
            <div class="label">loading…</div>
          </div>
          <svg id="venn" viewBox="0 0 360 260" width="100%" role="img">
            <circle id="cA" cx="140" cy="130" r="80" fill="${A_FILL}" fill-opacity="0.35" stroke="${A_STROKE}" stroke-width="1"/>
            <circle id="cB" cx="220" cy="130" r="80" fill="${B_FILL}" fill-opacity="0.35" stroke="${B_STROKE}" stroke-width="1"/>
            <!-- Label fills use theme-aware tokens so they read on both
                 light and dark surfaces. --mask-text ≈ purple, --success-text ≈ green. -->
            <text id="labA"  x="70"  y="120" text-anchor="middle" font-size="12" fill="var(--mask-text)"    font-weight="600">A only</text>
            <text id="labAn" x="70"  y="142" text-anchor="middle" font-size="16" fill="var(--mask-text)"    font-weight="700">—</text>
            <text id="labO"  x="180" y="120" text-anchor="middle" font-size="12" fill="var(--text)"          font-weight="600">both</text>
            <text id="labOn" x="180" y="142" text-anchor="middle" font-size="16" fill="var(--text)"          font-weight="700">—</text>
            <text id="labB"  x="290" y="120" text-anchor="middle" font-size="12" fill="var(--success-text)"  font-weight="600">B only</text>
            <text id="labBn" x="290" y="142" text-anchor="middle" font-size="16" fill="var(--success-text)"  font-weight="700">—</text>
          </svg>
        </div>
        <div class="card-list">
          <div class="card"><div class="sub" style="margin:0">Jaccard overlap</div><div id="jacc" style="font-size:22px;font-weight:500">—</div></div>
          <div class="card"><div class="sub" style="margin:0">Marginal gain from running both</div><div id="gain" style="font-size:22px;font-weight:500">—</div></div>
          <div class="card" id="verdict-box">
            <div id="verdictTitle" style="font-weight:500">Pick two attacks</div>
            <div id="verdictBody" class="sub" style="margin-top:4px">Drag tokens above into the slots.</div>
          </div>
        </div>
      </div>

      <div style="margin-top:18px">
        <div class="sub">all pairs ranked by Jaccard · click to load into slots</div>
        <div id="pairList" style="display:flex;flex-direction:column;gap:4px;margin-top:8px"></div>
      </div>
    </div>

    <style>
      .tray {
        display:flex; gap:8px; flex-wrap:wrap; padding:10px;
        border:1px solid var(--surface-3); border-radius:10px;
        background:var(--surface-2); margin-bottom:12px;
      }
      .chip {
        display:inline-flex; align-items:center; gap:8px;
        padding:7px 14px; border:1px solid var(--border-2); border-radius:999px;
        background:var(--surface); color:var(--text);
        font-size:13px; font-weight:500; line-height:1;
        cursor:grab; user-select:none;
        transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
      }
      .chip:hover { background:var(--surface-2); border-color:var(--info-border); }
      .chip:active { cursor:grabbing; transform:scale(0.97); }
      .chip.dragging { opacity:0.4; }

      .slot-row { display:flex; gap:10px; align-items:center; justify-content:center; margin-top:14px; }
      .slot {
        flex:0 0 320px; min-height:68px;
        display:flex; align-items:center; justify-content:center; gap:8px;
        border:2px dashed var(--border-2); border-radius:10px; padding:10px 14px;
        background:var(--surface);
      }
      .slot.drag-over { border-color:var(--info-border); background:var(--info-bg); }
      .slot.filled { border-style:solid; }
      .slot-hint { color:var(--text-tertiary); font-size:12px; }
      .slot-attack {
        display:flex; align-items:center; gap:10px;
        font-weight:600; font-size:15px; color:var(--text);
      }
      .slot-clear {
        background:transparent; border:0; cursor:pointer;
        color:var(--text-tertiary); font-size:16px; padding:2px 6px;
      }
      .slot-clear:hover { color:var(--text); }

      /* Ranked-pair table — denser than cards, much higher contrast. */
      #pairList .pair-row {
        display:grid;
        grid-template-columns: 52px 1fr auto;
        align-items:center; gap:14px;
        padding:8px 12px;
        background:var(--surface-2);
        border:0.5px solid var(--surface-3);
        border-radius:var(--radius-md);
        cursor:pointer;
        transition: background 0.12s ease, border-color 0.12s ease;
      }
      #pairList .pair-row:hover { background:var(--surface); border-color:var(--info-border); }
      #pairList .pair-jacc {
        font-weight:600; font-size:14px;
        font-variant-numeric:tabular-nums;
      }
      #pairList .pair-attacks {
        display:flex; align-items:center; gap:10px;
        font-size:13px; font-weight:500; color:var(--text);
        min-width:0;
      }
      #pairList .pair-attacks .a {
        display:inline-flex; align-items:center; gap:6px;
      }
      #pairList .pair-sep {
        color:var(--text-tertiary); font-size:14px; padding:0 2px;
      }
      #pairList .pair-gain {
        font-size:12px; color:var(--text-secondary);
        font-variant-numeric:tabular-nums;
      }
    </style>
  `;

  const overlay = mount.querySelector("#venn-overlay");
  const referenceSel = mount.querySelector("#reference");
  const modeSel = mount.querySelector("#mode");
  const tray = mount.querySelector("#tray");
  const slotA = mount.querySelector("#slotA");
  const slotB = mount.querySelector("#slotB");
  const warning = mount.querySelector("#select-warning");

  let library = [];
  let matrix = null;
  let slots = { A: null, B: null };

  // ── Reference dropdown wired to Setup selection ──
  async function populateReferenceSelector() {
    const sel = await getSelected();
    const prev = referenceSel.value;
    referenceSel.innerHTML = sel.length === 0
      ? `<option value="">(none — pick in Setup)</option>`
      : sel.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join("");
    if (prev && sel.includes(prev)) referenceSel.value = prev;
    warning.classList.toggle("hidden", sel.length > 0);
  }
  subscribe(async () => { await populateReferenceSelector(); await loadMatrix(); });

  // ── Library + tray ──
  async function loadLibrary() {
    const r = await fetch("/api/compose/library");
    library = (await r.json()).attacks.filter((a) =>
      ["wordlist", "wordlist+rules", "mask", "fla"].includes(a.type)
    );
    tray.innerHTML = library.map((a) => `
      <div class="chip" draggable="true" data-id="${a.id}">
        ${iconChip(a, 16)}
        <span>${a.label}</span>
      </div>
    `).join("");
    for (const chip of tray.querySelectorAll(".chip")) wireDrag(chip);

    if (library.length >= 2) {
      slots.A = library[0].id;
      slots.B = library[1].id;
      renderSlots();
    }
  }

  function wireDrag(chip) {
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", chip.dataset.id);
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  }
  for (const slot of [slotA, slotB]) {
    slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("drag-over"); });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      slot.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const which = slot === slotA ? "A" : "B";
      slots[which] = id;
      renderSlots();
      renderVenn();
    });
  }

  function renderSlots() {
    for (const which of ["A", "B"]) {
      const slot = which === "A" ? slotA : slotB;
      const id = slots[which];
      if (!id) {
        slot.classList.remove("filled");
        slot.innerHTML = `<span class="slot-hint">drop attack ${which} here</span>`;
        continue;
      }
      const atk = library.find((a) => a.id === id);
      if (!atk) continue;
      slot.classList.add("filled");
      slot.innerHTML = `
        <div class="slot-attack">${iconChip(atk, 22)} ${atk.label}</div>
        <button class="slot-clear" data-which="${which}" title="clear slot">✕</button>
      `;
    }
    for (const btn of mount.querySelectorAll(".slot-clear")) {
      btn.addEventListener("click", () => {
        slots[btn.dataset.which] = null;
        renderSlots();
        renderVenn();
      });
    }
  }

  // ── Matrix fetch ──
  async function loadMatrix() {
    if (!referenceSel.value) { matrix = null; mount.querySelector("#pairList").innerHTML = ""; renderVenn(); return; }
    overlay.classList.remove("hidden");
    overlay.querySelector(".label").textContent =
      modeSel.value === "real" ? "loading cached hits…" : "estimating overlap…";
    const attacks = library.map((a) => a.id).join(",");
    const r = await fetch(`/api/overlap?reference=${referenceSel.value}&attacks=${encodeURIComponent(attacks)}&mode=${modeSel.value}`);
    if (!r.ok) {
      overlay.querySelector(".label").textContent = `error: HTTP ${r.status}`;
      return;
    }
    matrix = await r.json();
    overlay.classList.add("hidden");
    renderVenn();
    renderPairs();
  }
  modeSel.addEventListener("change", loadMatrix);
  referenceSel.addEventListener("change", loadMatrix);

  // ── Venn rendering (reused from overlap.js) ──
  function findCell(a, b) {
    if (!matrix) return null;
    return matrix.cells.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
  }

  function renderVenn() {
    const a = slots.A, b = slots.B;
    const labLib = Object.fromEntries(library.map((x) => [x.id, x.label]));
    const sizeA = a ? (matrix?.set_sizes?.[a] || 0) : 0;
    const sizeB = b ? (matrix?.set_sizes?.[b] || 0) : 0;

    let jacc = 0, only_a = sizeA, only_b = sizeB, intersect = 0, union = sizeA + sizeB;
    if (a && b) {
      if (a === b) {
        jacc = 1.0; only_a = 0; only_b = 0; intersect = sizeA; union = sizeA;
      } else {
        const cell = findCell(a, b);
        if (cell) {
          jacc = cell.jaccard;
          only_a = cell.only_a; only_b = cell.only_b;
          intersect = cell.intersect; union = cell.union;
        }
      }
    }
    const maxSingle = Math.max(sizeA, sizeB) || 1;
    const gainPct = (a && b && a !== b) ? Math.round(((union - maxSingle) / maxSingle) * 100) : 0;

    const r = 80;
    const dist = Math.round(r * 2 * (1 - Math.min(jacc, 0.95)));
    const cx = 180;
    // Label x: pulled inside the circle (r*0.55 from circle centre)
    // so the text doesn't run off the SVG viewBox on either side.
    const labOffset = Math.round(r * 0.55);
    const aLabelX = cx - dist / 2 - labOffset;
    const bLabelX = cx + dist / 2 + labOffset;
    mount.querySelector("#cA").setAttribute("cx", cx - dist / 2);
    mount.querySelector("#cB").setAttribute("cx", cx + dist / 2);
    mount.querySelector("#labA").setAttribute("x", aLabelX);
    mount.querySelector("#labAn").setAttribute("x", aLabelX);
    mount.querySelector("#labB").setAttribute("x", bLabelX);
    mount.querySelector("#labBn").setAttribute("x", bLabelX);

    const aLabel = a ? (labLib[a] || a) : "(empty)";
    const bLabel = b ? (labLib[b] || b) : "(empty)";
    // Venn labels sit outside the circles in a narrow margin — long
    // attack names overflow the viewBox. Truncate with an ellipsis and
    // keep the full text in an SVG <title> for hover. Slot cards above
    // already show the full label, so this is just for the Venn.
    function setVennLabel(el, text, full) {
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(document.createTextNode(text));
      if (full) {
        const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
        t.textContent = full;
        el.appendChild(t);
      }
    }
    // Just the (truncated) name in the Venn — position conveys A vs B,
    // so " only" was redundant and ate space. Full label in tooltip.
    const aShort = truncate(aLabel, 13);
    const bShort = truncate(bLabel, 13);
    setVennLabel(mount.querySelector("#labA"),
      !a || !b ? "" : (a === b ? "—" : aShort),
      aLabel);
    mount.querySelector("#labAn").textContent = !a || !b || a === b ? "" : fmt(only_a);
    mount.querySelector("#labOn").textContent = (a && b) ? fmt(intersect) : "—";
    setVennLabel(mount.querySelector("#labB"),
      !a || !b ? "" : (a === b ? "—" : bShort),
      bLabel);
    mount.querySelector("#labBn").textContent = !a || !b || a === b ? "" : fmt(only_b);

    mount.querySelector("#jacc").textContent = (a && b) ? jacc.toFixed(2) : "—";
    mount.querySelector("#gain").textContent = (a && b) ? ((gainPct >= 0 ? "+" : "") + gainPct + "%") : "—";

    const v = mount.querySelector("#verdict-box");
    const vt = mount.querySelector("#verdictTitle");
    const vb = mount.querySelector("#verdictBody");
    v.classList.remove("info", "danger", "warning", "success");
    if (!a || !b) {
      vt.textContent = "Pick two attacks";
      vb.textContent = "Drag tokens above into the slots.";
    } else if (a === b) {
      vt.textContent = "Same attack";
      vb.textContent = "Drag a different attack into the other slot.";
    } else if (jacc >= 0.6) {
      v.classList.add("danger");
      vt.textContent = "Redundant — drop one";
      vb.textContent = `Most of ${bLabel}'s catches duplicate ${aLabel}. Running the cheaper of the two alone adds ${gainPct}% over what ${aLabel} already gives.`;
    } else if (jacc >= 0.3) {
      v.classList.add("warning");
      vt.textContent = "Partial overlap";
      vb.textContent = `${bLabel} adds ${gainPct}% novel cracks beyond ${aLabel}. Worth keeping if budget allows.`;
    } else {
      v.classList.add("success");
      vt.textContent = "Complementary — keep both";
      vb.textContent = `${bLabel} cracks mostly different passwords than ${aLabel}. Together: ${gainPct}% more coverage.`;
    }
  }

  function renderPairs() {
    if (!matrix) return;
    const labLib = Object.fromEntries(library.map((x) => [x.id, x.label]));
    const iconCache = Object.fromEntries(library.map((x) => [x.id, iconChip(x, 14)]));
    const sorted = [...matrix.cells].sort((x, y) => y.jaccard - x.jaccard);
    const list = mount.querySelector("#pairList");
    list.innerHTML = sorted.map((c) => {
      let color = "var(--success-text)";
      if (c.jaccard >= 0.6) color = "var(--danger-text)";
      else if (c.jaccard >= 0.3) color = "var(--warning-text)";
      return `
        <div class="pair-row" data-a="${c.a}" data-b="${c.b}">
          <span class="pair-jacc" style="color:${color}">${c.jaccard.toFixed(2)}</span>
          <span class="pair-attacks">
            <span class="a">${iconCache[c.a] || ""} ${labLib[c.a] || c.a}</span>
            <span class="pair-sep">vs</span>
            <span class="a">${iconCache[c.b] || ""} ${labLib[c.b] || c.b}</span>
          </span>
          <span class="pair-gain">+${c.marginal_gain_pct.toFixed(0)}%</span>
        </div>
      `;
    }).join("");
    for (const row of list.querySelectorAll("[data-a]")) {
      row.addEventListener("click", () => {
        slots.A = row.dataset.a;
        slots.B = row.dataset.b;
        renderSlots();
        renderVenn();
      });
    }
  }

  await loadLibrary();
  await populateReferenceSelector();
  await loadMatrix();
  mountFinishButton(mount, { sceneId: "overlap-2", label: "Overlap · pair" });
}

function truncate(s, max) {
  s = String(s);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}
