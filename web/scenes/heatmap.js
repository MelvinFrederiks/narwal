// Scene 3b — Per-position character-frequency heatmap.
//
// Van Heijningen 2013 fig. 5 / app. T. Cells colored on a 5-step blue
// scale (low→high). Buttons populated from Setup selection, plus the
// "English (Mayzner)" reference for natural-language comparison.

import { getSelected, labelFor, subscribe } from "../util/selection.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "heatmap";

const ENGLISH_REF = { id: "english_ref", label: "English (Mayzner)" };

const SCALE = ["#FFFFFF", "#E6F1FB", "#B5D4F4", "#85B7EB", "#185FA5", "#042C53"];

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Heatmap</h2>
      <div class="sub">
        Per-position character frequency. Vowels in early positions = natural-language;
        digit dominance = PIN-style (Taobao); shifted patterns = Cyrillic-keyboard remnants.
      </div>

      <div id="picker" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>

      <div id="grid-wrap" style="position:relative;min-height:280px;overflow:auto">
        <div id="overlay" class="overlay"><div class="spinner"></div><div class="label">scanning positions…</div></div>
        <div id="grid"></div>
      </div>
      <div class="note"><strong>profile:</strong> <span id="profile">—</span></div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-secondary)">
        <span>low</span>
        ${SCALE.map((c) => `<span style="display:inline-block;width:14px;height:14px;background:${c};border:0.5px solid var(--border-2)"></span>`).join("")}
        <span>high</span>
      </div>
    </div>
  `;

  const overlay = mount.querySelector("#overlay");
  const picker = mount.querySelector("#picker");
  let current = null;

  async function rebuildPicker() {
    const sel = await getSelected();
    const items = [...sel.map((id) => ({ id, label: labelFor(id) })), ENGLISH_REF];
    if (current === null || !items.some((d) => d.id === current)) {
      current = items[0]?.id;
    }
    picker.innerHTML = items.map((d) =>
      `<button data-ds="${d.id}" class="${d.id === current ? "primary" : ""}">${d.label}</button>`
    ).join("");
    for (const b of picker.querySelectorAll("[data-ds]")) {
      b.addEventListener("click", () => load(b.dataset.ds));
    }
  }
  subscribe(async () => { await rebuildPicker(); if (current) await load(current); });

  async function load(ds) {
    overlay.classList.remove("hidden");
    overlay.querySelector(".label").textContent = `scanning ${ds}…`;
    for (const b of mount.querySelectorAll("[data-ds]")) {
      b.classList.toggle("primary", b.dataset.ds === ds);
    }
    const r = await fetch(`/api/heatmap?dataset=${ds}`);
    if (!r.ok) {
      overlay.querySelector(".label").textContent = `error: HTTP ${r.status}`;
      return;
    }
    const data = await r.json();
    overlay.classList.add("hidden");
    renderGrid(data);
    current = ds;
  }

  function renderGrid(data) {
    mount.querySelector("#profile").textContent = data.profile || "—";
    const chars = [...data.alphabet];
    const maxV = Math.max(...data.frequencies.flat());
    const cellW = 36, cellH = 28, leftPad = 36, topPad = 28, rightPad = 8, bottomPad = 12;
    const W = leftPad + cellW * chars.length + rightPad;
    const H = topPad + cellH * data.positions + bottomPad;

    const parts = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="character-frequency heatmap" xmlns="http://www.w3.org/2000/svg">`];
    for (let ci = 0; ci < chars.length; ci++) {
      const x = leftPad + ci * cellW + cellW / 2;
      parts.push(`<text x="${x}" y="${topPad - 8}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">${chars[ci]}</text>`);
    }
    for (let pi = 0; pi < data.positions; pi++) {
      const y = topPad + pi * cellH + cellH / 2;
      parts.push(`<text x="${leftPad - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--text-secondary)">p${pi + 1}</text>`);
    }
    for (let pi = 0; pi < data.positions; pi++) {
      for (let ci = 0; ci < chars.length; ci++) {
        const v = data.frequencies[pi][ci];
        const t = maxV > 0 ? v / maxV : 0;
        const fill = SCALE[bucket(t)];
        const x = leftPad + ci * cellW;
        const y = topPad + pi * cellH;
        parts.push(`<rect x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${fill}" stroke="var(--surface)" stroke-width="0.5"><title>p${pi+1} · "${chars[ci]}" · ${v.toFixed(2)}%</title></rect>`);
        if (v >= maxV * 0.25 && maxV > 0) {
          const textColor = t > 0.55 ? "#fff" : "#2C2C2A";
          parts.push(`<text x="${x + cellW / 2}" y="${y + cellH / 2 + 3}" text-anchor="middle" font-size="9" fill="${textColor}" pointer-events="none">${v.toFixed(0)}</text>`);
        }
      }
    }
    parts.push("</svg>");
    mount.querySelector("#grid").innerHTML = parts.join("");
  }

  function bucket(t) {
    if (t < 0.01) return 0;
    if (t < 0.2) return 1;
    if (t < 0.4) return 2;
    if (t < 0.6) return 3;
    if (t < 0.8) return 4;
    return 5;
  }

  await rebuildPicker();
  if (current) await load(current);
  mountFinishButton(mount, { sceneId: "heatmap", label: "Heatmap" });
}
