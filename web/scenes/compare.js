// Compare scene — overlays cumulative_pct vs mask rank for every cleaned
// dataset on the same axes. Reveals MAYA's cross-cultural finding visually:
// digit-heavy corpora (Taobao) rise differently from letter-heavy ones
// (RockYou) and policy-enforced ones (000webhost / LinkedIn).
//
// X = mask rank 1..N (not the mask string — they differ per dataset).
// Y left = cumulative_pct, locked 0-100.
// Y right = cumulative_crack_time_seconds, locked decade range (log).

import { getSelected, subscribe } from "../util/selection.js";

import { mountFinishButton } from "../util/finish_step.js";
export const name = "compare";

const PALETTE = {
  rockyou:          "#534AB7",
  linkedin:         "#185FA5",
  mailru:           "#A32D2D",
  zerozeroowebhost: "#D85A30",
  taobao:           "#7A1F1F",
  gmail:            "#0F6E56",
  ashleymadison:    "#5F5E5A",
  libero:           "#1D9E75",
};
const LABEL = {
  zerozeroowebhost: "000webhost",
};

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Compare</h2>
      <div class="sub">
        All datasets on one set of locked axes. Same x-range (mask rank), same
        y-ranges. Reveals how distribution shape varies across corpora — what
        MAYA §4.2 calls "cross-cultural password-distribution differences".
        Toggle the right-axis crack-time line with the checkbox.
      </div>

      <form id="ctrl" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
        <label>Top N
          <input id="top_n" type="number" min="5" max="60" value="30" style="width:60px"/>
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
        <label style="display:flex;align-items:center;gap:6px">
          <input id="show_time" type="checkbox"/> show crack-time overlay
        </label>
      </form>

      <div id="select-warning" class="card warning hidden" style="margin-bottom:10px">
        Fewer than 2 datasets selected in Setup — Compare needs at least 2.
        <a href="#setup">Go to Setup</a>.
      </div>
      <div id="meta"></div>
      <div class="chart-wrap" style="height:520px">
        <div id="overlay" class="overlay">
          <div class="spinner"></div>
          <div class="label" id="overlay-label">loading datasets…</div>
        </div>
        <canvas id="chart"></canvas>
      </div>
    </div>
  `;

  const form = mount.querySelector("#ctrl");
  const overlay = mount.querySelector("#overlay");
  const overlayLabel = mount.querySelector("#overlay-label");
  const meta = mount.querySelector("#meta");
  let chart = null;

  const warning = mount.querySelector("#select-warning");

  async function reload() {
    overlay.classList.remove("hidden");
    overlayLabel.textContent = "discovering datasets…";

    const dsList = await getSelected();
    warning.classList.toggle("hidden", dsList.length >= 2);
    if (dsList.length === 0) {
      meta.classList.add("error");
      meta.textContent = "no datasets selected — pick some in Setup";
      overlay.classList.add("hidden");
      return;
    }

    overlayLabel.textContent = `loading ${dsList.length} datasets in parallel…`;
    const params = {
      hash_type: form.hash_type.value,
      gpu_count: form.gpu_count.value,
      max_length: 12,
      top_n: form.top_n.value,
    };
    const responses = await Promise.all(
      dsList.map(async (ds) => {
        const u = new URLSearchParams({ dataset: ds, ...params });
        const r = await fetch(`/api/coverage?${u}`);
        if (!r.ok) return null;
        return await r.json();
      })
    );
    const datasets = responses.filter(Boolean);

    chart = renderChart(mount.querySelector("#chart"), chart, datasets, form.show_time.checked);
    meta.classList.remove("error");
    meta.innerHTML = renderMeta(datasets);
    overlay.classList.add("hidden");
  }

  for (const el of form.querySelectorAll("input, select")) {
    el.addEventListener("change", reload);
  }
  subscribe(reload);
  await reload();
  mountFinishButton(mount, { sceneId: "compare", label: "Compare" });
}

function renderMeta(datasets) {
  return `
    <table class="kv">
      <tr><td>Datasets</td><td>${datasets.length}</td></tr>
      <tr><td>X axis</td><td>mask rank (1..${datasets[0]?.masks.length || 0})</td></tr>
      <tr><td>Left Y</td><td>cumulative % cracked, locked 0–100</td></tr>
      <tr><td>Right Y</td><td>cumulative crack time, locked 0.1 ms – 317 y (log)</td></tr>
    </table>
  `;
}

function renderChart(canvas, prev, datasets, showTime) {
  if (prev) prev.destroy();

  const N = Math.max(...datasets.map((d) => d.masks.length));
  const labels = Array.from({ length: N }, (_, i) => `#${i + 1}`);

  const series = datasets.map((d) => {
    const color = PALETTE[d.dataset] || "#888";
    return {
      type: "line",
      label: LABEL[d.dataset] || d.dataset,
      data: d.masks.map((m) => round1(m.cumulative_pct)),
      borderColor: color,
      backgroundColor: color + "33",
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      yAxisID: "yPct",
      fill: false,
      tension: 0.15,
    };
  });

  if (showTime) {
    for (const d of datasets) {
      const color = PALETTE[d.dataset] || "#888";
      series.push({
        type: "line",
        label: `${LABEL[d.dataset] || d.dataset} time`,
        data: d.masks.map((m) => m.cumulative_crack_time_seconds),
        borderColor: color,
        borderWidth: 1.2,
        borderDash: [5, 4],
        pointRadius: 0,
        fill: false,
        yAxisID: "yTime",
        hidden: false,
      });
    }
  }

  return new Chart(canvas, {
    data: { labels, datasets: series },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#c9d1d9", boxWidth: 14, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.yAxisID === "yPct") return `${ctx.dataset.label}: ${round1(ctx.parsed.y)}%`;
              return `${ctx.dataset.label}: ${formatTime(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "mask rank", color: "#c9d1d9" },
          ticks: { color: "#c9d1d9", autoSkip: true, maxRotation: 0 },
          grid: { color: "#21262d" },
        },
        yPct: {
          position: "left",
          title: { display: true, text: "cumulative % cracked", color: "#c9d1d9" },
          ticks: { color: "#c9d1d9", callback: (v) => `${round1(v)}%` },
          grid: { color: "#21262d" },
          min: 0, max: 100,
        },
        yTime: {
          position: "right",
          display: showTime,
          title: { display: true, text: "cumulative crack time (log)", color: "#BA7517" },
          ticks: { color: "#BA7517", callback: (v) => formatTime(v) },
          grid: { drawOnChartArea: false },
          type: "logarithmic",
          min: 0.0001, max: 1e10,
        },
      },
    },
  });
}

function round1(x) { return Math.round(x * 10) / 10; }

function formatTime(s) {
  if (s < 1) return `${(s * 1000).toFixed(1)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} h`;
  const d = h / 24;
  if (d < 365) return `${d.toFixed(1)} d`;
  return `${(d / 365).toFixed(1)} y`;
}
