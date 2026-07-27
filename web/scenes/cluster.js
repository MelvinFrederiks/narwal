// Scene 5 — Dataset similarity cluster (UMAP).
//
// Real UMAP projection of feature vectors. Three labelled regions:
// consumer leaks / corporate / high-entropy. Bubble size ∝ √cardinality.
// Projects only the datasets the user picked in Setup.

import { getSelected, labelFor, subscribe } from "../util/selection.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "cluster";

const REGION_FILL = {
  "consumer":     "#534AB7",
  "corporate":    "#1D9E75",
  "high-entropy": "#888780",
};
const POINT_STROKE = {
  "consumer":     "#3C3489",
  "corporate":    "#0F6E56",
  "high-entropy": "#444441",
};

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Cluster</h2>
      <div class="sub">
        UMAP projection of reference corpora. Distance ≈ password-distribution
        divergence; bubble ≈ √N. Three regions: <strong>consumer leaks</strong> ·
        <strong>corporate</strong> · <strong>high-entropy</strong>.
      </div>
      <div id="select-warning" class="card warning hidden" style="margin-bottom:10px">
        Fewer than 2 datasets selected in Setup — Cluster needs at least 2 to project.
        <a href="#setup">Go to Setup</a>.
      </div>
      <div class="chart-wrap" style="height:480px;position:relative">
        <div id="overlay" class="overlay"><div class="spinner"></div><div class="label">projecting datasets…</div></div>
        <svg id="cluster-svg" viewBox="0 0 800 440" width="100%" height="100%" role="img" aria-label="Dataset similarity scatter"></svg>
      </div>
      <div class="note">
        Datasets sharing a cluster respond similarly to the same attacks.
        Coverage curves (Scene 3) and overlap (Scene 4) will look most
        similar between corpora in the same region.
      </div>
    </div>
  `;

  const overlay = mount.querySelector("#overlay");
  const svg = mount.querySelector("#cluster-svg");
  const warning = mount.querySelector("#select-warning");

  async function reload() {
    overlay.classList.remove("hidden");
    const sel = await getSelected();
    warning.classList.toggle("hidden", sel.length >= 2);
    if (sel.length < 2) {
      overlay.querySelector(".label").textContent = "need ≥2 datasets — pick more in Setup";
      svg.innerHTML = "";
      return;
    }
    const url = `/api/cluster?datasets=${encodeURIComponent(sel.join(","))}`;
    const r = await fetch(url);
    if (!r.ok) {
      overlay.querySelector(".label").textContent = `error: HTTP ${r.status}`;
      return;
    }
    const data = await r.json();
    overlay.classList.add("hidden");

    if (!data.points.length) {
      svg.innerHTML = `<text x="400" y="220" text-anchor="middle" fill="var(--text-secondary)">no cleaned datasets in selection</text>`;
      return;
    }
    renderProjection(data);
  }

  subscribe(reload);
  await reload();
  mountFinishButton(mount, { sceneId: "cluster", label: "Cluster" });
}

function renderProjection(data) {
  const svg = document.querySelector("#cluster-svg");

  // Compute the viewBox by extrema with a margin.
  const xs = data.points.map((p) => p.x);
  const ys = data.points.map((p) => p.y);
  const xmin = Math.min(...xs, ...data.regions.map((r) => r.cx - r.rx));
  const xmax = Math.max(...xs, ...data.regions.map((r) => r.cx + r.rx));
  const ymin = Math.min(...ys, ...data.regions.map((r) => r.cy - r.ry));
  const ymax = Math.max(...ys, ...data.regions.map((r) => r.cy + r.ry));
  const padX = (xmax - xmin) * 0.15 || 1;
  const padY = (ymax - ymin) * 0.15 || 1;

  // Map data-coords to viewBox (0..800, 0..440)
  const PX = 800, PY = 440, MX = 60, MY = 40;
  const sx = (x) => MX + (x - xmin + padX) / (xmax - xmin + 2 * padX) * (PX - 2 * MX);
  const sy = (y) => MY + (1 - (y - ymin + padY) / (ymax - ymin + 2 * padY)) * (PY - 2 * MY);

  const sizes = data.points.map((p) => p.size || 1);
  const sMax = Math.max(...sizes);
  const radius = (s) => 10 + Math.sqrt(s / sMax) * 28;

  const parts = [];
  // Axes (faint)
  parts.push(`<line x1="${MX}" y1="${PY - MY}" x2="${PX - MX}" y2="${PY - MY}" stroke="var(--border-2)" stroke-width="0.5"/>`);
  parts.push(`<line x1="${MX}" y1="${MY}" x2="${MX}" y2="${PY - MY}" stroke="var(--border-2)" stroke-width="0.5"/>`);

  // Region halos
  for (const reg of data.regions) {
    const cx = sx(reg.cx), cy = sy(reg.cy);
    const rx = Math.abs(sx(reg.cx + reg.rx) - cx);
    const ry = Math.abs(sy(reg.cy + reg.ry) - cy);
    const fill = REGION_FILL[reg.name] || "#888780";
    parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" opacity="0.07"/>`);
    parts.push(`<text x="${cx}" y="${cy - ry - 8}" text-anchor="middle" font-size="11" fill="${fill}">${reg.name}</text>`);
  }

  // Points
  for (const p of data.points) {
    const cx = sx(p.x), cy = sy(p.y);
    const region = p.region || "high-entropy";
    const fill = REGION_FILL[region] || "#888780";
    const stroke = POINT_STROKE[region] || "#444441";
    const rr = radius(p.size || 1);
    const label = labelFor(p.id);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${fill}" opacity="0.7" stroke="${stroke}" stroke-width="0.5"><title>${label} · ${(p.size||0).toLocaleString()} unique</title></circle>`);
    const labelFill = rr > 18 ? "#fff" : "var(--text-secondary)";
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11" fill="${labelFill}" pointer-events="none">${label}</text>`);
  }

  svg.innerHTML = parts.join("");
}
