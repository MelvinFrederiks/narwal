// Polar-Unicorn sticker collection — one sticker per completed step.
//
// State lives in localStorage["nrw-stickers"] = {
//   steps: number,                // total stickers earned (won)
//   history: [{label, ts}],       // up to last 64 step labels (for tooltips)
//   currentLabel: string | null,  // step in progress (drives the ring slot)
//   currentPct:   0..1   | null,  // its completion fraction
// }
//
// renderStickerStack(el, opts?) paints an overlapping stack of polar-unicorn
// stickers into `el`. Three states per slot: won (full colour + warm ring),
// progress-slot (dim unicorn + conic ring), locked (silhouette).
//
// bumpSticker(label?) records one completed step and re-renders any stacks
// currently mounted in the page (via a CustomEvent).
//
// setStickerProgress(label, pct) sets the in-progress slot. pct in [0,1].
//
// CSS is injected once.

const KEY = "nrw-stickers";
const EVENT = "nrw-stickers-changed";
const ASSET = "/assets/sticker-polar-unicorn.png";

const DEFAULTS = {
  // Visible window: at most this many won stickers are rendered as-is; older
  // ones collapse into a "+N" pill at the start of the stack.
  visibleWon: 5,
  // Number of locked silhouette slots to show *after* the in-progress (or
  // after the won list, if no in-progress).
  lockedAfter: 3,
  // Size in pixels per sticker (square).
  size: 24,
  // Overlap amount (negative margin between adjacent stickers).
  overlap: 10,
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { steps: 0, history: [], currentLabel: null, currentPct: null };
    const v = JSON.parse(raw);
    return {
      steps: typeof v.steps === "number" ? v.steps : 0,
      history: Array.isArray(v.history) ? v.history.slice(-64) : [],
      currentLabel: v.currentLabel || null,
      currentPct: typeof v.currentPct === "number" ? v.currentPct : null,
    };
  } catch (_) {
    return { steps: 0, history: [], currentLabel: null, currentPct: null };
  }
}

function write(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  document.dispatchEvent(new CustomEvent(EVENT, { detail: state }));
}

export function getStickerState() { return read(); }

// bumpSticker accepts either a plain label string or {label, sceneId}.
// The sceneId is stored so the nav-link badge decorator can mark exactly
// which step was finished. The state stays backward-compatible: history
// entries without a sceneId simply don't decorate a link.
export function bumpSticker(arg) {
  let label, sceneId;
  if (arg && typeof arg === "object") {
    label = arg.label; sceneId = arg.sceneId || null;
  } else {
    label = arg; sceneId = null;
  }
  const s = read();
  s.steps += 1;
  s.history.push({ label: label || `step ${s.steps}`, sceneId, ts: Date.now() });
  if (s.history.length > 64) s.history = s.history.slice(-64);
  // Completing a step clears any "in progress" slot.
  s.currentLabel = null;
  s.currentPct = null;
  write(s);
  return s;
}

// Set of scene ids that have at least one earned sticker. Used by the nav
// to badge the matching link.
export function earnedSceneIds() {
  const s = read();
  return new Set(s.history.map((h) => h && h.sceneId).filter(Boolean));
}

export function setStickerProgress(label, pct) {
  const s = read();
  s.currentLabel = label || null;
  s.currentPct = (typeof pct === "number") ? Math.max(0, Math.min(1, pct)) : null;
  write(s);
}

