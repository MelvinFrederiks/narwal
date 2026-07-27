// Home — landing scene. Layout from data/mockups/narwal-home-12.html:
//
//   ┌───────────────────────────────────────────────────────────┐
//   │ HERO (full width)                                          │
//   │  rainbow headline · tagline · 3-up stats strip · CTAs      │
//   ├───────────────────────────────────────────────────────────┤
//   │ Workflow · 9 steps  (auto-wrap card grid)                  │
//   ├───────────────────────────────────────────────────────────┤
//   │ Methodology anchors                                         │
//   └───────────────────────────────────────────────────────────┘
//
// The scoreboard sticker rack lived here in v9 but moved to the nav
// (the overlapping stack is always visible there now). The "how Narwal
// reports savings — one number, one unit" clarify card lives in the
// Architecture glossary now, not as a banner on home.

import { getStickerState } from "../util/stickers.js";
import { mountMascot } from "../util/mascot.js";

export const name = "home";

// 9 storyboard cards. `reward: true` flags steps that award a Polar-
// Unicorn sticker (kept in sync with bumpSticker call sites + the
// finish button each scene mounts).
const STEPS = [
  { id: "setup",         title: "1 · Setup",            icon: iconCheckList,
    body: `Pick reference corpora, drop a target hashlist, and choose a cluster
           spec. Selections persist across scenes.` },
  { id: "coverage",      title: "2 · Coverage",         icon: iconChartBars,
    body: `Cumulative mask coverage per Van Heijningen 2013, fig. O.2. The
           budget kink marks where adding more masks stops paying.` },
  { id: "compare",       title: "3 · Compare",          icon: iconChartLines,
    body: `All selected datasets on locked axes. Reveals cross-cultural
           distribution differences (MAYA §4.2).` },
  { id: "mergeability",  title: "3b · Mergeability",    icon: iconMerge,
    body: `Which guessers are worth combining. MAYA RQ6.1 mergeability index —
           the extra coverage gained by merging one model's cracks into a
           stronger one's. 0 = redundant, higher = complementary. Narwal reads
           the FLA row: what each model adds on top of FLA.` },
  { id: "heatmap",       title: "4 · Heatmap",          icon: iconGrid,
    body: `Per-position character frequency. Vowels-early = natural-language;
           digit dominance = PIN-style; shifted shapes hint at Cyrillic input.` },
  { id: "overlap-2",     title: "5 · Overlap · pair",   icon: iconVenn,
    body: `Drag any two attacks into the slots. Venn + verdict update live —
           red = redundant, amber = partial, green = complementary.` },
  { id: "overlap-many",  title: "5b · Overlap · network", icon: iconNetwork,
    body: `All attacks at once as a force-directed graph. Spring length ∝
           1 − Jaccard so redundant attacks cluster; thick edges = high overlap.
           Drag nodes; click an edge for the pair detail.` },
  { id: "cluster",       title: "6 · Cluster",          icon: iconScatter,
    body: `UMAP projection of dataset feature vectors into three regions —
           consumer leaks, corporate, high-entropy. Same-region corpora
           respond similarly to the same attacks.` },
  { id: "compose",       title: "7 · Compose",          icon: iconStack,   reward: true,
    body: `Now that you understand the data, build a pipeline: click attacks
           from the library. Per-step residual yield and budget meter update
           live.` },
  { id: "verdict",       title: "8 · Verdict",          icon: iconCheckSeal, reward: true,
    body: `Strongest / weakest reference + a ranked attack chain. One-click
           export to a Hashtopolis v2 supertask JSON (preview only).` },
  { id: "architecture",  title: "9 · Architecture",     icon: iconBlueprint,
    body: `How the sidecar fits next to Hashtopolis. Bridge is preview-only —
           Narwal plans, Hashtopolis executes.` },
];

