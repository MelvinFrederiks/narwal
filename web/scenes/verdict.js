// Scene 6 — Verdict & recommendation.
//
// Twin cards (strongest reference green / weakest reference red), then a
// numbered recommended attack chain with per-step budget allocations,
// then two CTAs: "Send to Hashtopolis" (preview JSON), "Export plan as JSON".

import { bumpSticker } from "../util/stickers.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "verdict";

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Verdict</h2>
      <div class="sub">Strongest/weakest reference, recommended chain, budget-aware. One click to ship.</div>

      <form id="ctrl" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <label>Hash type
          <select id="hash_type">
            <option value="ntlm" selected>NTLM</option>
            <option value="md5">MD5</option>
            <option value="bcrypt">bcrypt</option>
          </select>
        </label>
        <label>GPU count <input id="gpu_count" type="number" min="1" max="64" value="8" style="width:60px"/></label>
        <label>Budget (hours) <input id="budget" type="number" min="0.1" max="240" step="0.1" value="6" style="width:80px"/></label>
        <button id="recompute" class="primary">Recompute</button>
      </form>

      <div id="cards" class="grid-2" style="margin-bottom:16px">
        <div id="strongest" class="card success" style="min-height:160px;position:relative">
          <div id="strongest-ov" class="overlay"><div class="spinner"></div><div class="label">finding strongest reference…</div></div>
        </div>
        <div id="weakest" class="card danger" style="min-height:160px;position:relative">
          <div id="weakest-ov" class="overlay"><div class="spinner"></div><div class="label">finding weakest reference…</div></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div style="font-weight:500;margin-bottom:4px">Recommended attack chain for your target</div>
        <div class="sub" id="chain-sub">based on nearest cluster · loading…</div>
        <div id="chain" class="card-list" style="margin-top:10px"></div>
        <div class="sub" id="totals" style="margin-top:10px"></div>
        <div id="notes" style="margin-top:10px;color:var(--text-secondary);font-size:12px"></div>
      </div>

      <div class="grid-2">
        <button id="send-ht" class="primary" style="padding:14px">Send plan to Hashtopolis</button>
        <button id="export-json" style="padding:14px">Export plan as JSON</button>
      </div>

      <pre id="payload" style="display:none;margin-top:14px;background:var(--surface-2);padding:12px;border-radius:6px;font-size:11px;max-height:340px;overflow:auto"></pre>
    </div>
  `;

  const form = mount.querySelector("#ctrl");

  let lastVerdict = null;

  async function recompute() {
    mount.querySelector("#strongest-ov").classList.remove("hidden");
    mount.querySelector("#weakest-ov").classList.remove("hidden");
    mount.querySelector("#chain").innerHTML = "";
    mount.querySelector("#totals").textContent = "";
    mount.querySelector("#notes").textContent = "";
    mount.querySelector("#chain-sub").textContent = "computing…";

    const body = {
      target: { hash_type: form.hash_type.value, hash_count: 100000 },
      cluster: { gpu: "rtx_5080", gpu_count: +form.gpu_count.value, hash_type: form.hash_type.value },
      budget_hours: +form.budget.value,
    };
    const r = await fetch("/api/verdict", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      mount.querySelector("#chain-sub").textContent = `error: HTTP ${r.status}`;
      return;
    }
    lastVerdict = await r.json();
    renderVerdict(lastVerdict);
    // Reward: one Polar-Unicorn per graded verdict.
    bumpSticker({
      label: `Verdict · ${lastVerdict.recommended_chain.length} step${lastVerdict.recommended_chain.length === 1 ? "" : "s"}`,
      sceneId: "verdict",
    });
  }

  function renderVerdict(v) {
    mount.querySelector("#strongest").innerHTML = `
      <div style="font-size:11px;opacity:0.85">strongest reference dataset</div>
      <div style="font-size:18px;font-weight:500;margin:6px 0">${v.strongest_reference}</div>
      <div style="font-size:11px">target distribution is closest to this corpus</div>
      <div style="font-size:11px;opacity:0.85;margin-top:6px">Use this corpus's mask shape + wordlist+rules first.</div>
    `;
    mount.querySelector("#weakest").innerHTML = `
      <div style="font-size:11px;opacity:0.85">weakest reference dataset</div>
      <div style="font-size:18px;font-weight:500;margin:6px 0">${v.weakest_reference}</div>
      <div style="font-size:11px">target distribution is furthest from this corpus</div>
      <div style="font-size:11px;opacity:0.85;margin-top:6px">Skip attacks tuned to this corpus.</div>
    `;
    mount.querySelector("#chain-sub").textContent =
      `${v.recommended_chain.length} attack(s) · projected ${v.total_expected_yield_pct.toFixed(1)}% in ${fmtSec(v.total_seconds)}`;
    mount.querySelector("#chain").innerHTML = v.recommended_chain.map((s, i) => `
      <div class="card info">
        <div style="font-weight:500">${i + 1} · ${s.label}</div>
        <div style="font-size:11px;opacity:0.85">budget ${fmtSec(s.estimated_seconds)} · expected residual ${s.expected_yield_pct.toFixed(1)}%</div>
        <div style="font-size:11px;opacity:0.7;margin-top:4px">${s.rationale}</div>
      </div>
    `).join("");
    mount.querySelector("#totals").textContent =
      `projected total · ${v.total_expected_yield_pct.toFixed(1)}% cracked in ${fmtSec(v.total_seconds)}`;
    mount.querySelector("#notes").innerHTML = v.notes.map((n) => `<div>· ${n}</div>`).join("");
  }

  async function exportPayload() {
    if (!lastVerdict) return;
    const body = {
      name: "narwal-plan",
      pipeline: lastVerdict.recommended_chain.map((s) => ({
        attack_id: s.attack_id,
        label: s.label,
        estimated_keyspace: 1, // approximate; real value would come from /compose/estimate
        estimated_seconds: s.estimated_seconds,
        expected_yield_pct: s.expected_yield_pct,
      })),
      target: { hash_type: form.hash_type.value, hash_count: 100000 },
      cluster: { gpu: "rtx_5080", gpu_count: +form.gpu_count.value, hash_type: form.hash_type.value },
    };
    const r = await fetch("/api/bridge/export", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    const out = mount.querySelector("#payload");
    out.style.display = "block";
    out.textContent = JSON.stringify(j, null, 2);
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(JSON.stringify(j.payload, null, 2));
        out.textContent = "// copied payload to clipboard\n\n" + out.textContent;
      } catch {}
    }
  }

  mount.querySelector("#recompute").addEventListener("click", (e) => { e.preventDefault(); recompute(); });
  mount.querySelector("#send-ht").addEventListener("click", exportPayload);
  mount.querySelector("#export-json").addEventListener("click", exportPayload);

  await recompute();
  mountFinishButton(mount, { sceneId: "verdict", label: "Verdict" });
}

function fmtSec(s) {
  if (s < 1) return `${(s*1000).toFixed(0)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.round(s/60)} min`;
  if (s < 86400) return `${(s/3600).toFixed(1)} h`;
  return `${(s/86400).toFixed(1)} d`;
}
