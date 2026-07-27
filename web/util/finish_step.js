// Finish-step button — re-clickable "I'm done with this scene" reward.
//
// Drops a fixed-size pill at the bottom-right of the scene's panel. Each
// click awards one Polar-Unicorn, animates the sticker flying onto the
// matching nav link, then advances to the next storyboard step. Repeated
// clicks keep awarding (no one-shot session lock).
//
// Usage in a scene:
//   import { mountFinishButton } from "../util/finish_step.js";
//   mountFinishButton(mount, { sceneId: "coverage", label: "Coverage" });
//
// Idempotent — calling twice on the same mount is a no-op (won't add a
// second button).

import { bumpSticker } from "./stickers.js";

const ASSET = "/assets/sticker-polar-unicorn.png";
const SOUND = "/assets/cute_polar_bear_raarw.wav";

// Roar duration in seconds — taken from the wav header
// (44.1 kHz · 16-bit · mono · 72 765 frames = 1.65 s). We mirror this
// number into the fly animation so the sticker lands just as the roar
// ends, and we navigate to the next step on the audio's 'ended' event.
const RAARW_SECONDS = 1.65;

// Single preloaded prototype; clone per play so overlapping clicks
// don't cut each other off. Created lazily on first click so the page
// doesn't fire a network request for the wav before the user interacts.
let _soundPrototype = null;
function playRaarw(onEnded) {
  try {
    if (!_soundPrototype) _soundPrototype = new Audio(SOUND);
    const a = _soundPrototype.cloneNode();
    a.volume = 0.7;
    let fired = false;
    const fire = () => { if (!fired) { fired = true; onEnded && onEnded(); } };
    a.addEventListener("ended", fire);
    // Fallback in case the audio fails / is blocked — fire after the
    // expected duration so the flow never stalls.
    setTimeout(fire, RAARW_SECONDS * 1000 + 80);
    a.play().catch(fire);
  } catch (_) {
    onEnded && onEnded();
  }
}

