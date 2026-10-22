// Scene — Attack order.
//
// The sibling of the Mergeability scene. Mergeability asks *whether* a second
// attack is worth running; this one takes the attacks as already decided and
// asks in what **sequence** to run them so that the cracked count climbs as
// steeply as possible. Same queue, same hashcat work, different question —
// and the answer is worth real work, because two sequences of the same attacks
// make the same total number of guesses while one of them may have found 80%
// of its haul in the first fraction of them.
//
// The thing to understand about the cost: scoring an ordering needs nothing but
// each attack's recovered set and its guess count, neither of which depends on
// where the attack sits in the sequence (`--potfile-disable` means every attack
// is run against the full goal list and never sees another's results). So the
// worker runs each attack **once** — exactly as a mergeability job does — and
// backend/jobs/ordering.py then scores all N! permutations exactly (up to 10
// attacks), or beam-searches for a near-optimal order above that, in
// milliseconds either way.
//
// The headline number is `efficiency`: the area under the cracked-vs-guesses
// curve normalised by (total recovered × total guesses), so 1 would be
// "everything found at once" and 0.5 is "recovery grew linearly with guesses".
// Guesses, not seconds, because a guess count belongs to the attack while a
// duration also depends on the machine — but if the backend could not record
// guess counts it falls back to time, and `cost_axis` says which was used.
// Both denominators are identical for every sequence, which is what makes the
// comparison fair — see the module docstring in backend/jobs/ordering.py for
// the one modelling assumption involved.
//
// Routing: `#ordering` is the builder, `#ordering/<job-id>` shows one result.

import { listServerFiles, listRuleFiles } from "../util/serverFiles.js";
import {
  MODE_LABELS, attackBuilder, attacksToSpec, emptyAttack, jobList,
  noLibraryHtml, progressText, duration, esc, num, pct,
} from "../util/jobForm.js";

export const name = "ordering";

const POLL_MS = 3000;

// Rolling-average window (in profile buckets) for the efficiency chart's
// smoothed line. The raw per-bucket rate is spiky — small integer crack counts
// over a 64-bucket profile — so the bold line averages over this many buckets.
const EFF_SMOOTH = 5;

// Best / greedy / worst, in the order they are drawn and listed.
const CURVES = [
  { key: "best", label: "Best order", color: "#1C7C54" },     // success green
  { key: "greedy", label: "Greedy order", color: "#B8860B" },  // warning amber
  { key: "worst", label: "Worst order", color: "#A5185F" },    // danger magenta
];

