// Shared pieces of the two server-side job scenes (Mergeability and Attack
// order).
//
// Both scenes ask for exactly the same thing — a goal wordlist plus a list of
// attacks — and both then watch the same queue; only what they *do* with the
// finished result differs. So the attack builder, the analysis list and the
// number formatting live here, and each scene keeps just its own result view.
//
// The one thing the scenes must not share is the queue listing itself: a job's
// spec carries its `kind`, and each scene filters the list down to its own
// kind so an ordering analysis doesn't show up under Mergeability with a link
// that renders it wrongly.

export const MODE_LABELS = {
  "wordlist": "Wordlist (+ rules)",
  "mask": "Mask / brute force",
  "hybrid-wm": "Hybrid — wordlist + mask",
  "hybrid-mw": "Hybrid — mask + wordlist",
};

export const STATUS_PILL = {
  queued: "pill-info",
  running: "pill-warning",
  done: "pill-success",
  failed: "pill-danger",
  cancelled: "",
};

// Specs written before `kind` existed are mergeability jobs.
export const kindOf = (job) => job?.spec?.kind || "mergeability";

export function emptyAttack() {
  return { label: "", mode: "wordlist", wordlist: "", rules: [], mask: "" };
}

// ── attack builder ─────────────────────────────────────────────────────────
// Returns an object with `render()`. The form re-renders itself whenever its
// *shape* changes (a mode switched, an attack added or removed), so field
// values are mirrored into state on every keystroke rather than read at submit
// time — a re-render would otherwise lose whatever had been typed.
//
// `onSubmit({ name, goal, maxRuntime, attacks })` should throw an Error whose
// message is worth showing; it gets rendered under the buttons.
export function attackBuilder({
  mount, cfg, files, prefix, attacks, maxAttacks, colors = [], hint,
  submitLabel = "Queue analysis", onSubmit,
}) {
  const state = {
    name: "", goal: "", maxRuntime: "",
    attacks, submitting: false, error: "",
  };
  const id = (suffix) => `${prefix}-${suffix}`;
  const q = (suffix) => mount.querySelector(`#${id(suffix)}`);

  function render() {
    mount.innerHTML = `
      <datalist id="${id("files")}">
        ${files.map((f) => `<option value="${esc(f.path)}">`).join("")}
      </datalist>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:10px 12px;align-items:center;max-width:720px;margin-bottom:18px">
        <label for="${id("name")}" style="font-size:13px;color:var(--text-secondary)">Name</label>
        <input type="text" id="${id("name")}" placeholder="optional — a label you'll recognise later"
               value="${esc(state.name)}"/>
        <label for="${id("goal")}" style="font-size:13px;color:var(--text-secondary)">Goal wordlist</label>
        <input type="text" id="${id("goal")}" list="${id("files")}"
               placeholder="the passwords you are trying to recover" value="${esc(state.goal)}"/>
        <label for="${id("runtime")}" style="font-size:13px;color:var(--text-secondary)">Time cap</label>
        <span style="display:flex;gap:8px;align-items:center">
          <input type="number" id="${id("runtime")}" min="1" max="86400" style="width:120px"
                 placeholder="none" value="${esc(state.maxRuntime)}"/>
          <span class="sub" style="margin:0;font-size:12px">
            seconds per attack. An attack stopped by the cap gives a partial — and so understated — result.
          </span>
        </span>
      </div>

      <div style="font-weight:500;margin-bottom:8px">Attacks</div>
      <div class="card-list" id="${id("attacks")}">
        ${state.attacks.map((a, i) => attackHtml(a, i)).join("")}
      </div>

      <div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap">
        <button id="${id("add")}" ${state.attacks.length >= maxAttacks ? "disabled" : ""}>+ add attack</button>
        <button id="${id("submit")}" class="primary" ${state.submitting ? "disabled" : ""}>
          ${state.submitting ? "queueing…" : esc(submitLabel)}
        </button>
        <span class="sub" style="margin:0;font-size:12px">${hint}</span>
      </div>
      ${state.error ? `<div class="card danger" style="margin-top:12px">${esc(state.error)}</div>` : ""}
    `;
    wire();
  }

  function attackHtml(a, i) {
    const needsWordlist = a.mode !== "mask";
    const needsMask = a.mode !== "wordlist";
    return `
      <div class="card" data-attack="${i}">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <span style="width:10px;height:10px;border-radius:50%;flex:0 0 auto;
                       background:${colors[i] || "var(--text-tertiary)"}"></span>
          <input type="text" data-field="label" placeholder="attack ${i + 1}" value="${esc(a.label)}"
                 style="flex:1;max-width:260px"/>
          <select data-field="mode" style="max-width:220px">
            ${Object.entries(MODE_LABELS).map(([v, t]) =>
              `<option value="${v}"${a.mode === v ? " selected" : ""}>${t}</option>`).join("")}
          </select>
          <span style="margin-left:auto">
            ${state.attacks.length > 2 ? `<button data-remove="${i}" style="font-size:12px">remove</button>` : ""}
          </span>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center;font-size:13px">
          ${needsWordlist ? `
            <label style="color:var(--text-secondary)">Wordlist</label>
            <input type="text" data-field="wordlist" list="${id("files")}" value="${esc(a.wordlist)}"
                   placeholder="candidate list"/>` : ""}
          ${a.mode === "wordlist" ? `
            <label style="color:var(--text-secondary)">Rules</label>
            <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <input type="text" data-field="rules" list="${id("rules")}" value="${esc(a.rules.join(", "))}"
                     placeholder="optional — comma-separated, e.g. best64.rule" style="flex:1;min-width:200px"/>
              <datalist id="${id("rules")}">
                ${cfg.rules.map((r) => `<option value="${esc(r)}">`).join("")}
              </datalist>
              <span class="sub" style="margin:0;font-size:11px">max ${cfg.max_rules}</span>
            </span>` : ""}
          ${needsMask ? `
            <label style="color:var(--text-secondary)">Mask</label>
            <input type="text" data-field="mask" value="${esc(a.mask)}"
                   placeholder="?u?l?l?l?d?d?d?d" style="font-family:'SF Mono',Menlo,Consolas,monospace"/>` : ""}
        </div>
      </div>`;
  }

  // Pull the three top-level fields into state. Called before every re-render
  // so nothing typed since the last one is lost.
  function readTop() {
    state.name = q("name").value;
    state.goal = q("goal").value;
    state.maxRuntime = q("runtime").value;
  }

  function wire() {
    for (const suffix of ["name", "goal", "runtime"]) {
      q(suffix).addEventListener("input", readTop);
    }

    for (const card of mount.querySelectorAll("[data-attack]")) {
      const i = Number(card.dataset.attack);
      for (const input of card.querySelectorAll("[data-field]")) {
        const field = input.dataset.field;
        input.addEventListener("input", () => {
          if (field === "rules") {
            state.attacks[i].rules = input.value.split(",").map((s) => s.trim()).filter(Boolean);
          } else {
            state.attacks[i][field] = input.value;
          }
        });
        // Changing the mode changes which fields exist, so this one re-renders.
        if (field === "mode") {
          input.addEventListener("change", () => {
            readTop();
            state.attacks[i].mode = input.value;
            render();
          });
        }
      }
      const rm = card.querySelector("[data-remove]");
      if (rm) {
        rm.addEventListener("click", () => {
          readTop();
          state.attacks.splice(i, 1);
          render();
        });
      }
    }

    q("add").addEventListener("click", () => {
      readTop();
      state.attacks.push(emptyAttack());
      render();
    });
    q("submit").addEventListener("click", submit);
  }

  async function submit() {
    state.error = "";
    state.submitting = true;
    render();
    try {
      await onSubmit({
        name: state.name.trim(),
        goal: state.goal.trim(),
        maxRuntime: state.maxRuntime.trim(),
        attacks: state.attacks,
      });
      return; // a successful submit navigates away; leave the form disabled
    } catch (err) {
      state.error = err.message;
    } finally {
      state.submitting = false;
      render();
    }
  }

  return { render, state };
}

