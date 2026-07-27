// Scene 3a — Model mergeability (MAYA RQ6.1).
//
// Symmetric model×model matrix of the mergeability index: for two guessers'
// cracked-password sets A and B, (|A∪B| − max(|A|,|B|)) / max(|A|,|B|) — the
// fractional coverage GAIN from merging the weaker model into the stronger.
// 0 ⇒ redundant (subset); higher ⇒ complementary, so an ensemble helps.
//
// Narwal reads the FLA row: FLA is our only in-scope DL guesser, so this says
// which other model would add the most on top of it. Data is MAYA's published
// rq6.1 result (all-12-100-80, 500M samples) via /api/maya/mergeability.

import { mountFinishButton } from "../util/finish_step.js";

export const name = "mergeability";

// Blue low→high scale (mirrors the Heatmap scene). Buckets are on percent
// coverage-gain with low-end resolution — fixed (dataset-independent) so the
// colour of a cell means the same thing across datasets.
const SCALE = ["#FFFFFF", "#E6F1FB", "#B5D4F4", "#85B7EB", "#185FA5", "#042C53"];

const MODEL_LABEL = {
  fla: "FLA", omen: "OMEN", pcfg: "PCFG", passgan: "PassGAN",
  passflow: "PassFlow", passgpt: "PassGPT", plrgan: "PLR-GAN", vgpt2: "VGPT2",
};

const labelFor = (id) => MODEL_LABEL[id] || id;

