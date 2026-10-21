// Scene — Mergeability.
//
// One of the two scenes that cannot run in the browser. Every client-side
// scene compares files that already exist; this one asks what two *attacks*
// would recover from a goal wordlist, which means expanding rules and masks
// over a real keyspace. So the work is queued (POST /api/jobs), a hashcat
// worker picks it up, and the result is fetched back later — the tab can be
// closed in between.
//
// The metric is the Mergeability Index (arXiv:2504.16651): for attacks A and B
// with recovered sets S_A and S_B,
//
//     mergeability = (|S_A ∪ S_B| − max(|S_A|, |S_B|)) / max(|S_A|, |S_B|)
//
// i.e. what the weaker attack adds on top of the stronger one. It answers a
// different question from the Overlap scene's Jaccard: two attacks can look
// very similar (low Jaccard distance) and still be worth running together if
// the smaller one contributes passwords the larger one misses. Both are shown
// side by side for exactly that reason.
//
// This scene says *whether* to run a second attack. The Attack order scene
// (ordering.js) takes the attacks as given and says in which sequence — same
// queue, same hashcat work, different question.
//
// Routing: `#mergeability` is the builder, `#mergeability/<job-id>` shows one
// result — so a finished analysis is a reloadable, shareable URL.

import { listServerFiles, listRuleFiles } from "../util/serverFiles.js";
import { vennLayout } from "../util/venn.js";
import {
  MODE_LABELS, attackBuilder, attacksToSpec, emptyAttack, jobList,
  noLibraryHtml, progressText, ago, duration, esc, num, pct,
} from "../util/jobForm.js";

export const name = "mergeability";

const COLOR_A = "#534AB7"; // mask purple — matches the Overlap scene
const COLOR_B = "#185FA5"; // info blue
const R_MAX = 96;
const POLL_MS = 3000;