// Turn the builder's attacks into the `attacks` half of a job spec.
export function attacksToSpec(attacks) {
  return attacks.map((a, i) => {
    const out = { label: a.label.trim() || `attack ${i + 1}`, mode: a.mode };
    if (a.mode !== "mask") out.wordlist = a.wordlist.trim();
    if (a.mode !== "wordlist") out.mask = a.mask.trim();
    if (a.mode === "wordlist" && a.rules.length) out.rules = a.rules;
    return out;
  });
}

// ── analysis list ──────────────────────────────────────────────────────────
// One table of this scene's own jobs. `refresh()` re-fetches; the caller polls
// it. Filtered by kind — the queue is shared, the views are not.
export function jobList({ mount, kind, hashPrefix, selectedId = "" }) {
  async function refresh() {
    let jobs;
    try {
      jobs = (await fetch("/api/jobs").then((r) => r.json())).jobs;
    } catch {
      mount.innerHTML = `<div class="card danger">could not list analyses</div>`;
      return;
    }
    jobs = jobs.filter((j) => kindOf(j) === kind);
    if (!jobs.length) {
      mount.innerHTML = `<div class="sub" style="margin:0">Nothing queued yet.</div>`;
      return;
    }

    const th = (label, extra = "") =>
      `<th style="padding:4px 12px 4px 0;font-weight:500;${extra}">${label}</th>`;
    mount.innerHTML = `
      <div style="overflow:auto">
      <table style="border-collapse:collapse;font-size:12px;width:100%;min-width:560px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          ${th("Analysis")}${th("Status")}${th("Progress")}${th("Age")}
          <th style="padding:4px 0;font-weight:500"></th>
        </tr></thead>
        <tbody>${jobs.map(rowHtml).join("")}</tbody>
      </table></div>`;

    for (const btn of mount.querySelectorAll("[data-cancel]")) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await fetch(`/api/jobs/${btn.dataset.cancel}`, { method: "DELETE" }).catch(() => {});
        refresh();
      });
    }
  }

  function rowHtml(j) {
    const title = j.name || `${(j.spec?.attacks || []).length} attacks`;
    const active = j.status === "queued" || j.status === "running";
    return `
      <tr style="${j.id === selectedId ? "background:var(--surface-2)" : ""}">
        <td style="padding:5px 12px 5px 0">
          <a href="#${hashPrefix}/${esc(j.id)}" style="color:var(--text);text-decoration:none">
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
          ${active ? `<button data-cancel="${esc(j.id)}" style="font-size:11px;padding:3px 8px">cancel</button>` : ""}
        </td>
      </tr>`;
  }

  return { refresh };
}