export function resetStickers() {
  write({ steps: 0, history: [], currentLabel: null, currentPct: null });
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderStickerStack(el, opts = {}) {
  if (!el) return;
  const cfg = { ...DEFAULTS, ...opts };
  const state = read();
  el.classList.add("nrw-stickers");
  el.style.setProperty("--ns-size", `${cfg.size}px`);
  el.style.setProperty("--ns-overlap", `${cfg.overlap}px`);

  const html = [];

  // Collapsed "+N" pill if we have more wins than the visible window.
  const extra = Math.max(0, state.steps - cfg.visibleWon);
  if (extra > 0) {
    html.push(`<span class="ns-extra" title="${extra} earlier sticker${extra === 1 ? "" : "s"}">+${extra}</span>`);
  }

  // Visible won slots — youngest at the right. Tooltip = the step's name
  // (not a sequential number — users care about *which* step they finished).
  const wonCount = Math.min(state.steps, cfg.visibleWon);
  const recent = state.history.slice(-wonCount);
  for (let i = 0; i < wonCount; i++) {
    const meta = recent[i] || { label: "step" };
    html.push(`<div class="ns won" title="${esc(meta.label)}"><img src="${ASSET}" alt=""/></div>`);
  }

  // In-progress slot, if any.
  if (state.currentLabel && state.currentPct != null) {
    const pct = Math.round(state.currentPct * 100);
    const tip = `${esc(state.currentLabel)} (${pct} %) — in progress`;
    html.push(`
      <div class="ns progress-slot" title="${tip}"
           style="--ns-progress: ${pct}%">
        <img src="${ASSET}" alt=""/>
        <span class="ring" aria-hidden="true"></span>
        <span class="pct">${pct}%</span>
      </div>
    `);
  }

  // Locked silhouette slots.
  for (let i = 0; i < cfg.lockedAfter; i++) {
    const next = state.steps + (state.currentLabel ? 1 : 0) + i + 1;
    html.push(`<div class="ns locked" title="step ${next} — locked"><img src="${ASSET}" alt=""/></div>`);
  }

  el.innerHTML = html.join("");
}

// Mount + live-update: re-renders on any nrw-stickers-changed event.
export function mountStickerStack(el, opts = {}) {
  renderStickerStack(el, opts);
  const onChange = () => renderStickerStack(el, opts);
  document.addEventListener(EVENT, onChange);
  return () => document.removeEventListener(EVENT, onChange);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── One-time stylesheet injection ────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById("nrw-stickers-styles")) return;
  const css = `
    .nrw-stickers {
      display: inline-flex; align-items: center;
      padding: 0; background: none; border: 0;
    }
    .nrw-stickers .ns {
      width: var(--ns-size, 24px); height: var(--ns-size, 24px);
      border-radius: 50%;
      position: relative; flex: 0 0 var(--ns-size, 24px);
      display: flex; align-items: center; justify-content: center;
      transition: transform 160ms ease, margin 160ms ease, z-index 0s 160ms;
    }
    .nrw-stickers .ns + .ns,
    .nrw-stickers .ns-extra + .ns {
      margin-left: calc(var(--ns-overlap, 10px) * -1);
    }
    .nrw-stickers:hover .ns + .ns,
    .nrw-stickers:hover .ns-extra + .ns {
      margin-left: -2px;
    }
    /* Right-most sticker gets highest z by virtue of source order + CSS sibling. */
    .nrw-stickers .ns { z-index: 1; }
    .nrw-stickers .ns:nth-last-child(1) { z-index: 9; }
    .nrw-stickers .ns:nth-last-child(2) { z-index: 8; }
    .nrw-stickers .ns:nth-last-child(3) { z-index: 7; }
    .nrw-stickers .ns.progress-slot { z-index: 12; }
    .nrw-stickers .ns:hover {
      z-index: 20; transform: translateY(-2px) scale(1.08); transition-delay: 0s;
    }

    /* The PNG is already a round, transparent sticker — let it fill the
       slot directly. A thin drop-shadow keeps adjacent overlapping
       stickers visually separated. */
    .nrw-stickers .ns img {
      position: absolute; inset: 0;
      width: 100%; height: 100%; object-fit: contain; pointer-events: none;
      filter: drop-shadow(0 0 1.5px var(--surface));
    }

    /* Won: full-colour PNG with a soft warm glow to flag "earned". */
    .nrw-stickers .ns.won img {
      filter: drop-shadow(0 0 1.5px var(--surface))
              drop-shadow(0 0 4px rgba(255,217,106,0.55));
    }

    /* In-progress: dim the sticker and overlay the conic progress ring. */
    .nrw-stickers .ns.progress-slot img {
      filter: drop-shadow(0 0 1.5px var(--surface))
              grayscale(0.4) brightness(0.9) saturate(1.05);
      opacity: 0.85;
    }
    .nrw-stickers .ns.progress-slot .ring {
      position: absolute; inset: -1px; border-radius: 50%;
      background: conic-gradient(#ffd96a 0 var(--ns-progress, 0%),
                                 rgba(0,0,0,0.10) var(--ns-progress, 0%) 100%);
      -webkit-mask: radial-gradient(circle, transparent 64%, black 66%);
              mask: radial-gradient(circle, transparent 64%, black 66%);
      pointer-events: none;
    }
    .nrw-stickers .ns.progress-slot .pct {
      position: absolute; right: -6px; bottom: -6px;
      min-width: 22px; height: 14px; padding: 0 4px;
      border-radius: 8px;
      background: #1d1024; color: #ffd96a;
      border: 1px solid #b76ce0;
      display: flex; align-items: center; justify-content: center;
      font-size: 9px; font-weight: 700; line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    /* Locked: silhouette — grayscale + low opacity, no disc. */
    .nrw-stickers .ns.locked img {
      filter: drop-shadow(0 0 1.5px var(--surface))
              grayscale(1) brightness(0.75) opacity(0.30);
    }

    .nrw-stickers .ns-extra {
      display: inline-flex; align-items: center; justify-content: center;
      height: var(--ns-size, 24px);
      padding: 0 7px;
      border-radius: 999px;
      font-size: 10px; font-weight: 600; color: var(--text-secondary);
      background: var(--surface-2);
      border: 1px solid var(--border);
      margin-right: 4px;
      font-variant-numeric: tabular-nums;
    }

    /* Dark theme — slightly more locked-state attenuation; the in-progress
       slot needs a bit more grayscale to pop against the gold ring. The
       separator drop-shadow inherits var(--surface) automatically. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) .nrw-stickers .ns.progress-slot img {
        filter: drop-shadow(0 0 1.5px var(--surface))
                grayscale(0.55) brightness(0.85) saturate(1.1);
        opacity: 0.8;
      }
      :root:not([data-theme="light"]) .nrw-stickers .ns.locked img {
        filter: drop-shadow(0 0 1.5px var(--surface))
                grayscale(1) brightness(0.55) opacity(0.30);
      }
    }
    :root[data-theme="dark"] .nrw-stickers .ns.progress-slot img {
      filter: drop-shadow(0 0 1.5px var(--surface))
              grayscale(0.55) brightness(0.85) saturate(1.1);
      opacity: 0.8;
    }
    :root[data-theme="dark"] .nrw-stickers .ns.locked img {
      filter: drop-shadow(0 0 1.5px var(--surface))
              grayscale(1) brightness(0.55) opacity(0.30);
    }
  `;
  const style = document.createElement("style");
  style.id = "nrw-stickers-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
injectStyles();
