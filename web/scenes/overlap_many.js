// Scene — Force-directed graph of all attacks on a reference.
//
// Each attack is a draggable node (icon from attack_icons.js). Edges
// connect every pair with Jaccard > threshold; thickness ∝ Jaccard.
// Spring length is target = base * (1 - jaccard), so redundant pairs
// clump together and complementary attacks repel. Hover an edge for the
// pair detail; click to pin it as a Venn focus.

import { getSelected, labelFor, subscribe } from "../util/selection.js";
import { iconFor, iconChip, renderIconSvg } from "../util/attack_icons.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "overlap-many";

const W = 900, H = 520;
const NODE_R = 22;
const EDGE_MIN_JACC = 0.02;       // hide near-zero edges to reduce clutter

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Overlap · network</h2>
      <div class="sub">
        All attacks at once. Distance ≈ <em>1 − Jaccard</em>: redundant attacks clump,
        complementary attacks repel. Edge thickness ∝ Jaccard. Drag a node to reposition.
      </div>

      <div id="select-warning" class="card warning hidden" style="margin-bottom:10px">
        No datasets selected in Setup. <a href="#setup">Go to Setup</a>.
      </div>

      <form id="ctrl" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <label>Reference
          <select id="reference"></select>
        </label>
        <label>Mode
          <select id="mode">
            <option value="real" selected>real (hashcat hits cached)</option>
            <option value="approx">approx (PACK histogram · instant)</option>
          </select>
        </label>
        <span class="sub" style="font-size:11px">red = redundant · amber = partial · green = complementary</span>
      </form>

      <div class="graph-wrap" style="position:relative">
        <div id="graph-overlay" class="overlay hidden">
          <div class="spinner"></div>
          <div class="label">loading…</div>
        </div>
        <svg id="graph" viewBox="0 0 ${W} ${H}" width="100%" style="background:var(--surface);border:1px solid var(--surface-3);border-radius:8px"></svg>
        <div id="hover-card" class="hover-card hidden"></div>
      </div>

      <div id="focus-pair" class="card hidden" style="margin-top:12px"></div>
    </div>

    <style>
      .graph-wrap { user-select:none; }
      .node { cursor:grab; }
      .node.dragging { cursor:grabbing; }
      .edge { transition:opacity 0.2s; }
      .edge.faded { opacity:0.05; }
      .edge.hover { opacity:1 !important; stroke-width:5; }
      .node-label { font-size:11px; fill:var(--text); pointer-events:none; }
      .hover-card {
        position:absolute; padding:8px 10px; background:var(--surface-2);
        border:1px solid var(--surface-3); border-radius:6px;
        font-size:12px; pointer-events:none; z-index:5;
        box-shadow:0 4px 10px rgba(0,0,0,0.1);
      }
    </style>
  `;

  const overlay = mount.querySelector("#graph-overlay");
  const svg = mount.querySelector("#graph");
  const hoverCard = mount.querySelector("#hover-card");
  const focusPair = mount.querySelector("#focus-pair");
  const referenceSel = mount.querySelector("#reference");
  const modeSel = mount.querySelector("#mode");
  const warning = mount.querySelector("#select-warning");

  let library = [];
  let matrix = null;
  let nodes = [];           // {id, x, y, vx, vy, fixed, atk}
  let edges = [];           // {a, b, jacc, marginalGain}
  let simHandle = null;

  async function populateReferenceSelector() {
    const sel = await getSelected();
    const prev = referenceSel.value;
    referenceSel.innerHTML = sel.length === 0
      ? `<option value="">(none — pick in Setup)</option>`
      : sel.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join("");
    if (prev && sel.includes(prev)) referenceSel.value = prev;
    warning.classList.toggle("hidden", sel.length > 0);
  }
  subscribe(async () => { await populateReferenceSelector(); await reload(); });

  async function loadLibrary() {
    const r = await fetch("/api/compose/library");
    library = (await r.json()).attacks.filter((a) =>
      ["wordlist", "wordlist+rules", "mask", "fla"].includes(a.type)
    );
  }

  async function reload() {
    if (!referenceSel.value) { matrix = null; clearGraph(); return; }
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
    initGraph();
    runSimulation();
  }
  referenceSel.addEventListener("change", reload);
  modeSel.addEventListener("change", reload);

  function initGraph() {
    const present = new Set(matrix.attacks);
    const usable = library.filter((a) => present.has(a.id));
    // Spread nodes on a circle as initial layout.
    nodes = usable.map((atk, i) => {
      const t = (i / usable.length) * Math.PI * 2;
      return {
        id: atk.id, atk,
        x: W / 2 + Math.cos(t) * 180,
        y: H / 2 + Math.sin(t) * 140,
        vx: 0, vy: 0, fixed: false,
      };
    });
    edges = matrix.cells
      .filter((c) => c.jaccard >= EDGE_MIN_JACC)
      .map((c) => ({ a: c.a, b: c.b, jacc: c.jaccard, marginalGain: c.marginal_gain_pct }));
  }

  function clearGraph() {
    if (simHandle) cancelAnimationFrame(simHandle);
    svg.innerHTML = "";
  }

  function runSimulation() {
    if (simHandle) cancelAnimationFrame(simHandle);
    const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));

    function tick() {
      // Spring forces along edges.
      const BASE = 260;
      for (const e of edges) {
        const a = nodes[idx[e.a]], b = nodes[idx[e.b]];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const target = BASE * (1 - Math.min(e.jacc, 0.95));
        const k = 0.02 * e.jacc;            // stiffness ∝ jaccard
        const f = k * (dist - target);
        const ux = dx / dist, uy = dy / dist;
        if (!a.fixed) { a.vx += f * ux; a.vy += f * uy; }
        if (!b.fixed) { b.vx -= f * ux; b.vy -= f * uy; }
      }
      // All-pairs repulsion (Coulomb-ish) to keep disconnected nodes apart.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist2 = dx * dx + dy * dy + 100;
          const f = -2400 / dist2;
          const dist = Math.sqrt(dist2);
          const ux = dx / dist, uy = dy / dist;
          if (!a.fixed) { a.vx += f * ux; a.vy += f * uy; }
          if (!b.fixed) { b.vx -= f * ux; b.vy -= f * uy; }
        }
      }
      // Center attraction.
      for (const n of nodes) {
        if (n.fixed) continue;
        n.vx += (W / 2 - n.x) * 0.0008;
        n.vy += (H / 2 - n.y) * 0.0008;
      }
      // Integrate + damp + clamp to viewport.
      for (const n of nodes) {
        if (n.fixed) { n.vx = n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(NODE_R + 4, Math.min(W - NODE_R - 4, n.x));
        n.y = Math.max(NODE_R + 4, Math.min(H - NODE_R - 4, n.y));
      }
      paint();
      simHandle = requestAnimationFrame(tick);
    }
    tick();
  }

  function paint() {
    const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
    // Defs once.
    const parts = [];
    // Edges (drawn first so nodes sit on top)
    for (const e of edges) {
      const a = nodes[idx[e.a]], b = nodes[idx[e.b]];
      if (!a || !b) continue;
      const color = e.jacc >= 0.6 ? "#A32D2D" : e.jacc >= 0.3 ? "#BA7517" : "#1D9E75";
      const w = Math.max(0.6, e.jacc * 6);
      parts.push(`<line class="edge" data-pair="${e.a}|${e.b}"
                    x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
                    stroke="${color}" stroke-width="${w}" stroke-opacity="${0.35 + e.jacc * 0.5}"/>`);
    }
    // Nodes
    for (const n of nodes) {
      parts.push(`<g class="node" data-id="${n.id}" transform="translate(${n.x},${n.y})">
        ${renderIconSvg(n.atk, NODE_R)}
      </g>`);
      parts.push(`<text class="node-label" x="${n.x}" y="${n.y + NODE_R + 12}" text-anchor="middle">${shortLabel(n.atk.label)}</text>`);
    }
    svg.innerHTML = parts.join("");
    wireInteractions();
  }

  function shortLabel(label) {
    if (label.length <= 18) return label;
    return label.slice(0, 16) + "…";
  }

  function wireInteractions() {
    // Drag nodes.
    for (const g of svg.querySelectorAll(".node")) {
      const id = g.dataset.id;
      const node = nodes.find((n) => n.id === id);
      g.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        g.setPointerCapture(e.pointerId);
        g.classList.add("dragging");
        node.fixed = true;
        const move = (ev) => {
          const pt = svgPoint(ev);
          node.x = pt.x; node.y = pt.y;
        };
        const up = () => {
          g.classList.remove("dragging");
          node.fixed = false;
          g.removeEventListener("pointermove", move);
          g.removeEventListener("pointerup", up);
        };
        g.addEventListener("pointermove", move);
        g.addEventListener("pointerup", up);
      });
    }
    // Hover + click on edges.
    for (const line of svg.querySelectorAll(".edge")) {
      const [a, b] = line.dataset.pair.split("|");
      line.addEventListener("mouseenter", (e) => {
        for (const l of svg.querySelectorAll(".edge")) l.classList.add("faded");
        line.classList.remove("faded"); line.classList.add("hover");
        showHover(a, b, e.clientX, e.clientY);
      });
      line.addEventListener("mouseleave", () => {
        for (const l of svg.querySelectorAll(".edge")) l.classList.remove("faded", "hover");
        hoverCard.classList.add("hidden");
      });
      line.addEventListener("click", () => showFocus(a, b));
    }
  }

  function svgPoint(ev) {
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;
    return { x, y };
  }

  function showHover(a, b, clientX, clientY) {
    const cell = matrix.cells.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    if (!cell) return;
    const aL = library.find((x) => x.id === a)?.label || a;
    const bL = library.find((x) => x.id === b)?.label || b;
    const verdict = cell.jaccard >= 0.6 ? "redundant" : cell.jaccard >= 0.3 ? "partial overlap" : "complementary";
    hoverCard.innerHTML = `<strong>${aL}</strong> ↔ <strong>${bL}</strong><br>
      Jaccard: ${cell.jaccard.toFixed(2)} · ${verdict}<br>
      +${cell.marginal_gain_pct.toFixed(0)}% gain from running both`;
    hoverCard.classList.remove("hidden");
    const rect = mount.getBoundingClientRect();
    hoverCard.style.left = (clientX - rect.left + 12) + "px";
    hoverCard.style.top = (clientY - rect.top + 12) + "px";
  }

  function showFocus(a, b) {
    const cell = matrix.cells.find((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a));
    if (!cell) return;
    const aAtk = library.find((x) => x.id === a);
    const bAtk = library.find((x) => x.id === b);
    const verdictClass = cell.jaccard >= 0.6 ? "danger" : cell.jaccard >= 0.3 ? "warning" : "success";
    const verdictText = cell.jaccard >= 0.6 ? "Redundant — drop one"
      : cell.jaccard >= 0.3 ? "Partial overlap" : "Complementary — keep both";
    focusPair.className = `card ${verdictClass}`;
    focusPair.classList.remove("hidden");
    focusPair.innerHTML = `
      <div style="font-weight:500;display:flex;align-items:center;gap:8px;margin-bottom:6px">
        ${iconChip(aAtk, 18)} ${aAtk.label}
        <span style="opacity:0.6">vs</span>
        ${iconChip(bAtk, 18)} ${bAtk.label}
      </div>
      <div class="sub" style="margin:0">${verdictText} · J = ${cell.jaccard.toFixed(2)} · marginal gain ${cell.marginal_gain_pct.toFixed(0)}%</div>
      <div class="sub" style="margin:6px 0 0;font-size:11px">
        only ${aAtk.label}: ${fmt(cell.only_a)} · both: ${fmt(cell.intersect)} · only ${bAtk.label}: ${fmt(cell.only_b)}
      </div>
    `;
  }

  await loadLibrary();
  await populateReferenceSelector();
  await reload();
  mountFinishButton(mount, { sceneId: "overlap-many", label: "Overlap · network" });
}

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}