export function render(mount) {
  const state = getStickerState();
  // Numbers in the stats strip are placeholders for v1. Real wiring will
  // come from a /api/savings/summary endpoint plus a per-step accumulator
  // alongside cra-stickers state. For now: sticker count is live, the
  // hh-days saved and current step % are dressed-up demo values.
  const stickerCount = state.steps;
  const currentPct   = state.currentPct != null ? Math.round(state.currentPct * 100) : null;
  const hhSaved      = "14.2";   // TODO: real running total

  mount.innerHTML = `
    <div class="home-hero">
      <div class="home-hero-text">
        <h1 class="home-headline">Narwal: Plan the attack. Save polar bears.</h1>
        <p class="home-tagline">
          Narwal turns brute GPU-hours into ranked, deduplicated attack chains.
          Every redundant attack you skip saves real <strong>energy</strong> —
          your cluster eats <strong>3.6 kW</strong> when it's hashing.
          <span class="nobreak">Narwal plans; <strong>Hashtopolis cracks</strong>.</span>
        </p>

        <div class="home-stats">
          <div class="stat savings">
            <div class="stat-val">${hhSaved}<span class="unit">household-days</span></div>
            <div class="stat-label">saved · this quarter</div>
          </div>
          <div class="stat stickers">
            <div class="stat-val">${stickerCount}<span class="unit">/ ∞</span></div>
            <div class="stat-label">stickers · keep cracking</div>
          </div>
          <div class="stat">
            <div class="stat-val">${currentPct != null ? currentPct : "—"}<span class="unit">${currentPct != null ? "%" : ""}</span></div>
            <div class="stat-label">${currentPct != null ? "current step · in progress" : "no step in progress"}</div>
          </div>
        </div>

        <div class="home-cta-row">
          <a class="cta primary" href="#setup">
            Start with Setup
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 6h6m-3-3l3 3-3 3" stroke="currentColor" stroke-width="1.6"
                    stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            </svg>
          </a>
          <a class="cta" href="#architecture">See the architecture</a>
        </div>
      </div>

      <!-- Big hero mascot. This is a *second* iframe instance — the nav
           one is intentionally separate so it can stay dimmed on home
           while this one bobs. Both read the same sessionStorage pause
           key, so middle-clicking either pauses both. -->
      <div class="home-hero-mascot" id="hero-mascot-slot"></div>
    </div>

    <section class="home-grid-section">
      <h2 class="home-grid-heading">Workflow · 9 steps</h2>
      <div class="home-grid">
        ${STEPS.map(stepCard).join("")}
      </div>
    </section>

    <div class="home-refs">
      <h3>Methodology anchors</h3>
      <ul>
        <li><strong>Van Heijningen 2013</strong> — Appendix O.2 cumulative-mask
            curve and per-position frequency heatmaps. Row 25 (?l×8 ?d×2)
            = 67.19 % cumulative coverage.</li>
        <li><strong>MAYA / Corrias et al. 2026</strong> — Table 2 dataset set
            (8 leaks), cleaning conventions via demeuk, cross-cultural
            distribution findings, and the RQ6.1 mergeability index for
            model complementarity.</li>
        <li><strong>Norvig / Mayzner 2012</strong> — English letter-frequency
            reference for the natural-language baseline in the heatmap.</li>
      </ul>
    </div>

    <style>${css()}</style>
  `;

  const heroSlot = mount.querySelector("#hero-mascot-slot");
  if (heroSlot) mountMascot(heroSlot, { alwaysAnimated: true });
}

// ── Step card ───────────────────────────────────────────────────────────────

function stepCard(s) {
  const reward = s.reward
    ? `<span class="home-card-reward" title="completes one Polar-Unicorn sticker">+1 sticker</span>`
    : "";
  return `
    <a class="home-card" href="#${s.id}">
      <div class="home-ico">${s.icon()}</div>
      <div>
        <div class="home-card-title">${s.title}${reward}</div>
        <div class="home-card-body">${s.body}</div>
      </div>
    </a>
  `;
}

// ── Styles ──────────────────────────────────────────────────────────────────

