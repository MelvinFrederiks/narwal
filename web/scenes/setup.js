import { mountFinishButton } from "../util/finish_step.js";
// Scene 1 — Setup & dataset selection.
//
// Three rails:
//   · reference datasets — click to toggle, persists via util/selection.js;
//     downstream scenes filter to whatever is selected here.
//   · target hashlist drop zone (plan-only by default).
//   · cluster spec with auto-computed hashrate.

import {
  cleanedDatasets,
  getSelected,
  setSelected,
  labelFor,
} from "../util/selection.js";

export const name = "setup";

const STATE_KEY = "narwal:setup";

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
  } catch { return {}; }
}
function saveState(s) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {}
}

export async function render(mount) {
  const state = loadState();

  mount.innerHTML = `
    <div class="panel">
      <h2>Setup</h2>
      <div class="sub">Pick reference datasets · upload target hashlist (plan-only by default) · set cluster spec.</div>
      <div class="grid-3">
        <div>
          <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px">
            <span style="font-weight:500">Reference datasets</span>
            <span class="sub" id="ref-count" style="margin:0;font-size:11px">—</span>
          </div>
          <div class="sub" style="margin-bottom:8px">click a card to toggle · selection persists across scenes</div>
          <div id="ref-list" class="card-list">
            <div class="loading">loading…</div>
          </div>
          <div style="display:flex;gap:6px;margin-top:10px">
            <button id="sel-all" style="flex:1">select all</button>
            <button id="sel-clear" style="flex:1">clear</button>
          </div>
        </div>
        <div>
          <div style="font-weight:500;margin-bottom:6px">Target hashlist</div>
          <div class="sub" style="margin-bottom:8px">drop or upload · NTLM · bcrypt · MD5</div>
          <div id="drop" style="border:1px dashed var(--border-2);border-radius:8px;padding:24px;text-align:center;color:var(--text-secondary)">
            <input type="file" id="hashfile" accept=".txt,.hash,.list" style="display:none"/>
            <div style="cursor:pointer" onclick="document.getElementById('hashfile').click()">drop hashlist here</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:6px">or click to choose</div>
          </div>
          <div style="margin-top:14px">
            <label style="font-size:12px;color:var(--text-secondary)">Hash type</label>
            <select id="hash_type" style="width:100%;margin-top:4px">
              <option value="ntlm">NTLM (mode 1000)</option>
              <option value="md5">MD5 (mode 0)</option>
              <option value="bcrypt">bcrypt (mode 3200)</option>
              <option value="sha1">SHA-1 (mode 100)</option>
              <option value="sha256">SHA-256 (mode 1400)</option>
            </select>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px">
            <button id="plan_only" class="primary" style="flex:1">Plan only</button>
            <button id="plan_run" style="flex:1">Plan + run</button>
          </div>
          <label style="font-size:12px;color:var(--text-secondary);margin-top:14px;display:block">Budget (hours)</label>
          <input type="number" id="budget_hours" min="0.5" max="720" step="0.5" value="24" style="width:100%;margin-top:4px"/>
          <button id="find_optimal" class="primary" style="margin-top:14px;width:100%;padding:10px">⚡ Find me optimal</button>
          <button id="profile" style="margin-top:8px;width:100%;padding:8px">Profile target →</button>
          <div id="optimal-result" class="hidden" style="margin-top:14px"></div>
        </div>
        <div>
          <div style="font-weight:500;margin-bottom:6px">Cluster spec</div>
          <div class="sub" style="margin-bottom:8px">estimated speed</div>
          <label style="font-size:12px;color:var(--text-secondary)">GPU model</label>
          <select id="gpu" style="width:100%;margin-top:4px">
            <option value="rtx_5080" selected>RTX 5080</option>
          </select>
          <label style="font-size:12px;color:var(--text-secondary);margin-top:14px;display:block">Count</label>
          <input type="number" id="gpu_count" min="1" max="64" value="8" style="width:100%;margin-top:4px"/>
          <div class="card success" style="margin-top:14px;text-align:center">
            <div style="font-size:18px;font-weight:500" id="ntlm_rate">— GH/s</div>
            <div style="font-size:11px">NTLM estimate</div>
          </div>
          <div class="card danger" style="margin-top:8px;text-align:center">
            <div style="font-size:16px;font-weight:500" id="bcrypt_rate">— GH/s</div>
            <div style="font-size:11px">bcrypt · cost factor 5</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Restore prior selections
  if (state.hash_type) mount.querySelector("#hash_type").value = state.hash_type;
  if (state.gpu_count) mount.querySelector("#gpu_count").value = state.gpu_count;

  // ── Dataset selection rail ────────────────────────────────────────────────
  const dsList = await cleanedDatasets();
  const allCleanedIds = dsList.map((d) => d.id);
  const refList = mount.querySelector("#ref-list");
  const refCount = mount.querySelector("#ref-count");

  let selected = new Set(await getSelected());

  function renderCards() {
    refList.innerHTML = dsList.map((d) => {
      const on = selected.has(d.id);
      const label = labelFor(d.id);
      const status = d.cleaned
        ? `${formatN(d.unique || d.size)} · cleaned`
        : `${formatN(d.size)} · raw`;
      const tickColor = on ? "var(--success-text)" : "var(--text-tertiary)";
      const tick = on ? "&#10003;" : "&#9711;";
      return `
        <div class="card ${on ? "success" : ""}" data-id="${d.id}"
             style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:13px">${label}</div>
            <div style="font-size:11px;opacity:0.85">${status}</div>
          </div>
          <span style="font-size:14px;color:${tickColor}">${tick}</span>
        </div>
      `;
    }).join("");
    refCount.textContent = `${selected.size} of ${dsList.length} selected`;

    for (const card of refList.querySelectorAll("[data-id]")) {
      card.addEventListener("click", () => {
        const id = card.dataset.id;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        persistAndRedraw();
      });
    }
  }

  function persistAndRedraw() {
    setSelected([...selected]);
    renderCards();
  }

  mount.querySelector("#sel-all").addEventListener("click", () => {
    selected = new Set(allCleanedIds);
    persistAndRedraw();
  });
  mount.querySelector("#sel-clear").addEventListener("click", () => {
    selected = new Set();
    persistAndRedraw();
  });

  renderCards();

  // ── Cluster spec rates ────────────────────────────────────────────────────
  const ratesMap = {
    ntlm: 105.0, md5: 95.0, bcrypt: 0.011, sha1: 50.0, sha256: 22.0,
  };
  function refresh() {
    const n = +mount.querySelector("#gpu_count").value || 1;
    mount.querySelector("#ntlm_rate").textContent = `~${(ratesMap.ntlm * n).toFixed(0)} GH/s`;
    mount.querySelector("#bcrypt_rate").textContent = `~${(ratesMap.bcrypt * n * 1000).toFixed(0)} MH/s`;
    saveState({
      hash_type: mount.querySelector("#hash_type").value,
      gpu_count: mount.querySelector("#gpu_count").value,
    });
  }
  for (const id of ["hash_type", "gpu_count"]) {
    mount.querySelector("#" + id).addEventListener("change", refresh);
    mount.querySelector("#" + id).addEventListener("input", refresh);
  }
  refresh();

  // ── Plan-only / Plan+run toggle (visual only — we always plan) ───────────
  const planOnly = mount.querySelector("#plan_only");
  const planRun = mount.querySelector("#plan_run");
  planRun.addEventListener("click", () => {
    planOnly.classList.remove("primary");
    planRun.classList.add("primary");
  });
  planOnly.addEventListener("click", () => {
    planRun.classList.remove("primary");
    planOnly.classList.add("primary");
  });

  // Profile target → jump to coverage scene
  mount.querySelector("#profile").addEventListener("click", () => {
    location.hash = "#coverage";
  });

  // Find me optimal → call /api/verdict and surface the top step
  const findBtn = mount.querySelector("#find_optimal");
  const resultBox = mount.querySelector("#optimal-result");
  findBtn.addEventListener("click", async () => {
    const refs = [...selected];
    if (refs.length === 0) {
      resultBox.classList.remove("hidden");
      resultBox.innerHTML = `<div class="card warning">Select at least one reference dataset first.</div>`;
      return;
    }
    findBtn.disabled = true;
    findBtn.textContent = "thinking…";
    resultBox.classList.remove("hidden");
    resultBox.innerHTML = `<div class="card info">computing best chain…</div>`;
    try {
      const body = {
        target: { hash_type: mount.querySelector("#hash_type").value, hash_count: 10000 },
        cluster: {
          gpu_count: +mount.querySelector("#gpu_count").value || 8,
          hash_type: mount.querySelector("#hash_type").value,
        },
        budget_hours: +mount.querySelector("#budget_hours").value || 24,
        candidate_refs: refs,
      };
      const r = await fetch("/api/verdict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 200)}`);
      const v = await r.json();
      const top = v.recommended_chain[0];
      if (!top) {
        resultBox.innerHTML = `<div class="card warning">No attack fits the budget. Increase budget or relax cluster constraints.</div>`;
        return;
      }
      resultBox.innerHTML = `
        <div class="card success">
          <div style="font-weight:500;margin-bottom:4px">⚡ ${top.label}</div>
          <div class="sub" style="margin:0">
            ${(top.expected_yield_pct).toFixed(1)}% expected · ${formatTime(top.estimated_seconds)} on cluster ·
            strongest ref: <strong>${v.strongest_reference}</strong>
          </div>
          <div class="sub" style="margin:6px 0 0;font-size:11px">${top.rationale}</div>
          <div style="margin-top:8px;display:flex;gap:6px">
            <a href="#verdict" style="font-size:12px">see full chain →</a>
            <span class="sub" style="margin:0;font-size:11px">${v.recommended_chain.length - 1} more steps after this one</span>
          </div>
        </div>
      `;
    } catch (err) {
      resultBox.innerHTML = `<div class="card danger">error: ${err.message}</div>`;
    } finally {
      findBtn.disabled = false;
      findBtn.textContent = "⚡ Find me optimal";
    }
  });
  mountFinishButton(mount, { sceneId: "setup", label: "Setup" });
}

function formatTime(seconds) {
  if (seconds < 1) return `${(seconds * 1000).toFixed(1)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = seconds / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

function formatN(n) {
  if (!n) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
