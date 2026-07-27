// Scene 3 — cumulative-mask coverage chart.
//
// Operationalises Van Heijningen 2013 Appendix O.2: stacked bars of
// cumulative-percentage cracked on the left axis, cracking-time dashed
// line on the right axis, vertical "budget kink" annotation where the
// time curve goes near-vertical.

import { getSelected, labelFor, subscribe } from "../util/selection.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "coverage";

const AMBER = "#BA7517";
const ACCENT = "#534AB7";   // primary dataset (purple — storyboard)
const ACCENT_2 = "#D85A30"; // secondary dataset for compare mode

// Chart.js can't resolve CSS custom properties — it treats "var(--x)" as a
// literal colour string and silently falls back to its default #666, which
// reads near-black on the dark-mode surface. Resolve to real hex/rgb here
// so axis labels/ticks pick up the current theme.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Coverage</h2>
      <div class="sub">
        Cumulative mask coverage per Van Heijningen 2013 fig. O.2. The dashed amber line
        shows wall-clock to exhaust each mask on the configured cluster. The vertical line
        marks the <strong>budget kink</strong> — adding masks past it is not worth it.
      </div>

      <div id="select-warning" class="card warning hidden" style="margin-bottom:10px">
        No datasets selected in Setup. <a href="#setup">Go to Setup</a> to pick at least one.
      </div>
      <form id="ctrl" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
        <label>Dataset
          <select id="dataset"></select>
        </label>
        <label>Compare with
          <select id="dataset2">
            <option value="" selected>(none)</option>
          </select>
        </label>
        <label>Hash type
          <select id="hash_type">
            <option value="ntlm" selected>NTLM</option>
            <option value="md5">MD5</option>
            <option value="bcrypt">bcrypt</option>
            <option value="sha1">SHA-1</option>
            <option value="sha256">SHA-256</option>
          </select>
        </label>
        <label>GPU count
          <input id="gpu_count" type="number" min="1" max="64" value="8" style="width:60px"/>
        </label>
        <label>Max length
          <input id="max_length" type="number" min="4" max="32" value="12" style="width:60px"/>
        </label>
        <label>Top N
          <input id="top_n" type="number" min="5" max="200" value="30" style="width:60px"/>
        </label>
      </form>

      <div id="meta"></div>
      <div class="chart-wrap">
        <div id="overlay" class="overlay">
          <div class="skeleton-bars">
            <i style="height:30%"></i><i style="height:55%"></i><i style="height:42%"></i>
            <i style="height:70%"></i><i style="height:60%"></i><i style="height:85%"></i>
            <i style="height:75%"></i><i style="height:92%"></i><i style="height:80%"></i>
            <i style="height:95%"></i>
          </div>
          <div class="spinner"></div>
          <div class="label" id="overlay-label">computing mask histogram…</div>
        </div>
        <canvas id="chart"></canvas>
      </div>
    </div>
  `;

  const form = mount.querySelector("#ctrl");
  const overlay = mount.querySelector("#overlay");
  const overlayLabel = mount.querySelector("#overlay-label");
  const meta = mount.querySelector("#meta");
  const warning = mount.querySelector("#select-warning");
  let chart = null;

  // Populate dataset dropdowns from the Setup selection.
  async function populateDatasetSelectors() {
    const sel = await getSelected();
    const ds1 = form.dataset, ds2 = form.dataset2;
    const prev1 = ds1.value;
    const prev2 = ds2.value;
    ds1.innerHTML = sel.length === 0
      ? `<option value="">(none — pick in Setup)</option>`
      : sel.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join("");
    ds2.innerHTML = `<option value="">(none)</option>` +
      sel.map((id) => `<option value="${id}">${labelFor(id)}</option>`).join("");
    if (prev1 && sel.includes(prev1)) ds1.value = prev1;
    if (prev2 && (sel.includes(prev2) || prev2 === "")) ds2.value = prev2;
    warning.classList.toggle("hidden", sel.length > 0);
  }
  subscribe(populateDatasetSelectors);

  function showOverlay(text) {
    overlayLabel.textContent = text;
    overlay.classList.remove("hidden");
  }
  function hideOverlay() {
    overlay.classList.add("hidden");
  }

  async function fetchCoverage(ds) {
    const params = new URLSearchParams({
      dataset: ds,
      hash_type: form.hash_type.value,
      gpu_count: form.gpu_count.value,
      max_length: form.max_length.value,
      top_n: form.top_n.value,
    });
    const resp = await fetch(`/api/coverage?${params}`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} — ${(await resp.text()).slice(0, 200)}`);
    }
    return await resp.json();
  }

  async function reload() {
    const ds1 = form.dataset.value;
    const ds2 = form.dataset2.value;
    if (!ds1) {
      meta.innerHTML = "";
      hideOverlay();
      return;
    }
    showOverlay(ds2 ? `loading ${ds1} + ${ds2}…` : `loading ${ds1}…`);

    let primary, secondary = null;
    try {
      primary = await fetchCoverage(ds1);
      if (ds2 && ds2 !== ds1) secondary = await fetchCoverage(ds2);
    } catch (err) {
      meta.classList.add("error");
      meta.textContent = err.message;
      showOverlay(`error: ${err.message}`);
      return;
    }
    meta.classList.remove("error");
    meta.innerHTML = renderMeta(primary, secondary);
    chart = renderChart(mount.querySelector("#chart"), chart, primary, secondary);
    hideOverlay();
  }

  for (const el of form.querySelectorAll("input, select")) {
    el.addEventListener("change", reload);
  }
  await populateDatasetSelectors();
  await reload();
  mountFinishButton(mount, { sceneId: "coverage", label: "Coverage" });
}