function css() {
  return `
    /* ── Hero ───────────────────────────────────────────────────────── */
    .home-hero {
      background: var(--surface);
      border: 0.5px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 36px 36px 28px;
      margin-bottom: 16px;
      box-shadow: var(--shadow-sm);
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 28px;
      align-items: start;
    }
    .home-hero-text { min-width: 0; }
    .home-hero-mascot {
      --nrw-mascot-size: 180px;
      width: 180px; height: 180px;
      flex: 0 0 180px;
      align-self: start;
    }
    .home-headline {
      font-size: 36px; font-weight: 600; letter-spacing: -0.4px;
      line-height: 1.08; margin: 0 0 6px;
      /* Full-rainbow gradient — echoes the mascot's hair. Same stops top
         and bottom so wrapping doesn't shift the colours. */
      background: linear-gradient(90deg,
        #ff77c6 0%, #ff6b6b 16%, #ffb077 32%, #ffd96a 48%,
        #87e57a 64%, #4dc6e8 80%, #b76ce0 100%);
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
    }
    .home-tagline {
      color: var(--text-secondary); font-size: 15px; line-height: 1.55;
      margin: 0 0 22px;
      max-width: 960px;
      text-wrap: pretty;
    }
    .home-tagline strong { color: var(--text); font-weight: 600; }
    .home-tagline .nobreak { white-space: nowrap; }

    .home-stats {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
      margin: 0 0 24px;
    }
    .home-stats .stat {
      padding: 14px 16px;
      background: var(--surface-2);
      border: 0.5px solid var(--surface-3);
      border-radius: var(--radius-md);
    }
    .home-stats .stat-val {
      font-size: 22px; font-weight: 600; line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }
    .home-stats .stat-val .unit {
      font-size: 12px; color: var(--text-secondary); font-weight: 500;
      margin-left: 4px;
    }
    .home-stats .stat-label {
      font-size: 11px; letter-spacing: 0.5px;
      text-transform: uppercase; color: var(--text-tertiary);
      margin-top: 4px;
    }
    .home-stats .stat.savings .stat-val { color: var(--success-text); }
    .home-stats .stat.stickers .stat-val { color: var(--warning-text); }

    .home-cta-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .home-cta-row .cta {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 10px 18px;
      border-radius: var(--radius-md); text-decoration: none;
      font-weight: 500; font-size: 14px;
      border: 1px solid var(--surface-3); color: var(--text); background: var(--surface);
    }
    .home-cta-row .cta.primary {
      background: var(--info-bg); color: var(--info-text); border-color: var(--info-border);
    }
    .home-cta-row .cta:hover { background: var(--surface-2); }
    .home-cta-row .cta.primary:hover { filter: brightness(0.95); }
    .home-cta-row .cta svg { width: 14px; height: 14px; }

    /* ── Storyboard grid ─────────────────────────────────────────────── */
    .home-grid-section { margin-bottom: 16px; }
    .home-grid-heading {
      font-size: 13px; font-weight: 500;
      letter-spacing: 0.4px; text-transform: uppercase;
      color: var(--text-tertiary); margin: 8px 4px 12px;
    }
    .home-grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    }
    .home-card {
      background: var(--surface); border: 0.5px solid var(--border);
      border-radius: var(--radius-md); padding: 14px 16px;
      display: flex; gap: 12px;
      text-decoration: none; color: var(--text);
      transition: transform 0.1s ease, border-color 0.1s ease;
    }
    .home-card:hover { transform: translateY(-1px); border-color: var(--info-border); }
    .home-ico {
      width: 36px; height: 36px; border-radius: 50%;
      background: linear-gradient(180deg, #e4eef9, #d3e3f4);
      display: flex; align-items: center; justify-content: center;
      flex: 0 0 36px; color: var(--info-text);
    }
    :root[data-theme="dark"] .home-ico,
    :root:not([data-theme="light"]) .home-ico {
      background: linear-gradient(180deg, #1b2a3a, #15202c);
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) .home-ico {
        background: linear-gradient(180deg, #e4eef9, #d3e3f4);
      }
    }
    .home-ico svg { width: 20px; height: 20px; }
    .home-card-title {
      font-weight: 500; font-size: 14px; margin-bottom: 4px;
      display: flex; align-items: center; gap: 8px;
    }
    .home-card-body { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
    .home-card-reward {
      font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
      letter-spacing: 0.3px; text-transform: uppercase;
      background: rgba(255,217,106,0.18);
      color: #BA7517;
      border: 1px solid rgba(186,117,23,0.35);
    }
    :root[data-theme="dark"] .home-card-reward,
    :root:not([data-theme="light"]) .home-card-reward {
      background: rgba(255,217,106,0.10);
      color: #FAC775;
      border: 1px solid rgba(255,217,106,0.30);
    }

    /* ── Methodology refs ────────────────────────────────────────────── */
    .home-refs {
      margin-top: 16px;
      padding: 16px 18px;
      background: var(--surface);
      border: 0.5px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text-secondary); font-size: 12px; line-height: 1.6;
    }
    .home-refs h3 {
      margin: 0 0 8px; color: var(--text);
      font-size: 13px; font-weight: 500;
    }
    .home-refs ul { margin: 0; padding-left: 18px; }
    .home-refs strong { color: var(--text); }

    @media (max-width: 820px) {
      .home-hero {
        padding: 24px 22px;
        grid-template-columns: 1fr;
      }
      .home-hero-mascot {
        --nrw-mascot-size: 120px;
        width: 120px; height: 120px;
        justify-self: end;
      }
      .home-headline { font-size: 28px; }
      .home-stats { grid-template-columns: 1fr; }
    }
  `;
}

