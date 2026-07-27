// Scene 2 — attack composer.
//
// Two rails: library on the left (wordlist+rules in info-blue, masks in
// mask-purple), pipeline on the right. Click an attack to push it onto
// the pipeline; click the × on a step to remove it. Pipeline shows live
// per-step estimates that come from POST /api/compose/estimate with
// `?simulate=1` (uses cached hashcat sim numbers when available).

import { bumpSticker } from "../util/stickers.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "compose";

const STATE_KEY = "narwal:pipeline";

export async function render(mount) {
  let pipeline = loadPipeline();

  mount.innerHTML = `
    <div class="panel">
      <h2>Composer</h2>
      <div class="sub">Click attacks to add to the pipeline. Each block shows the expected residual hit rate after preceding attacks.</div>
      <div class="grid-2" style="grid-template-columns: 240px 1fr">
        <div>
          <div style="font-weight:500;margin-bottom:4px">Attack library</div>
          <div class="sub" style="margin-bottom:8px">click to append</div>

          <div style="font-size:11px;color:var(--text-secondary);margin:8px 0 4px">Wordlist + rules</div>
          <div id="lib-words" class="card-list" style="margin-bottom:8px"></div>

          <div style="font-size:11px;color:var(--text-secondary);margin:12px 0 4px">Mask attacks</div>
          <div id="lib-masks" class="card-list" style="margin-bottom:8px"></div>
        </div>

        <div>
          <div style="font-weight:500;margin-bottom:4px">Pipeline</div>
          <div class="sub" style="margin-bottom:8px">runs top to bottom · later attacks see residual hashes</div>

          <div id="pipeline" class="card-list" style="position:relative;min-height:120px">
            <div id="empty" style="text-align:center;padding:24px;color:var(--text-tertiary);font-size:13px;border:1px dashed var(--border-2);border-radius:8px">
              + click attacks on the left to build a pipeline
            </div>
          </div>

          <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button id="simulate" class="primary">Simulate pipeline</button>
            <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-secondary)">
              <input id="real_sim" type="checkbox" style="margin:0"/> use cached hashcat sim
            </label>
            <label style="font-size:12px;color:var(--text-secondary)">reference
              <select id="reference">
                <option value="rockyou" selected>rockyou</option>
                <option value="linkedin">linkedin</option>
                <option value="zerozeroowebhost">000webhost</option>
                <option value="taobao">taobao</option>
              </select>
            </label>
            <button id="clear">Clear</button>
            <span id="budget" style="margin-left:auto;color:var(--text-secondary);font-size:12px"></span>
          </div>

          <pre id="estimate-out" style="background:var(--surface-2);padding:12px;border-radius:6px;font-size:11px;color:var(--text-secondary);margin-top:12px;max-height:280px;overflow:auto;display:none"></pre>
        </div>
      </div>
    </div>
  `;

  const libResp = await fetch("/api/compose/library");
  const lib = (await libResp.json()).attacks;
  const libById = Object.fromEntries(lib.map((a) => [a.id, a]));

  const wordsRail = mount.querySelector("#lib-words");
  const masksRail = mount.querySelector("#lib-masks");
  wordsRail.innerHTML = lib
    .filter((a) => a.type === "wordlist" || a.type === "wordlist+rules")
    .map((a) => libRowHtml(a, "info"))
    .join("");
  masksRail.innerHTML = lib
    .filter((a) => a.type === "mask")
    .map((a) => libRowHtml(a, "mask"))
    .join("");

  for (const row of mount.querySelectorAll("[data-add]")) {
    row.addEventListener("click", () => {
      pipeline.push(row.dataset.add);
      savePipeline(pipeline);
      renderPipeline();
    });
  }

  mount.querySelector("#clear").addEventListener("click", () => {
    pipeline = [];
    savePipeline(pipeline);
    renderPipeline();
  });

  mount.querySelector("#simulate").addEventListener("click", runEstimate);

  function renderPipeline() {
    const el = mount.querySelector("#pipeline");
    if (pipeline.length === 0) {
      el.innerHTML = `
        <div id="empty" style="text-align:center;padding:24px;color:var(--text-tertiary);font-size:13px;border:1px dashed var(--border-2);border-radius:8px">
          + click attacks on the left to build a pipeline
        </div>`;
      return;
    }
    el.innerHTML = pipeline.map((id, i) => {
      const a = libById[id];
      if (!a) return "";
      const cls = a.type === "mask" ? "mask" : "info";
      return `
        <div class="card ${cls}" style="display:flex;align-items:center;gap:10px">
          <div style="font-size:13px;font-weight:500;width:18px;text-align:right">${i + 1}</div>
          <div style="flex:1">
            <div style="font-weight:500">${a.label}</div>
            <div style="font-size:11px;opacity:0.8">${a.id} · ${a.type}</div>
          </div>
          <button data-rm="${i}" style="padding:4px 10px">×</button>
        </div>
      `;
    }).join("");
    for (const b of el.querySelectorAll("[data-rm]")) {
      b.addEventListener("click", (e) => {
        const idx = +e.currentTarget.dataset.rm;
        pipeline.splice(idx, 1);
        savePipeline(pipeline);
        renderPipeline();
      });
    }
  }

  async function runEstimate() {
    if (pipeline.length === 0) return;
    const out = mount.querySelector("#estimate-out");
    out.style.display = "block";
    out.textContent = "computing…";
    const sim = mount.querySelector("#real_sim").checked ? "1" : "0";
    const ref = mount.querySelector("#reference").value;
    const resp = await fetch(`/api/compose/estimate?simulate=${sim}&reference=${ref}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attack_ids: pipeline,
        target: { hash_type: "ntlm", hash_count: 100000 },
        cluster: { gpu: "rtx_5080", gpu_count: 8, hash_type: "ntlm" },
      }),
    });
    const est = await resp.json();
    mount.querySelector("#budget").textContent =
      `total ${fmtSec(est.total_seconds)} · ${est.total_expected_yield_pct.toFixed(1)}% expected yield`;
    out.textContent = JSON.stringify(est, null, 2);
    // Reward: one Polar-Unicorn for a completed Composer simulation.
    bumpSticker({
      label: `Composer · ${pipeline.length} step${pipeline.length === 1 ? "" : "s"}`,
      sceneId: "compose",
    });
  }

  renderPipeline();
  mountFinishButton(mount, { sceneId: "compose", label: "Compose" });
}

function libRowHtml(a, color) {
  const cls = color === "mask" ? "card mask" : "card info";
  return `
    <div class="${cls}" data-add="${a.id}" style="cursor:pointer;font-size:12px;padding:8px 10px">
      <div style="font-weight:500">${a.label}</div>
      <div style="font-size:10px;opacity:0.85">${a.id}</div>
    </div>
  `;
}

function loadPipeline() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || "[]"); } catch { return []; }
}
function savePipeline(p) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(p)); } catch {}
}

function fmtSec(s) {
  if (s < 1) return `${(s*1000).toFixed(0)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.round(s/60)} min`;
  if (s < 86400) return `${(s/3600).toFixed(1)} h`;
  return `${(s/86400).toFixed(1)} d`;
}