// Percent coverage-gain → colour bucket. Thresholds tuned to where the data
// actually lives (most pairs sit under 10%), so the low end stays legible.
function bucket(pct) {
  if (pct < 0.5) return 0;
  if (pct < 2) return 1;
  if (pct < 5) return 2;
  if (pct < 10) return 3;
  if (pct < 20) return 4;
  return 5;
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Mergeability</h2>
      <div class="sub">
        MAYA RQ6.1 · how <em>complementary</em> two guessers are.
        Index = fractional coverage gained by merging the weaker model into the
        stronger — <strong>0</strong> means redundant, higher means an ensemble helps.
        Narwal reads the <strong>FLA</strong> row: what each model adds on top of FLA.
      </div>

      <div id="picker" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"></div>

      <div id="grid-wrap" style="position:relative;min-height:280px;overflow:auto">
        <div id="overlay" class="overlay"><div class="spinner"></div><div class="label">loading mergeability…</div></div>
        <div id="grid"></div>
      </div>

      <div class="note" id="caption">—</div>
      <div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-secondary)">
        <span>redundant</span>
        ${SCALE.map((c) => `<span style="display:inline-block;width:14px;height:14px;background:${c};border:0.5px solid var(--border-2)"></span>`).join("")}
        <span>complementary</span>
        <span style="margin-left:6px;opacity:0.7">(0 · 2 · 5 · 10 · 20%+ coverage gain)</span>
      </div>
    </div>
  `;

  const overlay = mount.querySelector("#overlay");
  const picker = mount.querySelector("#picker");
  let datasets = [];
  let current = null;

  async function init() {
    // One call with no filter gives us the dataset list + all pairs.
    const r = await fetch("/api/maya/mergeability");
    if (!r.ok) { fail(`error: HTTP ${r.status}`); return; }
    const data = await r.json();
    if (!data.available) {
      fail("MAYA results not present on this host (third_party/maya is gitignored).");
      picker.innerHTML = "";
      return;
    }
    datasets = data.datasets;
    current = datasets.includes("rockyou") ? "rockyou" : datasets[0];
    picker.innerHTML = datasets.map((d) =>
      `<button data-ds="${d}" class="${d === current ? "primary" : ""}">${d}</button>`
    ).join("");
    for (const b of picker.querySelectorAll("[data-ds]")) {
      b.addEventListener("click", () => load(b.dataset.ds));
    }
    await load(current);
  }

  function fail(msg) {
    overlay.classList.remove("hidden");
    overlay.querySelector(".spinner")?.classList.add("hidden");
    overlay.querySelector(".label").textContent = msg;
  }

  async function load(ds) {
    overlay.classList.remove("hidden");
    overlay.querySelector(".spinner")?.classList.remove("hidden");
    overlay.querySelector(".label").textContent = `loading ${ds}…`;
    for (const b of picker.querySelectorAll("[data-ds]")) {
      b.classList.toggle("primary", b.dataset.ds === ds);
    }
    const r = await fetch(`/api/maya/mergeability?training_dataset=${encodeURIComponent(ds)}`);
    if (!r.ok) { fail(`error: HTTP ${r.status}`); return; }
    const data = await r.json();
    overlay.classList.add("hidden");
    current = ds;
    renderMatrix(ds, data);
  }

  function renderMatrix(ds, data) {
    // Models present, FLA first (our lens), then the rest alphabetically.
    const models = [...data.models].sort((a, b) =>
      (a === "fla" ? -1 : b === "fla" ? 1 : a.localeCompare(b)));

    // Symmetric lookup keyed by unordered pair.
    const idx = new Map();
    let best = null;
    for (const p of data.pairs) {
      const key = [p.model_a, p.model_b].sort().join("|");
      const pct = p.mergeability_index * 100;
      idx.set(key, pct);
      if (best === null || pct > best.pct) best = { a: p.model_a, b: p.model_b, pct };
    }
    const at = (a, b) => (a === b ? null : idx.get([a, b].sort().join("|")) ?? null);

    const n = models.length;
    const cell = 54, leftPad = 74, topPad = 30, pad = 10;
    const W = leftPad + cell * n + pad;
    const H = topPad + cell * n + pad;
    const isFla = (m) => m === "fla";

    const parts = [`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="model mergeability matrix" xmlns="http://www.w3.org/2000/svg">`];

    // Column headers.
    for (let c = 0; c < n; c++) {
      const x = leftPad + c * cell + cell / 2;
      parts.push(`<text x="${x}" y="${topPad - 10}" text-anchor="middle" font-size="11" font-weight="${isFla(models[c]) ? 700 : 400}" fill="var(--text-secondary)">${labelFor(models[c])}</text>`);
    }
    // Row headers + cells.
    for (let rIdx = 0; rIdx < n; rIdx++) {
      const y = topPad + rIdx * cell;
      parts.push(`<text x="${leftPad - 10}" y="${y + cell / 2 + 4}" text-anchor="end" font-size="11" font-weight="${isFla(models[rIdx]) ? 700 : 400}" fill="var(--text-secondary)">${labelFor(models[rIdx])}</text>`);
      for (let c = 0; c < n; c++) {
        const x = leftPad + c * cell;
        const v = at(models[rIdx], models[c]);
        if (v === null) {
          // Diagonal or missing pair — muted, no value.
          const diag = models[rIdx] === models[c];
          parts.push(`<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="var(--surface-2)" stroke="var(--surface)" stroke-width="0.5"/>`);
          if (diag) parts.push(`<text x="${x + cell / 2}" y="${y + cell / 2 + 3}" text-anchor="middle" font-size="10" fill="var(--border-2)" pointer-events="none">·</text>`);
          continue;
        }
        const b = bucket(v);
        parts.push(`<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="${SCALE[b]}" stroke="var(--surface)" stroke-width="0.5"><title>${labelFor(models[rIdx])} + ${labelFor(models[c])} · +${v.toFixed(1)}% coverage</title></rect>`);
        const textColor = b >= 4 ? "#fff" : "#2C2C2A";
        parts.push(`<text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" font-size="11" fill="${textColor}" pointer-events="none">${v.toFixed(1)}</text>`);
      }
    }
    // Emphasise the FLA row+column with an outline.
    const flaPos = models.indexOf("fla");
    if (flaPos >= 0) {
      const rx = leftPad + flaPos * cell, ry = topPad + flaPos * cell;
      const stroke = `stroke="var(--accent, #E4572E)" stroke-width="2" fill="none"`;
      parts.push(`<rect x="${leftPad}" y="${ry}" width="${cell * n - 1}" height="${cell - 1}" ${stroke}/>`);
      parts.push(`<rect x="${rx}" y="${topPad}" width="${cell - 1}" height="${cell * n - 1}" ${stroke}/>`);
    }
    parts.push("</svg>");
    mount.querySelector("#grid").innerHTML = parts.join("");

    const settings = data.pairs[0]?.test_settings || "all-12-100-80";
    const nSamp = data.pairs[0]?.n_samples ? (data.pairs[0].n_samples / 1e6) + "M" : "500M";
    const flaBest = data.pairs
      .filter((p) => p.model_a === "fla" || p.model_b === "fla")
      .sort((a, b) => b.mergeability_index - a.mergeability_index)[0];
    const flaTip = flaBest
      ? ` Best FLA partner on ${ds}: <strong>${labelFor(flaBest.model_a === "fla" ? flaBest.model_b : flaBest.model_a)}</strong> (+${(flaBest.mergeability_index * 100).toFixed(1)}%).`
      : "";
    mount.querySelector("#caption").innerHTML =
      `<strong>${ds}</strong> · MAYA ${settings} · ${nSamp} guesses.${flaTip}`;
  }

  await init();
  mountFinishButton(mount, { sceneId: "mergeability", label: "Mergeability" });
}