// ── Inline icons (24×24, stroke=currentColor) ───────────────────────────────

function svg(inner) {
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
}
function iconCheckList() {
  return svg(`
    <rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.6"/>
    <path d="M15 16l1.4 1.4L19 14.6" stroke="currentColor" stroke-width="1.6" fill="none"/>
  `);
}
function iconChartBars() {
  return svg(`
    <path d="M4 21V3M4 21h16" stroke="currentColor" stroke-width="1.6"/>
    <rect x="7"  y="14" width="2.6" height="6"  stroke="currentColor" stroke-width="1.4" fill="none"/>
    <rect x="11" y="10" width="2.6" height="10" stroke="currentColor" stroke-width="1.4" fill="none"/>
    <rect x="15" y="6"  width="2.6" height="14" stroke="currentColor" stroke-width="1.4" fill="none"/>
  `);
}
function iconChartLines() {
  return svg(`
    <path d="M4 21V3M4 21h16" stroke="currentColor" stroke-width="1.6"/>
    <path d="M5 17l4-5 4 2 6-7" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <path d="M5 14l4 1 4-3 6-2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-dasharray="3 2"/>
  `);
}
function iconGrid() {
  return svg(`
    <rect x="3" y="3" width="18" height="18" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <path d="M9 3v18M15 3v18M3 9h18M3 15h18" stroke="currentColor" stroke-width="1.2"/>
    <rect x="9" y="9" width="6" height="6" fill="currentColor" opacity="0.25"/>
  `);
}
function iconVenn() {
  return svg(`
    <circle cx="10" cy="12" r="6" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <circle cx="14" cy="12" r="6" stroke="currentColor" stroke-width="1.6" fill="none"/>
  `);
}
function iconMerge() {
  return svg(`
    <circle cx="6"  cy="6"  r="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
    <circle cx="6"  cy="18" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
    <circle cx="18" cy="12" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
    <path d="M8 6.8C13 8 15 9.6 16.2 11M8 17.2C13 16 15 14.4 16.2 13"
          stroke="currentColor" stroke-width="1.4" fill="none"/>
  `);
}
function iconNetwork() {
  return svg(`
    <circle cx="5"  cy="6"  r="2" stroke="currentColor" stroke-width="1.4" fill="none"/>
    <circle cx="19" cy="6"  r="2" stroke="currentColor" stroke-width="1.4" fill="none"/>
    <circle cx="12" cy="13" r="2" stroke="currentColor" stroke-width="1.4" fill="none"/>
    <circle cx="6"  cy="19" r="2" stroke="currentColor" stroke-width="1.4" fill="none"/>
    <circle cx="18" cy="19" r="2" stroke="currentColor" stroke-width="1.4" fill="none"/>
    <path d="M6.4 7.4l4.6 4.6M17.6 7.4L13 12M11.2 14.3L7.3 17.6M12.8 14.3L17 17.6"
          stroke="currentColor" stroke-width="1.2" fill="none"/>
  `);
}
function iconScatter() {
  return svg(`
    <path d="M4 21V3M4 21h16" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="8"  cy="15" r="1.5" fill="currentColor"/>
    <circle cx="11" cy="10" r="2"   fill="currentColor"/>
    <circle cx="16" cy="13" r="1.2" fill="currentColor"/>
    <circle cx="18" cy="7"  r="1.6" fill="currentColor"/>
  `);
}
function iconStack() {
  return svg(`
    <path d="M12 3 3 8l9 5 9-5-9-5z" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <path d="M3 13l9 5 9-5"          stroke="currentColor" stroke-width="1.6" fill="none"/>
    <path d="M3 17l9 5 9-5"          stroke="currentColor" stroke-width="1.6" fill="none"/>
  `);
}
function iconCheckSeal() {
  return svg(`
    <path d="M12 2l2.5 1.5L17 3l1 2.5L20.5 7 20 10l1.5 2.5L20 15l.5 3-2.5 1L17 21l-2.5-1L12 22l-2.5-2L7 21l-1-2L3.5 18 4 15l-1.5-2.5L4 10l-.5-3L6 5.5 7 3l2.5.5L12 2z"
          stroke="currentColor" stroke-width="1.4" fill="none"/>
    <path d="M8.5 12l2.5 2.5L16 9.5" stroke="currentColor" stroke-width="1.8" fill="none"/>
  `);
}
function iconBlueprint() {
  return svg(`
    <rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/>
    <path d="M3 8h18M7 12h6M7 16h10" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="17" cy="12" r="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/>
  `);
}