export async function render(mount, route = "") {
  const jobId = (route || "").trim();

  mount.style.maxWidth = "1600px";
  mount.innerHTML = `
    <div class="panel">
      <h2>Attack order</h2>
      <div class="sub">
        You have decided which attacks to run. This works out <b>in what order</b> to run them so
        passwords turn up as early as possible — the total haul and the total number of guesses are
        the same whichever sequence you pick, but how soon you get there is not. Every permutation is
        scored exhaustively; the worker still only runs each attack once, because an attack recovers
        the same set with the same guesses wherever it sits in the sequence.
      </div>
      <div id="setup"></div>
      <div id="builder"></div>
    </div>
    <div class="panel">
      <h2>Analyses</h2>
      <div class="sub">Newest first. Results are kept until you delete them.</div>
      <div id="jobs"><div class="loading">loading…</div></div>
    </div>
    <div id="result"></div>
  `;

  const setupBox = mount.querySelector("#setup");
  const builderBox = mount.querySelector("#builder");
  const resultBox = mount.querySelector("#result");

  // app.js clears #view on navigation, which detaches this and stops the poll
  // loop below — see the same trick in mergeability.js.
  const alive = document.createComment("ordering-mounted");
  mount.appendChild(alive);

  // Chart.js instances outlive their canvas unless destroyed, and the poll
  // loop re-renders the result panel.
  let charts = [];

  let cfg = { enabled: false, rules: [], max_ordering_attacks: 8, max_rules: 4 };
  let files = [];
  let rules = [];

  try {
    [cfg, files, rules] = await Promise.all([
      fetch("/api/jobs/config").then((r) => r.json()),
      listServerFiles(".dict,.masks,.txt"),
      listRuleFiles(".rule"),
      // List only relevant file types
    ]);
  } catch (err) {
    setupBox.innerHTML = `<div class="card danger">could not reach the job API: ${esc(err.message)}</div>`;
    return;
  }

  // Load rules into config
  cfg.rules = rules.map(f => f.path)

  const maxAttacks = cfg.max_ordering_attacks || cfg.max_attacks || 8;
  const jobs = jobList({
    mount: mount.querySelector("#jobs"),
    kind: "ordering",
    hashPrefix: "ordering",
    selectedId: jobId,
  });

  if (!cfg.enabled) {
    setupBox.innerHTML = noLibraryHtml("An ordering analysis");
  } else {
    attackBuilder({
      mount: builderBox,
      cfg, files,
      prefix: "or",
      // Three is the smallest number of attacks where the answer is not
      // obvious, so it's the useful default to open on.
      attacks: [
        { ...emptyAttack() },
        { ...emptyAttack() },
        { ...emptyAttack(), mode: "mask", mask: "?u?l?l?l?d?d?d?d" },
      ],
      maxAttacks,
      colors: CURVES.map((c) => c.color),
      hint: `Up to ${maxAttacks} attacks — every ordering scored exactly up to 10 attacks,
             by beam search above that.`,
      submitLabel: "Queue ordering analysis",
      onSubmit: submit,
    }).render();
  }

  jobs.refresh();
  if (jobId) renderResult(jobId);
  poll();

  async function submit({ name: jobName, goal, maxRuntime, derived, attacks }) {
    const spec = { kind: "ordering", goal, attacks: attacksToSpec(attacks) };
    if (maxRuntime) spec.max_runtime_s = Number(maxRuntime);
    if (derived?.length) spec.suspect_wordlists = derived;

    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: jobName, spec }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `server said ${res.status}`);
    location.hash = `#ordering/${data.id}`; // the hash change re-renders the scene
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

    for (const c of charts) c.destroy();
    charts = [];

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
    const C = costCtx(r);
    const best = r.best;
    const worst = r.worst;
    // `hasProfile` gates the two "show recovery profile" checkboxes: true when any
    // drawn ordering carries a per-step recovery profile. An old result or an
    // all-`--increment` job has none.
    const hasProfile = [r.best, r.greedy, r.worst].some(
      (o) => o?.steps?.some((s) => Array.isArray(s.recovery_profile) && s.recovery_profile.length)
    );
    // Cost to half the haul, best against worst: the single number that says
    // whether reordering is worth anybody's attention.
    const saved = halfOf(worst) != null && halfOf(best) != null
      ? halfOf(worst) - halfOf(best)
      : null;

    resultBox.innerHTML = `
      <div class="panel" data-ordering-done="1">
        <h2>${esc(job.name || "Analysis")}</h2>
        <div class="sub">
          Goal <code>${esc(r.goal)}</code> — ${num(r.goal_size)} distinct passwords.
          ${r.approximate
            ? `best found by beam search (width ${num(r.beam_width)}), with ${num(r.permutations_scored)} orderings sampled,`
            : `${num(r.permutations_scored)} sequences scored`} from ${r.attacks.length} hashcat runs
          ${C.guesses ? `totalling ${guessFmt(r.total_guesses)} guesses` : `totalling ${duration(r.total_runtime_s)}`}${
            C.guesses && r.total_runtime_s != null ? ` (${duration(r.total_runtime_s)})` : ""
          }, on hashcat ${esc(r.hashcat_version || "?")}.
        </div>

        ${r.partial ? `<div class="card warning">${esc(r.partial_note)}</div>` : ""}
        ${C.axis === "time" && r.cost_axis ? `<div class="card warning">
          hashcat did not report a guess count for every attack, so the sequence below is ranked by
          <b>measured runtime</b> instead — which depends on this host and its kernel-cache state, not
          on the attacks alone. Treat the order as advisory.
        </div>` : ""}
        ${C.axis === "equal" ? `<div class="card warning">
          Neither guess counts nor per-attack runtimes were recorded, so every attack was weighted
          equally. The sequence below still reflects which attacks make others redundant, but not
          what they cost.
        </div>` : ""}
        ${r.goal_rejected ? `<div class="card warning" style="margin-top:8px">
          hashcat rejected ${num(r.goal_rejected)} line(s) of the goal file — over its 256-character
          limit, or otherwise unparseable. Coverage is measured against the ${num(r.goal_size)}
          that did load.
        </div>` : ""}

        ${(r.suspect_wordlists?.length || r.contaminated_total) ? `<div class="card info" style="margin-top:8px">
          <b>${num(r.contaminated_total || 0)}</b> recovered password${(r.contaminated_total === 1) ? " was" : "s were"}
          set aside as dictionary contamination — goal words found sitting verbatim in a derived list
          (${(r.suspect_wordlists || []).map((w) => `<code>${esc(w)}</code>`).join(", ") || "none"}), so they
          are not counted anywhere below. Cracks a rule <i>derived</i> are still counted, even when the
          derived form also happens to be in the list.
        </div>` : ""}

        ${headlineHtml(r, best, worst, saved)}

        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:22px 0 8px">
          <span style="font-weight:500">Recovery over ${C.noun}</span>
          ${hasProfile ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;
                        color:var(--text-secondary);cursor:pointer"
                 title="Replace the straight within-attack segments with the measured recovery shape (from hashcat crack_pos), pinned to the same measured endpoints.">
            <input type="checkbox" id="or-curve-profile"/>
            show recovery profile
          </label>` : ""}
        </div>
        <div class="chart-wrap" style="height:340px"><canvas id="or-curve"></canvas></div>
        <div class="sub" style="font-size:12px;margin-top:6px">
          Each marker is the end of one attack${hasProfile ? "" : ", and the markers are measured"}.
          ${hasProfile
            ? `With <b>show recovery profile</b> off, recovery within an attack is drawn as a straight
               line (the one modelling assumption); on, the segment follows the <b>measured</b> recovery
               from hashcat crack_pos — order-aware, counting only the passwords each attack adds that
               earlier attacks had not already found, so a run that mostly duplicates earlier ones shows
               a flat-then-rising curve. The only assumption left is uniform recovery within a 1/64
               slice of the keyspace; crack_pos is rough and device-dependent, and an
               <code>--increment</code> attack has no single profile and stays straight.`
            : `Within an attack recovery is drawn as a straight line, because hashcat reports how many
               goal entries an attack found and ${
                 C.guesses ? "how many guesses it made but not which entry it found at which guess"
                 : "how long it took but not which entry it found at which second"
               } — so the lines between the markers are the one assumption in here.`}
        </div>

        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:22px 0 8px">
          <span style="font-weight:500">Efficiency — recovery per ${C.guesses ? "guess" : "second"}</span>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;
                        color:var(--text-secondary);cursor:pointer"
                 title="Switch the vertical axis (recovery rate) between a logarithmic and a linear scale.">
            <input type="checkbox" id="or-eff-log" checked/>
            logarithmic
          </label>
          ${hasProfile ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;
                        color:var(--text-secondary);cursor:pointer"
                 title="Draw the measured within-attack rate (from hashcat crack_pos) instead of one flat step per attack: a faint raw per-bucket rate plus a bold rolling average.">
            <input type="checkbox" id="or-eff-profile"/>
            show recovery profile
          </label>` : ""}
        </div>
        <div class="chart-wrap" style="height:300px"><canvas id="or-eff"></canvas></div>
        <div class="sub" style="font-size:12px;margin-top:6px">
          The slope of the curve above, drawn directly: how many new passwords each ${
            C.guesses ? "guess buys" : "second buys"
          }. ${hasProfile
            ? `With <b>show recovery profile</b> off, each attack is one flat step (its new cracks over
               its total ${C.guesses ? "guesses" : "runtime"}). On, the within-attack rate is drawn from
               hashcat crack_pos — order-aware, so it is the rate of <i>new</i> passwords at each point
               in the run; the faint line is the raw per-bucket rate (rough and device-dependent), the
               bold line a rolling average over ${EFF_SMOOTH} buckets.`
            : `Each attack is a flat step — hashcat reports its total cracks and ${
                C.guesses ? "guesses" : "runtime"
              }, not which crack landed when — so the rate is constant within an attack and drops at
               each boundary.`}
          On a log axis you can watch it fall across orders of magnitude; where it craters is the point
          past which running longer stops paying for itself.
        </div>

        <div style="font-weight:500;margin:22px 0 8px">The recommended run order</div>
        ${stepsTableHtml(best, r)}

        <div style="font-weight:500;margin:22px 0 8px">When you get there</div>
        ${milestonesHtml(r, best, worst)}

        <div style="font-weight:500;margin:22px 0 8px">Each attack on its own</div>
        ${r.attacks.map((a) => attackBarHtml(a, r)).join("")}

        <div class="grid-2" style="margin-top:22px">
          <div>
            <div style="font-weight:500;margin-bottom:8px">
              What to run first
              <span class="sub" style="font-weight:400;font-size:11px">
                (best score reachable from each opening move)
              </span>
            </div>
            ${firstChoiceHtml(r)}
          </div>
          <div>
            <div style="font-weight:500;margin-bottom:8px">
              Does the order matter?
              <span class="sub" style="font-weight:400;font-size:11px">
                (${r.approximate ? `${num(r.permutations_scored)} sampled` : `all ${num(r.permutations_scored)}`} sequences by score)
              </span>
            </div>
            ${distributionHtml(r)}
          </div>
        </div>

        <div style="font-weight:500;margin:22px 0 8px">
          Who finds what
          <span class="sub" style="font-weight:400;font-size:11px">
            (every password grouped by the set of attacks that recover it — the reason one order
            beats another)
          </span>
        </div>
        ${signaturesHtml(r)}

        <div style="font-weight:500;margin:22px 0 8px">
          Top ${r.top.length} sequences
        </div>
        ${rankingHtml(r)}

        <div class="note">
          <b>Score</b> is the area under the recovery curve divided by (total recovered × total
          ${C.guesses ? "guesses" : "runtime"}): 1 would be everything found
          ${C.guesses ? "at once" : "instantly"}, 0.5 means recovery kept pace with
          ${C.guesses ? "the guesses spent" : "the clock"}, and above 0.5 means the sequence is
          front-loaded. Both divisors are the same for every sequence, so the ranking is unaffected
          by the normalisation — it only makes the number readable.
          ${C.guesses ? `Guesses, not seconds, are the axis because a guess count belongs to the
          attack while a runtime also depends on the machine and the kernel cache.` : ""}
          <b>Greedy</b> is the obvious heuristic (always run whichever attack adds the most new
          passwords per ${C.guesses ? "guess" : "second"} next); it is shown because it is not always
          right — an attack can look productive until the attack that would have duplicated it has
          been taken out of the pool, which is why ${r.approximate
            ? "a wide beam of orderings is searched rather than trusting greedy"
            : "every permutation is scored instead"}.
        </div>
        ${r.approximate ? `<div class="sub" style="margin-top:8px">
          With more than 10 attacks there are too many orderings to score them all (ordering is an
          NP-hard problem), so <b>beam search</b> keeps the best ${num(r.beam_width)} partial sequences
          at each step to find a near-optimal order, and the spread above is from a random sample. The
          recommended order is "best found", not provably optimal.
        </div>` : ""}
        <div class="sub" style="margin-top:10px">
          Wondering whether an attack earns its place at all? <a href="#mergeability">Mergeability</a>
          measures what each one adds on top of each other one.
        </div>
      </div>`;

    // The job is finished, so renderResult (and this wiring) runs once; the poll
    // loop stops re-rendering a done job. Each "show recovery profile" checkbox
    // rebuilds its chart (the dataset set changes too much to mutate in place),
    // keeping a live reference so the efficiency chart's log toggle still reaches
    // the current instance after a rebuild.
    let curveChart = drawCurve(r, false);
    let effChart = drawEfficiency(r, false);

    const rebuild = (chart, make) => {
      if (chart) {
        charts = charts.filter((c) => c !== chart);
        chart.destroy();
      }
      return make();
    };

    const curveProfileBox = resultBox.querySelector("#or-curve-profile");
    if (curveProfileBox) {
      curveProfileBox.addEventListener("change", (e) => {
        curveChart = rebuild(curveChart, () => drawCurve(r, e.target.checked));
      });
    }

    const effProfileBox = resultBox.querySelector("#or-eff-profile");
    if (effProfileBox) {
      effProfileBox.addEventListener("change", (e) => {
        effChart = rebuild(effChart, () => drawEfficiency(r, e.target.checked));
      });
    }

    // Second chart: the derivative of the one above — recovery rate per unit
    // cost — with a log/linear toggle. drawEfficiency reads #or-eff-log for its
    // initial axis, so the log choice survives a profile rebuild too.
    const logBox = resultBox.querySelector("#or-eff-log");
    if (logBox) {
      logBox.addEventListener("change", (e) => {
        if (!effChart) return;
        effChart.options.scales.y.type = e.target.checked ? "logarithmic" : "linear";
        effChart.options.scales.y.beginAtZero = !e.target.checked;
        effChart.update();
      });
    }
  }

  function headlineHtml(r, best, worst, saved) {
    const C = costCtx(r);
    const greedy = r.greedy;
    const seq = (o) => (o?.order || []).map((l, i) =>
      `${i ? `<span style="color:var(--text-tertiary);margin:0 4px">→</span>` : ""}
       <code style="background:var(--surface-2);border:0.5px solid var(--border);border-radius:4px;
                    padding:2px 7px">${esc(l)}</code>`).join("");

    return `
      <div class="card success" style="margin-top:12px">
        <div style="margin-bottom:8px">
          Run them in this order — ${r.approximate
            ? `best found by beam search`
            : `best of ${num(r.permutations_scored)}`}, score
          <b>${pct(best.efficiency, 1)}%</b>:
        </div>
        <div style="line-height:2">${seq(best)}</div>
        <div style="margin-top:10px;font-size:13px">
          Together these recover <b>${num(r.combined_recovered)}</b> of ${num(r.goal_size)}
          goal passwords (<b>${pct(r.combined_coverage, 1)}%</b>)
          ${C.total != null ? `for ${C.fmt(C.total)}${C.guesses ? " guesses" : ""}` : ""} — the
          same haul for the same ${C.guesses ? "guesses" : "time"} as any other sequence.
          ${saved != null && saved > 0 ? `
            This one is halfway there after <b>${C.fmt(halfOf(best))}${C.guesses ? " guesses" : ""}</b>;
            the worst sequence takes <b>${C.fmt(halfOf(worst))}${C.guesses ? " guesses" : ""}</b> to
            reach the same point, so the order is worth <b>${C.fmt(saved)}${C.guesses ? " guesses" : ""}</b>.`
            : saved != null ? `
            Every sequence reaches halfway at about the same point here, so the order makes little
            practical difference for these attacks.` : ""}
        </div>
      </div>
      <div class="card ${greedy.is_optimal ? "info" : "warning"}" style="margin-top:8px;font-size:13px">
        ${greedy.is_optimal
          ? `Picking greedily — always the best new-passwords-per-${C.guesses ? "guess" : "second"}
             next — lands on ${r.approximate ? "the same sequence beam search found" : "an optimal sequence here"}.
             ${r.approximate ? "Beam search explores many more orderings and found nothing better."
               : "Enumerating every permutation is what establishes that."}`
          : `Picking greedily would have given <span style="line-height:2">${seq(greedy)}</span>
             at ${pct(greedy.efficiency, 1)}%, which ${num(greedy.beaten_by)}
             ${r.approximate ? "sampled " : ""}sequence${greedy.beaten_by === 1 ? "" : "s"} beat.`}
      </div>`;
  }

  // Cost (guesses, or seconds for an old result) at the 50% milestone — the
  // one number that says whether reordering is worth anybody's attention.
  function halfOf(o) {
    const m = o?.milestones?.find((m) => m.fraction === 0.5);
    return m ? (m.cost ?? m.time_s ?? null) : null;
  }

  function stepsTableHtml(best, r) {
    const n = "text-align:right;font-variant-numeric:tabular-nums";
    const C = costCtx(r);
    return `
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px;min-width:640px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">#</th>
          <th style="padding:4px 12px 4px 0;font-weight:500">Attack</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">${C.takesCol}</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">New</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">${C.rateCol}</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Done at</th>
          <th style="padding:4px 0;font-weight:500;${n}">Goal covered</th>
        </tr></thead>
        <tbody>
          ${best.steps.map((s, i) => `
            <tr>
              <td style="padding:5px 12px 5px 0;color:var(--text-tertiary)">${i + 1}</td>
              <td style="padding:5px 12px 5px 0"><b>${esc(s.label)}</b></td>
              <td style="padding:5px 12px 5px 0;${n}">${C.fmt(C.one(s))}</td>
              <td style="padding:5px 12px 5px 0;${n}">${num(s.gain)}</td>
              <td style="padding:5px 12px 5px 0;${n}">${C.rateFmt(C.gainRate(s))}</td>
              <td style="padding:5px 12px 5px 0;${n}">${C.fmt(C.cum(s))}</td>
              <td style="padding:5px 0;${n}"><b>${pct(s.cumulative_coverage, 1)}%</b></td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      <div class="sub" style="font-size:12px;margin-top:6px">
        <b>New</b> is what that attack adds given everything before it — not what it would find on
        its own. An attack whose "New" is near zero is one you could drop entirely, or keep for
        last.
      </div>`;
  }

  function milestonesHtml(r, best, worst) {
    const n = "text-align:right;font-variant-numeric:tabular-nums";
    const C = costCtx(r);
    const byFraction = (o) => new Map((o?.milestones || []).map((m) => [m.fraction, m]));
    const bm = byFraction(best), wm = byFraction(worst), gm = byFraction(r.greedy);
    return `
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px;min-width:520px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">Share of the haul</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Passwords</th>
          ${CURVES.map((c) =>
            `<th style="padding:4px 12px 4px 0;font-weight:500;${n};color:${c.color}">${c.label}</th>`).join("")}
          <th style="padding:4px 0;font-weight:500;${n}">Saved</th>
        </tr></thead>
        <tbody>
          ${r.milestone_fractions.map((f) => {
            const b = bm.get(f), w = wm.get(f), g = gm.get(f);
            const bc = C.ms(b), wc = C.ms(w);
            const delta = (wc != null && bc != null) ? wc - bc : null;
            return `
              <tr>
                <td style="padding:5px 12px 5px 0">${pct(f, 0)}%${f === 1 ? " (everything)" : ""}</td>
                <td style="padding:5px 12px 5px 0;${n}">${num(b?.target)}</td>
                <td style="padding:5px 12px 5px 0;${n}"><b>${C.fmt(bc)}</b></td>
                <td style="padding:5px 12px 5px 0;${n}">${C.fmt(C.ms(g))}</td>
                <td style="padding:5px 12px 5px 0;${n}">${C.fmt(wc)}</td>
                <td style="padding:5px 0;${n}">${delta ? C.fmt(delta) : "—"}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table></div>
      <div class="sub" style="font-size:12px;margin-top:6px">
        Shares are of what these attacks recover <i>between them</i> (${num(r.combined_recovered)}),
        not of the whole goal list — 100% here is the ceiling for this set of attacks, reached at the
        same moment by every sequence.
      </div>`;
  }

  function attackBarHtml(a, r) {
    const C = costCtx(r);
    const detail = a.mode === "mask"
      ? `<code>${esc(a.mask || "")}</code>`
      : [a.wordlist ? `<code>${esc(a.wordlist)}</code>` : "",
         a.rules?.length ? `+ ${a.rules.map((x) => `<code>${esc(x)}</code>`).join(" ")}` : "",
         a.mask ? `+ <code>${esc(a.mask)}</code>` : ""].filter(Boolean).join(" ");
    const place = (r.best.order.indexOf(a.label) + 1) || "?";
    return `
      <div style="margin-bottom:12px">
        <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:13px">
          <span class="pill pill-info" style="font-size:10px">#${place}</span>
          <b>${esc(a.label)}</b>
          <span class="pill pill-mask" style="font-size:10px">${esc(MODE_LABELS[a.mode] || a.mode)}</span>
          <span class="sub" style="margin:0;font-size:11px">${detail}</span>
          ${a.partial ? `<span class="pill pill-warning" style="font-size:10px">stopped early</span>` : ""}
          <span style="margin-left:auto;font-variant-numeric:tabular-nums">
            ${num(a.recovered)} in
            ${C.guesses ? `${guessFmt(a.guesses)} guesses` : duration(a.duration_s)}
            · <b>${pct(a.coverage, 1)}%</b>
          </span>
        </div>
        <div style="display:flex;height:6px;background:var(--surface-3);border-radius:3px;overflow:hidden;margin-top:4px">
          <div title="${num(a.recovered)} true cracks"
               style="width:${(a.coverage * 100).toFixed(1)}%;background:${CURVES[0].color}"></div>
          ${a.suspect && a.contaminated && r.goal_size ? `
          <div title="${num(a.contaminated)} set aside as contamination"
               style="width:${((a.contaminated / r.goal_size) * 100).toFixed(1)}%;background:var(--warning-border)"></div>` : ""}
        </div>
        <div class="sub" style="margin:4px 0 0;font-size:11px">
          ${C.guesses
            ? (a.rate_per_guess != null ? `recovers ${perGuess(a.rate_per_guess)} on its own` : "guess count not recorded")
            : (a.rate_per_s != null ? `recovers ${rate(a.rate_per_s)} on its own` : "runtime not recorded")}
          · <b>${num(a.exclusive)}</b> password${a.exclusive === 1 ? "" : "s"} only this attack finds
          ${a.exclusive === 0 ? " — everything it recovers, something else recovers too" : ""}
          ${a.suspect ? ` · <b>${num(a.contaminated || 0)}</b> set aside as contamination` : ""}
        </div>
      </div>`;
  }

  function firstChoiceHtml(r) {
    const n = "text-align:right;font-variant-numeric:tabular-nums";
    const top = r.first_choice[0]?.efficiency ?? 1;
    return `
      <table style="border-collapse:collapse;font-size:12px;width:100%">
        <tbody>
          ${r.first_choice.map((e, i) => `
            <tr>
              <td style="padding:5px 12px 5px 0;width:1%;white-space:nowrap">
                ${i === 0 ? "<b>" : ""}${esc(e.label)}${i === 0 ? "</b>" : ""}
              </td>
              <td style="padding:5px 8px 5px 0">
                <div style="height:8px;background:var(--surface-3);border-radius:4px;overflow:hidden">
                  <div style="height:100%;width:${((e.efficiency / (top || 1)) * 100).toFixed(1)}%;
                              background:${i === 0 ? CURVES[0].color : "var(--text-tertiary)"}"></div>
                </div>
              </td>
              <td style="padding:5px 0;${n};width:1%;white-space:nowrap">${pct(e.efficiency, 1)}%</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="sub" style="font-size:12px;margin-top:6px">
        If you only change one thing, change what runs first. Each bar is the best score any
        sequence opening with that attack can reach.
      </div>`;
  }

  function distributionHtml(r) {
    const d = r.distribution;
    const peak = Math.max(...d.bins, 1);
    const spread = d.max - d.min;
    // The mean is drawn where it actually falls, not centred under the chart —
    // a label pinned to the middle would imply the spread is symmetric.
    const meanAt = spread > 0 ? ((d.mean - d.min) / spread) * 100 : 50;
    return `
      <div style="position:relative;height:90px">
        <div style="display:flex;align-items:flex-end;gap:2px;height:100%">
          ${d.bins.map((count, i) => {
            const lo = d.bin_min + i * d.bin_width;
            return `<div title="${pct(lo, 1)}–${pct(lo + d.bin_width, 1)}% — ${num(count)} sequence(s)"
                         style="flex:1;height:${Math.max(count ? 3 : 0, (count / peak) * 100).toFixed(1)}%;
                                background:${i === d.bins.length - 1 ? CURVES[0].color : "var(--mask-text)"};
                                border-radius:2px 2px 0 0;opacity:${count ? 1 : 0.15}"></div>`;
          }).join("")}
        </div>
        <div title="mean ${pct(d.mean, 1)}%"
             style="position:absolute;top:0;bottom:0;left:${meanAt.toFixed(1)}%;width:1px;
                    background:var(--text-tertiary)"></div>
      </div>
      <div style="position:relative;font-size:11px;color:var(--text-secondary);margin-top:4px;height:14px">
        <span style="position:absolute;left:0">worst ${pct(d.min, 1)}%</span>
        <span style="position:absolute;right:0">best ${pct(d.max, 1)}%</span>
      </div>
      <div class="sub" style="font-size:11px;margin:2px 0 0">mean ${pct(d.mean, 1)}%</div>
      <div class="sub" style="font-size:12px;margin-top:6px">
        ${spread < 0.02
          ? `A span of only ${pct(spread, 1)} points between the best and worst sequence — for these
             attacks the order barely matters, so spend the effort elsewhere.`
          : `${pct(spread, 1)} points separate the best sequence from the worst, so the choice is
             worth making deliberately.`}
      </div>`;
  }

  function signaturesHtml(r) {
    const n = "text-align:right;font-variant-numeric:tabular-nums";
    return `
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px;min-width:420px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">Found by</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Passwords</th>
          <th style="padding:4px 0;font-weight:500;${n}">Share of haul</th>
        </tr></thead>
        <tbody>
          ${r.signatures.map((s) => `
            <tr>
              <td style="padding:5px 12px 5px 0">
                ${s.labels.map((l) => `<code style="background:var(--surface-2);border-radius:4px;
                                        padding:1px 6px;margin-right:4px">${esc(l)}</code>`).join("")}
                ${s.labels.length === 1 ? `<span class="sub" style="font-size:11px;margin:0">only</span>` : ""}
              </td>
              <td style="padding:5px 12px 5px 0;${n}">${num(s.count)}</td>
              <td style="padding:5px 0;${n}">${pct(s.share, 1)}%</td>
            </tr>`).join("")}
        </tbody>
      </table></div>`;
  }

  function rankingHtml(r) {
    const n = "text-align:right;font-variant-numeric:tabular-nums";
    const C = costCtx(r);
    return `
      <div style="overflow:auto"><table style="border-collapse:collapse;font-size:12px;min-width:560px">
        <thead><tr style="color:var(--text-secondary);text-align:left">
          <th style="padding:4px 12px 4px 0;font-weight:500">#</th>
          <th style="padding:4px 12px 4px 0;font-weight:500">Sequence</th>
          <th style="padding:4px 12px 4px 0;font-weight:500;${n}">Half the haul by</th>
          <th style="padding:4px 0;font-weight:500;${n}">Score</th>
        </tr></thead>
        <tbody>
          ${r.top.map((e, i) => `
            <tr style="${i === 0 ? "background:var(--surface-2)" : ""}">
              <td style="padding:5px 12px 5px 0;color:var(--text-tertiary)">${i + 1}</td>
              <td style="padding:5px 12px 5px 0">${e.order.map(esc).join(" → ")}</td>
              <td style="padding:5px 12px 5px 0;${n}">${C.fmt(halfOf(e))}${C.guesses ? " guesses" : ""}</td>
              <td style="padding:5px 0;${n}">${i === 0 ? "<b>" : ""}${pct(e.efficiency, 1)}%${i === 0 ? "</b>" : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>`;
  }

  // ── chart ────────────────────────────────────────────────────────────────
  function drawCurve(r, showProfile) {
    const canvas = resultBox.querySelector("#or-curve");
    if (!canvas || typeof Chart === "undefined") return null;
    const C = costCtx(r);

    // Node markers: (0, 0) then one point per finished attack — always measured,
    // always the only hoverable points (see the caption's hover note).
    const nodesOf = (o) =>
      [{ x: 0, y: 0 }].concat(o.steps.map((s) => ({ x: C.cum(s), y: s.cumulative, _step: s })));

    // The dense within-attack path. Each step follows its measured order-aware
    // profile (cumulative NEW cracks, whose last value equals the step's gain, so
    // the curve lands on the measured node with no rescaling) or, with no profile,
    // draws the straight segment to its node.
    const profileOf = (o) => {
      const data = [{ x: 0, y: 0 }];
      let cumStart = 0;
      for (const s of o.steps) {
        const cumEnd = C.cum(s);
        const span = C.one(s);
        const p = usableProfile(s.recovery_profile);
        if (p && span != null) {
          const cumBefore = s.cumulative - s.gain;
          for (let j = 0; j < p.length; j++) {
            data.push({ x: cumStart + ((j + 1) / p.length) * span, y: cumBefore + p[j] });
          }
        } else {
          data.push({ x: cumEnd, y: s.cumulative });
        }
        cumStart = cumEnd;
      }
      return data;
    };

    const datasets = CURVES.filter((c) => r[c.key]).flatMap((c) => {
      const o = r[c.key];
      const line = {
        borderColor: c.color,
        backgroundColor: c.color,
        borderWidth: c.key === "best" ? 2.5 : 1.5,
        borderDash: c.key === "greedy" ? [5, 4] : [],
        tension: 0,
      };
      if (!showProfile) {
        // Single dataset: straight segments between measured nodes — the model
        // the score integrates — with the nodes themselves hoverable.
        return [{ ...line, label: c.label, data: nodesOf(o), tangible: true, pointRadius: 3, pointHitRadius: 10, pointHoverRadius: 5 }];
      }
      // Profile on: a non-hittable measured line plus a line-less node layer, so
      // hover still lands only on step boundaries. The node layer has no legend
      // text (`label: ""`) but carries `_curve` so its tooltip names the curve.
      return [
        { ...line, label: c.label, data: profileOf(o), tangible: false, pointRadius: 0, pointHitRadius: 0, pointHoverRadius: 0 },
        { ...line, label: "", _curve: c.label, data: nodesOf(o), tangible: true, showLine: false, pointRadius: 3, pointHitRadius: 10, pointHoverRadius: 5 },
      ];
    });

    const chart = new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "point", intersect: false },
        plugins: {
          legend: { labels: { color: cssVar("--text-secondary"), usePointStyle: true, filter: (i) => !!i.text } },
          tooltip: {
            filter: (item) => item.dataset.tangible === true,
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                return `after ${C.fmt(items[0].parsed.x)}${C.guesses ? " guesses" : ""}`
              },
              label: (ctx) => {
                const name = ctx.dataset.label || ctx.dataset._curve || "";
                const step = ctx.raw?._step;
                if (!step) return `${name}: nothing yet`;
                return `${name}: ${esc(step.label)} done — ` +
                  `${num(step.cumulative)} recovered (${pct(step.cumulative_coverage, 1)}% of goal)`;
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: 0,
            title: { display: true, text: C.xTitle, color: cssVar("--text-secondary") },
            ticks: { color: cssVar("--text-secondary"), callback: (v) => C.fmt(v) },
            grid: { color: cssVar("--surface-3") },
          },
          y: {
            beginAtZero: true,
            title: { display: true, text: "passwords recovered", color: cssVar("--text-secondary") },
            ticks: { color: cssVar("--text-secondary"), callback: (v) => num(v) },
            grid: { color: cssVar("--surface-3") },
          },
        },
      },
    });
    charts.push(chart);
    return chart;
  }

  // Efficiency = the slope of the cumulative curve: new passwords per unit cost.
  // With `showProfile` off it is one flat step per attack (its total cracks over
  // its total cost); on, it is the measured within-attack rate from crack_pos —
  // a faint raw per-bucket line plus a bold rolling average. The Y axis starts
  // log (see #or-eff-log) so the fall from "cheap early cracks" to "millions of
  // guesses per crack" in the tail is legible. Returns the chart for the toggles.
  function drawEfficiency(r, showProfile) {
    const canvas = resultBox.querySelector("#or-eff");
    if (!canvas || typeof Chart === "undefined") return null;
    const C = costCtx(r);
    // Rebuilding on a profile toggle must preserve the log/linear choice, so the
    // initial axis is read from the checkbox rather than hard-coded.
    const logY = resultBox.querySelector("#or-eff-log")?.checked ?? true;

    // Default (profile off): one flat step per attack — its total cracks over its
    // total cost — as a staircase whose corner points are hoverable.
    const flatStairs = (o) => {
      const data = [];
      let cumStart = 0;
      for (const s of o.steps) {
        const cumEnd = C.cum(s);
        // Zero-gain steps have no rate to plot; null + spanGaps skips them on a
        // log axis (where 0 has no position) and leaves no stray point on linear.
        const rate = C.gainRate(s) || null;
        data.push({ x: cumStart, y: rate, _step: s });
        data.push({ x: cumEnd, y: rate, _step: s });
        cumStart = cumEnd;
      }
      return data;
    };

    // Profile on: the measured within-attack rate (raw and rolling-averaged) from
    // the per-bucket order-aware crack_pos derivative; a step with no profile
    // falls back to a flat segment. `raw` and `smooth` share x positions.
    const profileRates = (o) => {
      const raw = [], smooth = [];
      let cumStart = 0;
      for (const s of o.steps) {
        const cumEnd = C.cum(s);
        const span = C.one(s);
        const p = usableProfile(s.recovery_profile);
        if (p && span != null) {
          const w = span / p.length;
          const rates = [];
          let prev = 0;
          for (let j = 0; j < p.length; j++) {
            // p is cumulative NEW cracks, so p[j]-prev is this bucket's new cracks.
            rates.push((p[j] - prev) / w);
            prev = p[j];
          }
          const sm = rollingAvg(rates, EFF_SMOOTH);
          for (let j = 0; j < p.length; j++) {
            const x = cumStart + ((j + 0.5) / p.length) * span;
            raw.push({ x, y: rates[j] || null });
            smooth.push({ x, y: sm[j] || null });
          }
        } else {
          const rate = C.gainRate(s) || null;
          raw.push({ x: cumStart, y: rate }, { x: cumEnd, y: rate });
          smooth.push({ x: cumStart, y: rate }, { x: cumEnd, y: rate });
        }
        cumStart = cumEnd;
      }
      return { raw, smooth };
    };

    const datasets = CURVES.filter((c) => r[c.key]).flatMap((c) => {
      const o = r[c.key];
      const line = {
        borderColor: c.color,
        backgroundColor: c.color,
        borderWidth: c.key === "best" ? 2.5 : 1.5,
        borderDash: c.key === "greedy" ? [5, 4] : [],
        spanGaps: true,
        tension: 0,
      };
      if (!showProfile) {
        return [{ ...line, label: c.label, tangible: true, data: flatStairs(o), pointRadius: 0, pointHitRadius: 10, pointHoverRadius: 4 }];
      }
      const { raw, smooth } = profileRates(o);
      // Node markers at each step boundary carry the step summary and are the only
      // hoverable points; raw and smooth lines are drawn but not hittable.
      const nodes = o.steps.map((s) => ({ x: C.cum(s), y: C.gainRate(s) || null, _step: s }));
      return [
        { ...line, label: "", tangible: false, borderColor: c.color + "55", borderWidth: 1, borderDash: [], data: raw, pointRadius: 0, pointHitRadius: 0, pointHoverRadius: 0 },
        { ...line, label: c.label, tangible: false, data: smooth, pointRadius: 0, pointHitRadius: 0, pointHoverRadius: 0 },
        { ...line, label: "", tangible: true, _curve: c.label, data: nodes, showLine: false, pointRadius: 3, pointHitRadius: 10, pointHoverRadius: 5 },
      ];
    });

    const chart = new Chart(canvas, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "point", intersect: false },
        plugins: {
          legend: { labels: { color: cssVar("--text-secondary"), usePointStyle: true, filter: (i) => !!i.text } },
          tooltip: {
            filter: (item) => item.dataset.tangible === true,
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                return `after ${C.fmt(items[0].parsed.x)}${C.guesses ? " guesses" : ""}`
              },
              label: (ctx) => {
                const name = ctx.dataset.label || ctx.dataset._curve || "";
                const step = ctx.raw?._step;
                if (!step) return name;
                return `${name}: ${esc(step.label)} — ` +
                  `${C.rateFmt(C.gainRate(step))} (${num(step.gain)} new)`;
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: 0,
            title: { display: true, text: C.xTitle, color: cssVar("--text-secondary") },
            ticks: { color: cssVar("--text-secondary"), callback: (v) => C.fmt(v) },
            grid: { color: cssVar("--surface-3") },
          },
          y: {
            // Initial axis follows #or-eff-log (checked = log by default), so a
            // profile rebuild keeps whatever the user last chose.
            type: logY ? "logarithmic" : "linear",
            beginAtZero: !logY,
            title: {
              display: true,
              text: `recovery per ${C.guesses ? "guess" : "second"}`,
              color: cssVar("--text-secondary"),
            },
            ticks: { color: cssVar("--text-secondary"), callback: (v) => C.rateFmt(v) },
            grid: { color: cssVar("--surface-3") },
          },
        },
      },
    });
    charts.push(chart);
    return chart;
  }

  // ── polling ──────────────────────────────────────────────────────────────
  function poll() {
    setTimeout(async () => {
      if (!alive.isConnected) {
        for (const c of charts) c.destroy();
        charts = [];
        return;
      }
      await jobs.refresh();
      // A finished job never changes again, so stop re-fetching it — and stop
      // tearing down and rebuilding its chart every few seconds.
      const done = resultBox.querySelector("[data-ordering-done]");
      if (jobId && !done) await renderResult(jobId);
      poll();
    }, POLL_MS);
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Natural units for a recovery rate, matching the house rule for time: a slow
// brute force can easily sit well under one password per second, where a
// rounded "0/s" would read as "found nothing".
function rate(v) {
  if (v == null || !isFinite(v) || v <= 0) return "—";
  if (v >= 10) return `${Math.round(v).toLocaleString()}/s`;
  if (v >= 1) return `${v.toFixed(1)}/s`;
  if (v * 60 >= 1) return `${(v * 60).toFixed(v * 60 >= 10 ? 0 : 1)}/min`;
  return `${(v * 3600).toFixed(v * 3600 >= 10 ? 0 : 1)}/h`;
}

// A step's order-aware recovery profile (cumulative NEW cracks over 64 even
// buckets of the attack's keyspace), or null when there is nothing to shape — an
// `--increment`/multi-step attack, an old result, or an all-zero curve.
function usableProfile(p) {
  if (!Array.isArray(p) || !p.length) return null;
  return p[p.length - 1] ? p : null;
}

// Centred moving average, used to smooth the spiky per-bucket efficiency rate.
function rollingAvg(values, window) {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k];
      n++;
    }
    return n ? sum / n : 0;
  });
}

// Compact guess counts, since a real mask is millions to trillions of
// candidates: 456,976 → "457K", 11,900,000 → "11.9M".
function guessFmt(n) {
  if (n == null) return "—";
  n = Number(n);
  if (n < 1000) return n.toLocaleString();
  for (const [base, suf] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (n >= base) {
      const v = n / base;
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${suf}`;
    }
  }
  return n.toLocaleString();
}

// Recovered-per-guess rate. For anything but a tiny wordlist this is far below
// one, so "1 per N guesses" reads better than "0.00003/guess".
function perGuess(v) {
  if (v == null || !isFinite(v) || v <= 0) return "—";
  if (v >= 1) return `${v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1)}/guess`;
  return `1 per ${guessFmt(Math.round(1 / v))} guesses`;
}

// The axis a result is scored on, with the readers and formatters its tables
// and chart need. Results stored before this change have no `cost_axis` and
// lack the generic `cost` fields, so everything falls back to the duration
// fields they do have — they keep rendering in seconds exactly as before.
function costCtx(r) {
  const axis = r.cost_axis || "time";
  const guesses = axis === "guesses";
  return {
    axis,
    guesses,
    total: guesses ? r.total_guesses : r.total_runtime_s,
    fmt: guesses ? guessFmt : duration,
    rateFmt: guesses ? perGuess : rate,
    // Per-step cost, cumulative cost, new-per-cost; milestone cost.
    one: (s) => s.cost ?? s.duration_s,
    cum: (s) => s.cumulative_cost ?? s.elapsed_s,
    gainRate: (s) => s.gain_per_cost ?? s.gain_rate,
    ms: (m) => m?.cost ?? m?.time_s,
    // Words for column headers and captions.
    noun: guesses ? "guesses" : "time",
    takesCol: guesses ? "Guesses" : "Takes",
    rateCol: guesses ? "New / guess" : "New rate",
    xTitle: guesses ? "guesses" : "elapsed",
  };
}