// Canonical storyboard order. Clicking finish advances to ORDER[i+1], or
// loops back to "home" past the last step. Kept in sync with the STEPS
// array in scenes/home.js — if you reorder there, mirror it here.
const ORDER = [
  "setup", "coverage", "compare", "mergeability", "heatmap",
  "overlap-2", "overlap-many", "cluster",
  "compose", "verdict", "architecture",
];
function nextSceneId(sceneId) {
  const i = ORDER.indexOf(sceneId);
  if (i < 0) return null;
  return i === ORDER.length - 1 ? "home" : ORDER[i + 1];
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export function mountFinishButton(mount, { sceneId, label } = {}) {
  if (!mount || !sceneId) return;

  if (mount.querySelector(`.nrw-finish[data-scene="${sceneId}"]`)) return;

  const panel = mount.querySelector(".panel") || mount;

  const wrap = document.createElement("div");
  wrap.className = "nrw-finish";
  wrap.dataset.scene = sceneId;
  // Sticker is absolute-positioned so it overlaps the leading edge of the
  // text without growing the button. The text padding leaves room.
  wrap.innerHTML = `
    <button type="button" class="nrw-finish-btn"
            aria-label="Finish ${esc(label || sceneId)} and earn a sticker">
      <img class="nrw-finish-sticker" src="${ASSET}" alt=""/>
      <span class="nrw-finish-text">Finish ${esc(label || sceneId)} · +1 sticker</span>
    </button>
  `;
  panel.appendChild(wrap);

  const btn = wrap.querySelector("button");
  btn.addEventListener("click", () => {
    btn.classList.remove("just-earned");
    void btn.offsetWidth;
    btn.classList.add("just-earned");
    setTimeout(() => btn.classList.remove("just-earned"), 900);

    const next = nextSceneId(sceneId);
    // Fly the sticker over the full roar duration so it lands on the
    // last beat of the sound; bump the header count when it arrives.
    flySticker(btn, sceneId, () => {
      bumpSticker({ label: label || sceneId, sceneId });
    });
    // Play the roar — when it ends, navigate to the next step.
    playRaarw(() => { if (next) location.hash = "#" + next; });
  });
}

// Clone the finish sticker, animate it to the matching scene's nav link,
// fire the callback when it lands. Falls back to the callback firing
// immediately when the user prefers reduced motion or the target link
// isn't on screen.
function flySticker(btn, sceneId, onLand) {
  const src = btn.querySelector(".nrw-finish-sticker");
  const target =
    document.querySelector(`nav a[data-scene-id="${sceneId}"]`) ||
    document.querySelector("#brand-mascot");
  if (!src || !target || prefersReducedMotion()) {
    onLand();
    return;
  }
  const a = src.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  if (!a.width || !b.width) { onLand(); return; }

  // Sticker fly is paced to match the roar (RAARW_SECONDS). The opacity
  // fade is the last 18 % of the trip so the sticker is still visible
  // when it lands, then dissolves into the nav badge.
  const flyMs  = Math.round(RAARW_SECONDS * 1000);
  const fadeMs = Math.round(flyMs * 0.18);
  const fadeStart = flyMs - fadeMs;

  const clone = document.createElement("img");
  clone.src = ASSET;
  clone.alt = "";
  clone.className = "nrw-finish-fly";
  Object.assign(clone.style, {
    position: "fixed",
    left: `${a.left}px`,
    top:  `${a.top}px`,
    width:  `${a.width}px`,
    height: `${a.height}px`,
    transformOrigin: "center",
    zIndex: 9999,
    pointerEvents: "none",
    transition: `transform ${flyMs}ms cubic-bezier(0.55, -0.15, 0.25, 1.45), opacity ${fadeMs}ms ease ${fadeStart}ms`,
    filter: "drop-shadow(0 6px 18px rgba(186,117,23,0.45))",
  });
  document.body.appendChild(clone);

  // Force layout, then start the transition on next frame.
  clone.offsetWidth;
  requestAnimationFrame(() => {
    const dx = (b.left + b.width / 2)  - (a.left + a.width / 2);
    const dy = (b.top  + b.height / 2) - (a.top  + a.height / 2);
    const scale = Math.max(0.45, Math.min(1, (b.height * 0.95) / a.height));
    clone.style.transform = `translate(${dx}px, ${dy}px) scale(${scale}) rotate(540deg)`;
    clone.style.opacity = "0";
  });

  setTimeout(() => {
    onLand();
    clone.remove();
  }, flyMs + 40);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── One-time stylesheet injection ────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById("nrw-finish-styles")) return;
  const css = `
    .nrw-finish {
      margin-top: 22px; padding-top: 16px;
      border-top: 1px dashed var(--border);
      display: flex; flex-direction: column; gap: 6px;
      align-items: flex-end;
      text-align: right;
    }
    /* Fixed-size pill. Sticker is absolutely positioned at the left edge
       and overlaps the first ~12px of the text, so the button width stays
       constant regardless of state. */
    .nrw-finish-btn {
      position: relative;
      display: inline-flex; align-items: center;
      padding: 8px 18px 8px 32px;   /* extra left padding for the sticker */
      border-radius: 999px;
      background: linear-gradient(180deg, #fff5d6 0%, #f6e7a3 100%);
      border: 1px solid rgba(186,117,23,0.65);
      color: #6B3F08;
      font-weight: 600; font-size: 13px; letter-spacing: 0.1px;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
    }
    .nrw-finish-btn:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(186,117,23,0.20); }
    .nrw-finish-btn:active { transform: translateY(0); }
    .nrw-finish-sticker {
      position: absolute;
      left: 4px; top: 50%;
      width: 28px; height: 28px;
      transform: translateY(-50%);
      object-fit: contain;
      pointer-events: none;
      /* Sticker sits on top of the leading text — soft drop-shadow so the
         text underneath stays legible. */
      filter: drop-shadow(0 1px 2px rgba(0,0,0,0.25));
      z-index: 1;
    }
    .nrw-finish-text { position: relative; z-index: 0; }
    .nrw-finish-btn.just-earned {
      animation: nrw-finish-pulse 0.7s ease-out;
    }
    .nrw-finish-btn.just-earned .nrw-finish-sticker {
      animation: nrw-finish-sticker-wiggle 0.7s ease-out;
    }
    @keyframes nrw-finish-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(186,117,23,0.5); }
      40%  { box-shadow: 0 0 0 12px rgba(186,117,23,0); }
      100% { box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
    }
    @keyframes nrw-finish-sticker-wiggle {
      0%   { transform: translateY(-50%) scale(1) rotate(0deg); }
      30%  { transform: translateY(-50%) scale(1.18) rotate(-12deg); }
      60%  { transform: translateY(-50%) scale(1.08) rotate(8deg); }
      100% { transform: translateY(-50%) scale(1) rotate(0deg); }
    }

    /* Dark theme overrides */
    :root[data-theme="dark"] .nrw-finish-btn,
    :root:not([data-theme="light"]) .nrw-finish-btn {
      background: linear-gradient(180deg, #3a2f12 0%, #2a230d 100%);
      border: 1px solid rgba(255,217,106,0.45);
      color: #FAC775;
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]) .nrw-finish-btn {
        background: linear-gradient(180deg, #fff5d6 0%, #f6e7a3 100%);
        border: 1px solid rgba(186,117,23,0.65);
        color: #6B3F08;
      }
    }
  `;
  const style = document.createElement("style");
  style.id = "nrw-finish-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
injectStyles();
