// Scene — Mergeability.
//
// The one scene that cannot run in the browser. Every other scene compares
// files that already exist; this one asks what two *attacks* would recover
// from a goal wordlist, which means expanding rules and masks over a real
// keyspace. So the work is queued (POST /api/jobs), a hashcat worker picks it
// up, and the result is fetched back later — the tab can be closed in between.
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
// Routing: `#mergeability` is the builder, `#mergeability/<job-id>` shows one
// result — so a finished analysis is a reloadable, shareable URL.

import { listServerFiles } from "../util/serverFiles.js";
import { vennLayout } from "../util/venn.js";

export const name = "mergeability";

const COLOR_A = "#534AB7"; // mask purple — matches the Overlap scene
const COLOR_B = "#185FA5"; // info blue
const R_MAX = 96;
const POLL_MS = 3000;

const MODE_LABELS = {
  "wordlist": "Wordlist (+ rules)",
  "mask": "Mask / brute force",
  "hybrid-wm": "Hybrid — wordlist + mask",
  "hybrid-mw": "Hybrid — mask + wordlist",
};

const STATUS_PILL = {
  queued: "pill-info",
  running: "pill-warning",
  done: "pill-success",
  failed: "pill-danger",
  cancelled: "",
};

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
  const jobsBox = mount.querySelector("#jobs");
  const resultBox = mount.querySelector("#result");

  // `mount` is the persistent #view element, so it can't signal unmount. This
  // sentinel can: app.js clears #view on navigation, which detaches it and
  // stops the poll loop below.
  const alive = document.createComment("mergeability-mounted");
  mount.appendChild(alive);

  let cfg = { enabled: false, rules: [], max_attacks: 8, max_rules: 4 };
  let files = [];
  let attacks = [
    { label: "", mode: "wordlist", wordlist: "", rules: [], mask: "" },
    { label: "", mode: "mask", wordlist: "", rules: [], mask: "?u?l?l?l?d?d?d?d" },
  ];
  let goal = "";
  let jobName = "";
  let maxRuntime = "";
  let submitting = false;
  let formError = "";

  try {
    [cfg, files] = await Promise.all([
      fetch("/api/jobs/config").then((r) => r.json()),
      listServerFiles(""),
    ]);
  } catch (err) {
    setupBox.innerHTML = `<div class="card danger">could not reach the job API: ${esc(err.message)}</div>`;
    return;
  }

  if (!cfg.enabled) {
    setupBox.innerHTML = `
      <div class="card warning">
        <b>No server wordlist library is configured.</b> A mergeability job runs on the server, so
        its goal list and attack wordlists have to be files the server can already see — they can't
        be uploaded from the browser like the other scenes' inputs. Set
        <code>NARWAL_WORDLISTS_DIR</code> in <code>.env</code> and restart; see
        <code>.env.example</code>.
      </div>`;
  } else {
    renderBuilder();
  }

  renderJobs();
  if (jobId) renderResult(jobId);
  poll();

  // ── builder ──────────────────────────────────────────────────────────────
  function renderBuilder() {
    const wordlistOpts = files.map((f) => `<option value="${esc(f.path)}">`).join("");

    builderBox.innerHTML = `
      <datalist id="mg-files">${wordlistOpts}</datalist>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:10px 12px;align-items:center;max-width:720px;margin-bottom:18px">
        <label for="mg-name" style="font-size:13px;color:var(--text-secondary)">Name</label>
        <input type="text" id="mg-name" placeholder="optional — e.g. “rockyou vs 8-char corporate”"
               value="${esc(jobName)}"/>
        <label for="mg-goal" style="font-size:13px;color:var(--text-secondary)">Goal wordlist</label>
        <input type="text" id="mg-goal" list="mg-files" placeholder="the passwords you are trying to recover"
               value="${esc(goal)}"/>
        <label for="mg-runtime" style="font-size:13px;color:var(--text-secondary)">Time cap</label>
        <span style="display:flex;gap:8px;align-items:center">
          <input type="number" id="mg-runtime" min="1" max="86400" style="width:120px"
                 placeholder="none" value="${esc(maxRuntime)}"/>
          <span class="sub" style="margin:0;font-size:12px">
            seconds per attack. An attack stopped by the cap gives a partial — and so understated — result.
          </span>
        </span>
      </div>

      <div style="font-weight:500;margin-bottom:8px">Attacks</div>
      <div class="card-list" id="mg-attacks">${attacks.map(attackHtml).join("")}</div>

      <div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap">
        <button id="mg-add" ${attacks.length >= cfg.max_attacks ? "disabled" : ""}>+ add attack</button>
        <button id="mg-submit" class="primary" ${submitting ? "disabled" : ""}>
          ${submitting ? "queueing…" : "Queue analysis"}
        </button>
        <span class="sub" style="margin:0;font-size:12px">
          Each attack runs separately against the goal list, then every pair is compared.
        </span>
      </div>
      ${formError ? `<div class="card danger" style="margin-top:12px">${esc(formError)}</div>` : ""}
    `;

    wireBuilder();
  }

  function attackHtml(a, i) {
    const needsWordlist = a.mode !== "mask";
    const needsMask = a.mode !== "wordlist";
    const ruleOpts = cfg.rules.map((r) => `<option value="${esc(r)}">`).join("");
    return `
      <div class="card" data-attack="${i}">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <span style="width:10px;height:10px;border-radius:50%;flex:0 0 auto;
                       background:${i === 0 ? COLOR_A : i === 1 ? COLOR_B : "var(--text-tertiary)"}"></span>
          <input type="text" data-field="label" placeholder="attack ${i + 1}" value="${esc(a.label)}"
                 style="flex:1;max-width:260px"/>
          <select data-field="mode" style="max-width:220px">
            ${Object.entries(MODE_LABELS).map(([v, t]) =>
              `<option value="${v}"${a.mode === v ? " selected" : ""}>${t}</option>`).join("")}
          </select>
          <span style="margin-left:auto">
            ${attacks.length > 2 ? `<button data-remove="${i}" style="font-size:12px">remove</button>` : ""}
          </span>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
          ${needsWordlist ? `
            <label style="color:var(--text-secondary)">Wordlist</label>
            <input type="text" data-field="wordlist" list="mg-files" value="${esc(a.wordlist)}"
                   placeholder="candidate list"/>` : ""}
          ${a.mode === "wordlist" ? `
            <label style="color:var(--text-secondary)">Rules</label>
            <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <input type="text" data-field="rules" list="mg-rules" value="${esc(a.rules.join(", "))}"
                     placeholder="optional — comma-separated, e.g. best64.rule" style="flex:1;min-width:200px"/>
              <datalist id="mg-rules">${ruleOpts}</datalist>
              <span class="sub" style="margin:0;font-size:11px">max ${cfg.max_rules}</span>
            </span>` : ""}
          ${needsMask ? `
            <label style="color:var(--text-secondary)">Mask</label>
            <input type="text" data-field="mask" value="${esc(a.mask)}"
                   placeholder="?u?l?l?l?d?d?d?d" style="font-family:'SF Mono',Menlo,Consolas,monospace"/>` : ""}
        </div>
      </div>`;
  }

  function wireBuilder() {
    // The form re-renders whenever its shape changes (mode switched, attack
    // added), so the top-level fields are mirrored into state on every
    // keystroke rather than read at submit time.
    const readTop = () => [
      builderBox.querySelector("#mg-name").value,
      builderBox.querySelector("#mg-goal").value,
      builderBox.querySelector("#mg-runtime").value,
    ];
    for (const id of ["#mg-name", "#mg-goal", "#mg-runtime"]) {
      builderBox.querySelector(id)
        .addEventListener("input", () => { [jobName, goal, maxRuntime] = readTop(); });
    }

    for (const card of builderBox.querySelectorAll("[data-attack]")) {
      const i = Number(card.dataset.attack);
      for (const input of card.querySelectorAll("[data-field]")) {
        const field = input.dataset.field;
        input.addEventListener("input", () => {
          if (field === "rules") {
            attacks[i].rules = input.value.split(",").map((s) => s.trim()).filter(Boolean);
          } else {
            attacks[i][field] = input.value;
          }
        });
        // Changing the mode changes which fields exist, so this one re-renders.
        if (field === "mode") {
          input.addEventListener("change", () => {
            [jobName, goal, maxRuntime] = readTop();
            attacks[i].mode = input.value;
            renderBuilder();
          });
        }
      }
      const rm = card.querySelector("[data-remove]");
      if (rm) {
        rm.addEventListener("click", () => {
          [jobName, goal, maxRuntime] = readTop();
          attacks.splice(i, 1);
          renderBuilder();
        });
      }
    }

    builderBox.querySelector("#mg-add").addEventListener("click", () => {
      [jobName, goal, maxRuntime] = readTop();
      attacks.push({ label: "", mode: "wordlist", wordlist: "", rules: [], mask: "" });
      renderBuilder();
    });
    builderBox.querySelector("#mg-submit").addEventListener("click", submit);
  }

  function buildSpec() {
    const spec = { goal: goal.trim(), attacks: [] };
    if (maxRuntime.trim()) spec.max_runtime_s = Number(maxRuntime);
    attacks.forEach((a, i) => {
      const out = { label: a.label.trim() || `attack ${i + 1}`, mode: a.mode };
      if (a.mode !== "mask") out.wordlist = a.wordlist.trim();
      if (a.mode !== "wordlist") out.mask = a.mask.trim();
      if (a.mode === "wordlist" && a.rules.length) out.rules = a.rules;
      spec.attacks.push(out);
    });
    return spec;
  }

  async function submit() {
    formError = "";
    submitting = true;
    renderBuilder();
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: jobName.trim(), spec: buildSpec() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `server said ${res.status}`);
      location.hash = `#mergeability/${data.id}`;
      return; // the hash change re-renders the scene
    } catch (err) {
      formError = err.message;
    } finally {
      submitting = false;
      renderBuilder();
    }
  }

  // ── job list ─────────────────────────────────────────────────────────────
  async function renderJobs() {
    let jobs;
    try {
      jobs = (await fetch("/api/jobs").then((r) => r.json())).jobs;
    } catch {
      jobsBox.innerHTML = `<div class="card danger">could not list analyses</div>`;
      return;
    }
    if (!jobs.length) {
      jobsBox.innerHTML = `<div class="sub" style="margin:0">Nothing queued yet.</div>`;
      return;
    }

    jobsBox.innerHTML = `
      <div style="overflow:auto">
      <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:560px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">Analysis</th>
          <th style="padding:4px 12px 4px 0;font-weight:500">Status</th>
          <th style="padding:4px 12px 4px 0;font-weight:500">Progress</th>
          <th style="padding:4px 12px 4px 0;font-weight:500">Age</th>
          <th style="padding:4px 0;font-weight:500"></th>
        </tr></thead>
        <tbody>
          ${jobs.map(jobRowHtml).join("")}
        </tbody>
      </table></div>`;

    for (const btn of jobsBox.querySelectorAll("[data-cancel]")) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await fetch(`/api/jobs/${btn.dataset.cancel}`, { method: "DELETE" }).catch(() => {});
        renderJobs();
      });
    }
  }

  function jobRowHtml(j) {
    const title = j.name || `${(j.spec?.attacks || []).length} attacks`;
    const selected = j.id === jobId;
    return `
      <tr style="${selected ? "background:var(--surface-2)" : ""}">
        <td style="padding:5px 12px 5px 0">
          <a href="#mergeability/${esc(j.id)}" style="color:var(--text);text-decoration:none">
            <b>${esc(title)}</b>
            <span class="sub" style="font-size:11px;margin:0"> · ${esc(j.spec?.goal || "")}</span>
          </a>
        </td>
        <td style="padding:5px 12px 5px 0">
          <span class="pill ${STATUS_PILL[j.status] || ""}">${esc(j.status)}</span>
        </td>
        <td style="padding:5px 12px 5px 0;color:var(--text-secondary)">${progressText(j)}</td>
        <td style="padding:5px 12px 5px 0;color:var(--text-secondary)">${ago(j.created_at)}</td>
        <td style="padding:5px 0;text-align:right">
          ${j.status === "queued" || j.status === "running"
            ? `<button data-cancel="${esc(j.id)}" style="font-size:11px;padding:3px 8px">cancel</button>`
            : ""}
        </td>
      </tr>`;
  }

  function progressText(j) {
    if (j.status === "failed") return `<span class="error">${esc(truncate(j.error || "failed", 70))}</span>`;
    if (j.status !== "running") return "—";
    const p = j.progress;
    if (!p) return "starting…";
    const which = `attack ${(p.attack_index ?? 0) + 1}/${p.attack_count ?? "?"}`;
    const s = p.status;
    if (!s || !s.total) return `${which} — loading`;
    return `${which} — ${pct(s.fraction, 1)}%`;
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
      await renderJobs();
      // A finished job never changes again, so stop re-fetching it.
      const done = resultBox.querySelector("[data-pair]");
      if (jobId && !done) await renderResult(jobId);
      poll();
    }, POLL_MS);
  }
}

// ── formatting ─────────────────────────────────────────────────────────────
function pct(part, digits = 1) {
  return (part * 100).toFixed(digits);
}

function num(n) {
  return Number(n || 0).toLocaleString();
}

// Natural units, per the house rule — raw seconds past a minute read badly.
function duration(s) {
  if (s == null) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

function ago(epochSeconds) {
  if (!epochSeconds) return "—";
  return duration(Date.now() / 1000 - epochSeconds) + " ago";
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Escapes for both text and attribute contexts — quotes included, since most
// uses here are inside `value="..."`.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