function renderMeta(p, sec) {
  const total = formatTime(p.masks.length ? p.masks[p.masks.length - 1].cumulative_crack_time_seconds : 0);
  const cum = p.masks.length ? p.masks[p.masks.length - 1].cumulative_pct.toFixed(1) : "0.0";
  const kinkInfo = p.budget_kink_index != null
    ? `mask #${p.budget_kink_index + 1} (${p.masks[p.budget_kink_index].mask})`
    : "(none detected)";
  let extra = "";
  if (sec) {
    const cum2 = sec.masks[sec.masks.length - 1].cumulative_pct.toFixed(1);
    extra = `<tr><td>Compare</td><td>${sec.dataset} reaches ${cum2}% cumulative (vs ${cum}% for ${p.dataset})</td></tr>`;
  }
  return `
    <table class="kv">
      <tr><td>Dataset</td><td>${p.dataset} (${p.dataset_size.toLocaleString()} unique)</td></tr>
      <tr><td>Hash type</td><td>${p.hash_type}</td></tr>
      <tr><td>Cluster</td><td>${p.cluster_hashrate_ghs.toFixed(1)} GH/s</td></tr>
      <tr><td>Total cumulative coverage</td><td>${cum}%</td></tr>
      <tr><td>Total exhaust time</td><td>${total}</td></tr>
      <tr><td>Budget kink</td><td>${kinkInfo}</td></tr>
      ${extra}
    </table>
  `;
}

function renderChart(canvas, prev, p, sec) {
  if (prev) prev.destroy();

  const labels = p.masks.map((m) => m.mask);
  const cumPct = p.masks.map((m) => round1(m.cumulative_pct));
  const cumTime = p.masks.map((m) => m.cumulative_crack_time_seconds);

  const annotations = {};
  if (p.budget_kink_index != null) {
    annotations.kink = {
      type: "line",
      xMin: p.budget_kink_index,
      xMax: p.budget_kink_index,
      borderColor: AMBER,
      borderWidth: 2,
      borderDash: [4, 4],
      label: {
        display: true,
        content: "budget kink",
        position: "start",
        color: AMBER,
        backgroundColor: "rgba(186,117,23,0.12)",
        font: { size: 11 },
      },
    };
  }

  const datasets = [
    {
      type: "bar",
      label: `${p.dataset} cum %`,
      data: cumPct,
      backgroundColor: hexA(ACCENT, 0.55),
      borderColor: ACCENT,
      borderWidth: 1,
      yAxisID: "yPct",
      order: 2,
    },
  ];
  if (sec) {
    // Map secondary masks to primary's x-axis by aligning rank position
    // (the masks themselves differ between datasets — comparing by rank).
    const cum2 = labels.map((_, i) => sec.masks[i] ? round1(sec.masks[i].cumulative_pct) : null);
    datasets.push({
      type: "bar",
      label: `${sec.dataset} cum %`,
      data: cum2,
      backgroundColor: hexA(ACCENT_2, 0.45),
      borderColor: ACCENT_2,
      borderWidth: 1,
      yAxisID: "yPct",
      order: 2,
    });
  }
  datasets.push({
    type: "line",
    label: "cumulative crack time",
    data: cumTime,
    borderColor: AMBER,
    borderWidth: 2,
    borderDash: [6, 4],
    pointRadius: 0,
    fill: false,
    tension: 0,
    yAxisID: "yTime",
    order: 1,
  });

  return new Chart(canvas, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: cssVar("--text-secondary") } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.yAxisID === "yPct") {
                return `cum: ${round1(ctx.parsed.y)}%`;
              }
              return `time: ${formatTime(ctx.parsed.y)}`;
            },
          },
        },
        annotation: { annotations },
      },
      scales: {
        x: {
          ticks: {
            color: cssVar("--text-secondary"),
            maxRotation: 60,
            minRotation: 60,
            autoSkip: false,
          },
          grid: { color: cssVar("--surface-3") },
        },
        yPct: {
          position: "left",
          title: { display: true, text: "cumulative % cracked", color: cssVar("--text-secondary") },
          ticks: { color: cssVar("--text-secondary"), callback: (v) => `${round1(v)}%` },
          grid: { color: cssVar("--surface-3") },
          // Fixed range so switching datasets keeps the curve comparable
          min: 0,
          max: 100,
        },
        yTime: {
          position: "right",
          title: { display: true, text: "cumulative crack time", color: AMBER },
          ticks: { color: AMBER, callback: (v) => formatTime(v) },
          grid: { drawOnChartArea: false },
          type: "logarithmic",
          // Fixed decade range: 0.1 ms .. ~317 years. Covers every realistic
          // mask we'd render. Locked so the slope tells a consistent story.
          min: 0.0001,
          max: 1e10,
        },
      },
    },
  });
}

function round1(x) { return Math.round(x * 10) / 10; }

function hexA(hex, alpha) {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `#${m[1]}${a}`;
}

function formatTime(seconds) {
  if (seconds < 1) return `${(seconds * 1000).toFixed(1)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  const days = hours / 24;
  if (days < 365) return `${days.toFixed(1)} d`;
  return `${(days / 365).toFixed(1)} y`;
}