export async function render(mount, route = "") {
  const jobId = (route || "").trim();

  mount.innerHTML = `
    <div class="panel">
      <h2>Mergeability</h2>
      <div class="sub">
        Pick a goal wordlist, describe two or more attacks, and queue the job. A hashcat worker
        runs each attack against the goal list on its own and reports how much each one adds on
        top of the others — the mergeability index from
        <a href="https://arxiv.org/abs/2504.16651" target="_blank" rel="noreferrer">arXiv:2504.16651</a>.
        Analyses run in the background; you can close this tab and come back to the result.
      </div>
      <div id="setup"></div>
      <div id="builder"></div>
    </div>
    <div class="panel" id="jobs-panel">
      <h2>Analyses</h2>
      <div class="sub">Newest first. Results are kept until you delete them.</div>
      <div id="jobs">
        <div class="loading">loading…</div>
      </div>
    </div>
    <div id="result"></div>
  `;

  const setupBox = mount.querySelector("#setup");
  const builderBox = mount.querySelector("#builder");
  const resultBox = mount.querySelector("#result");

  // `mount` is the persistent #view element, so it can't signal unmount. This
  // sentinel can: app.js clears #view on navigation, which detaches it and
  // stops the poll loop below.
  const alive = document.createComment("mergeability-mounted");
  mount.appendChild(alive);

  let cfg = { enabled: false, rules: [], max_attacks: 8, max_rules: 4 };
  let files = [];
  let rules = [];

  try {
    [cfg, files, rules] = await Promise.all([
      fetch("/api/jobs/config").then((r) => r.json()),
      listServerFiles(".dict,.masks,.txt"),
      rules = listRuleFiles(".rule"),
    ]);
  } catch (err) {
    setupBox.innerHTML = `<div class="card danger">could not reach the job API: ${esc(err.message)}</div>`;
    return;
  }

  // Load rules into config
  cfg.rules = rules.map(f => f.path)

  const jobs = jobList({
    mount: mount.querySelector("#jobs"),
    kind: "mergeability",
    hashPrefix: "mergeability",
    selectedId: jobId,
  });

  if (!cfg.enabled) {
    setupBox.innerHTML = noLibraryHtml("A mergeability job");
  } else {
    attackBuilder({
      mount: builderBox,
      cfg, files,
      prefix: "mg",
      attacks: [
        { ...emptyAttack(), mode: "wordlist" },
        { ...emptyAttack(), mode: "mask", mask: "?u?l?l?l?d?d?d?d" },
      ],
      maxAttacks: cfg.max_attacks,
      colors: [COLOR_A, COLOR_B],
      hint: "Each attack runs separately against the goal list, then every pair is compared.",
      onSubmit: submit,
    }).render();
  }

  jobs.refresh();
  if (jobId) renderResult(jobId);
  poll();

  async function submit({ name: jobName, goal, maxRuntime, suspect, attacks }) {
    const spec = { kind: "mergeability", goal, attacks: attacksToSpec(attacks) };
    if (maxRuntime) spec.max_runtime_s = Number(maxRuntime);
    if (suspect?.length) spec.suspect_wordlists = suspect;

    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: jobName, spec }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `server said ${res.status}`);
    location.hash = `#mergeability/${data.id}`; // the hash change re-renders the scene
  }

  // ── result ───────────────────────────────────────────────────────────────
  async function renderResult(id) {
    let job;
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) throw new Error(res.status === 404 ? "no such analysis" : `server said ${res.status}`);
      job = await res.json();
    } catch (err) {
      resultBox.innerHTML = `<div class="panel"><div class="card danger">${esc(err.message)}</div></div>`;
      return;
    }

    if (job.status !== "done") {
      resultBox.innerHTML = `
        <div class="panel">
          <h2>${esc(job.name || "Analysis")}</h2>
          <div class="sub">${esc(job.spec?.goal || "")}</div>
          <div class="card ${job.status === "failed" ? "danger" : "info"}">
            <b>${esc(job.status)}</b>
            ${job.status === "running" ? ` — ${progressText(job)}` : ""}
            ${job.error ? `<pre style="white-space:pre-wrap;font-size:11px;margin:8px 0 0">${esc(job.error)}</pre>` : ""}
          </div>
        </div>`;
      return;
    }

    const r = job.result;
    // Keep whichever pair the user was looking at across the poll refresh.
    const prev = resultBox.querySelector("[data-pair].selected");
    const selected = prev ? Number(prev.dataset.pair) : 0;

    resultBox.innerHTML = `
      <div class="panel">
        <h2>${esc(job.name || "Analysis")}</h2>
        <div class="sub">
          Goal <code>${esc(r.goal)}</code> — ${num(r.goal_size)} distinct passwords.
          Ran in ${duration(r.duration_s)} on hashcat ${esc(r.hashcat_version || "?")}.
        </div>

        ${r.partial ? `<div class="card warning">${esc(r.partial_note)}</div>` : ""}
        ${r.goal_rejected ? `<div class="card warning" style="margin-top:8px">
          hashcat rejected ${num(r.goal_rejected)} line(s) of the goal file — over its 256-character
          limit, or otherwise unparseable. Coverage below is measured against the
          ${num(r.goal_size)} that did load.
        </div>` : ""}
        ${(r.suspect_wordlists?.length || r.contaminated_total) ? `<div class="card info" style="margin-top:8px">
          <b>${num(r.contaminated_total || 0)}</b> recovered password${(r.contaminated_total === 1) ? " was" : "s were"}
          set aside as dictionary contamination — goal words found verbatim in a suspect wordlist
          (${(r.suspect_wordlists || []).map((w) => `<code>${esc(w)}</code>`).join(", ") || "none"}). Rule-derived
          cracks are still counted. All indices below are on the cleaned sets.
        </div>` : ""}

        <div class="card success" style="margin-top:12px">
          All ${r.attacks.length} attacks together recover
          <b>${num(r.combined_recovered)}</b> of ${num(r.goal_size)} —
          <b>${pct(r.combined_coverage, 1)}%</b> of the goal list.
        </div>

        <div style="font-weight:500;margin:20px 0 8px">Each attack on its own</div>
        ${r.attacks.map(attackBarHtml).join("")}

        <div style="font-weight:500;margin:22px 0 6px">
          Pair comparison
          <span class="sub" style="font-weight:400;font-size:11px">
            (most complementary first — click a row for the breakdown)
          </span>
        </div>
        ${pairsTableHtml(r.pairs)}

        <div class="note">
          <b>Mergeability</b> is what the weaker attack adds on top of the stronger one:
          (|A ∪ B| − max(|A|, |B|)) ÷ max(|A|, |B|). 0% means it finds nothing the other
          missed; 100% means the two recover disjoint sets of the same size, so running both
          doubles the yield. <b>Jaccard</b> is plain similarity, shared ÷ union — a pair can
          score low on Jaccard and still be worth merging, which is the whole point of
          measuring both.
        </div>
        <div class="sub" style="margin-top:10px">
          Decided to run them all? <a href="#ordering">Attack order</a> scores every sequence of
          the same attacks by how early in the run it recovers passwords.
        </div>

        <div id="pair-detail"></div>
      </div>`;

    for (const row of resultBox.querySelectorAll("[data-pair]")) {
      row.addEventListener("click", () => selectPair(r, Number(row.dataset.pair)));
    }
    if (r.pairs.length) selectPair(r, Math.min(selected, r.pairs.length - 1));
  }

  function attackBarHtml(a) {
    const detail = a.mode === "mask"
      ? `<code>${esc(a.mask || "")}</code>`
      : [a.wordlist ? `<code>${esc(a.wordlist)}</code>` : "",
         a.rules?.length ? `+ ${a.rules.map((x) => `<code>${esc(x)}</code>`).join(" ")}` : "",
         a.mask ? `+ <code>${esc(a.mask)}</code>` : ""].filter(Boolean).join(" ");
    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:13px">
          <b>${esc(a.label)}</b>
          <span class="pill pill-mask" style="font-size:10px">${esc(MODE_LABELS[a.mode] || a.mode)}</span>
          <span class="sub" style="margin:0;font-size:11px">${detail}</span>
          ${a.partial ? `<span class="pill pill-warning" style="font-size:10px">stopped early</span>` : ""}
          <span style="margin-left:auto;font-variant-numeric:tabular-nums">
            ${num(a.recovered)} · <b>${pct(a.coverage, 1)}%</b>
          </span>
        </div>
        <div style="height:6px;background:var(--surface-3);border-radius:3px;overflow:hidden;margin-top:4px">
          <div style="height:100%;width:${(a.coverage * 100).toFixed(1)}%;background:${COLOR_A}"></div>
        </div>
      </div>`;
  }

  function pairsTableHtml(pairs) {
    const n = "text-align:right;font-variant-numeric:tabular-nums";
    return `
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px;min-width:620px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">Pair</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Only A</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Shared</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Only B</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Together</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Jaccard</th>
          <th style="padding:4px 0;font-weight:500;${n}">Mergeability</th>
        </tr></thead>
        <tbody>
          ${pairs.map((p, i) => `
            <tr data-pair="${i}" style="cursor:pointer">
              <td style="padding:5px 12px 5px 0">${esc(p.a)} <span style="color:var(--text-tertiary)">vs</span> ${esc(p.b)}</td>
              <td style="padding:5px 12px 5px 0;${n}">${num(p.only_a)}</td>
              <td style="padding:5px 12px 5px 0;${n}">${num(p.shared)}</td>
              <td style="padding:5px 12px 5px 0;${n}">${num(p.only_b)}</td>
              <td style="padding:5px 12px 5px 0;${n}">${pct(p.union_coverage, 1)}%</td>
              <td style="padding:5px 12px 5px 0;${n}">${pct(p.jaccard, 1)}%</td>
              <td style="padding:5px 0;${n}"><b>${pct(p.mergeability, 1)}%</b></td>
            </tr>`).join("")}
        </tbody>
      </table></div>`;
  }

  function selectPair(r, index) {
    const p = r.pairs[index];
    if (!p) return;
    for (const row of resultBox.querySelectorAll("[data-pair]")) {
      const on = Number(row.dataset.pair) === index;
      row.classList.toggle("selected", on);
      row.style.background = on ? "var(--surface-2)" : "";
    }

    const detail = resultBox.querySelector("#pair-detail");
    detail.innerHTML = `
      <div style="font-weight:500;margin:22px 0 4px">${esc(p.a)} vs ${esc(p.b)}</div>
      ${vennHtml(p)}
      <div class="grid-2" style="margin-top:16px">
        ${sampleHtml(`Only ${p.a} finds these`, p.sample_only_a, p.only_a, COLOR_A)}
        ${sampleHtml(`Only ${p.b} finds these`, p.sample_only_b, p.only_b, COLOR_B)}
      </div>`;
  }

  function vennHtml(p) {
    const g = vennLayout(p.recovered_a, p.recovered_b, p.shared, { rMax: R_MAX });
    if (!g) {
      return `<div class="sub">Neither attack recovered anything.</div>`;
    }
    const { rA, rB, width: w, height: h, cx1, cx2, cy, xOnlyA, xOnlyB, xShared } = g;
    const label = (x, value, sub) => `
      <text x="${x.toFixed(1)}" y="${(cy - 4).toFixed(1)}" text-anchor="middle"
            font-size="14" font-weight="600" fill="var(--text)"
            stroke="var(--surface)" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${value}</text>
      <text x="${x.toFixed(1)}" y="${(cy + 12).toFixed(1)}" text-anchor="middle"
            font-size="10" fill="var(--text-secondary)"
            stroke="var(--surface)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${sub}</text>`;
    return `
      <div style="display:flex;justify-content:center;margin:8px 0 4px">
        <svg viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="100%"
             style="max-width:${Math.min(700, w * 1.4).toFixed(0)}px;height:auto" role="img"
             aria-label="Overlap between what ${esc(p.a)} and ${esc(p.b)} recovered">
          <circle cx="${cx1.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rA.toFixed(1)}"
                  fill="${COLOR_A}" fill-opacity="0.42" stroke="${COLOR_A}" stroke-width="1.5"/>
          <circle cx="${cx2.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rB.toFixed(1)}"
                  fill="${COLOR_B}" fill-opacity="0.42" stroke="${COLOR_B}" stroke-width="1.5"/>
          ${p.only_a > 0 ? label(xOnlyA, num(p.only_a), `only ${esc(p.a)}`) : ""}
          ${p.shared > 0 ? label(xShared, num(p.shared), "both") : ""}
          ${p.only_b > 0 ? label(xOnlyB, num(p.only_b), `only ${esc(p.b)}`) : ""}
        </svg>
      </div>
      <div style="text-align:center;font-size:12px;color:var(--text-secondary)">
        areas proportional to recovered goal passwords
      </div>`;
  }

  function sampleHtml(title, words, total, color) {
    if (!total) {
      return `<div><div style="font-weight:500;font-size:13px;margin-bottom:6px">${esc(title)}</div>
        <div class="sub" style="margin:0">Nothing — everything it found, the other found too.</div></div>`;
    }
    return `
      <div>
        <div style="font-weight:500;font-size:13px;margin-bottom:6px">
          <span style="width:9px;height:9px;border-radius:2px;background:${color};display:inline-block;margin-right:5px"></span>
          ${esc(title)}
          <span class="sub" style="font-weight:400;font-size:11px;margin:0">
            (${words.length} of ${num(total)})
          </span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${(words || []).map((w) =>
            `<code style="background:var(--surface-2);border:0.5px solid var(--border);border-radius:4px;padding:2px 7px">${esc(w)}</code>`
          ).join("")}
        </div>
      </div>`;
  }

  // ── polling ──────────────────────────────────────────────────────────────
  // Stops on its own once app.js has swapped the scene out — see `alive`.
  function poll() {
    setTimeout(async () => {
      if (!alive.isConnected) return;
      await jobs.refresh();
      // A finished job never changes again, so stop re-fetching it.
      const done = resultBox.querySelector("[data-pair]");
      if (jobId && !done) await renderResult(jobId);
      poll();
    }, POLL_MS);
  }
}