export function progressText(j) {
  if (j.status === "failed") return `<span class="error">${esc(truncate(j.error || "failed", 70))}</span>`;
  if (j.status !== "running") return "—";
  const p = j.progress;
  if (!p) return "starting…";
  const which = `attack ${(p.attack_index ?? 0) + 1}/${p.attack_count ?? "?"}`;
  const s = p.status;
  if (!s || !s.total) return `${which} — loading`;
  return `${which} — ${pct(s.fraction, 1)}%`;
}

// The "no server library" explainer, which applies to both scenes for the same
// reason: a job runs on the server, so its inputs have to be files the server
// can already see.
export function noLibraryHtml(what) {
  return `
    <div class="card warning">
      <b>No server wordlist library is configured.</b> ${what} runs on the server, so its goal list
      and attack wordlists have to be files the server can already see — they can't be uploaded from
      the browser like the other scenes' inputs. Set <code>NARWAL_WORDLISTS_DIR</code> in
      <code>.env</code> and restart; see <code>.env.example</code>.
    </div>`;
}

// ── formatting ─────────────────────────────────────────────────────────────
export function pct(part, digits = 1) {
  return (part * 100).toFixed(digits);
}

export function num(n) {
  return Number(n || 0).toLocaleString();
}

// Natural units, per the house rule — raw seconds past a minute read badly.
export function duration(s) {
  if (s == null) return "—";
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

export function ago(epochSeconds) {
  if (!epochSeconds) return "—";
  return duration(Date.now() / 1000 - epochSeconds) + " ago";
}

export function truncate(s, n) {
  s = String(s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Escapes for both text and attribute contexts — quotes included, since most
// uses here are inside `value="..."`.
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
