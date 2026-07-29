// Hash-router and scene host. Each scene exports `render(mountEl)` and
// `name`. The registry decides what shows in the nav bar.

import { scenes } from "./scenes/registry.js";
import { applySteppers } from "./util/stepper.js";
import { mountMascot } from "./util/mascot.js";
import { earnedSceneIds } from "./util/stickers.js";

if (window.Chart && window["chartjs-plugin-annotation"]) {
  Chart.register(window["chartjs-plugin-annotation"]);
}

const nav = document.getElementById("nav");
const view = document.getElementById("view");

// ── Theme toggle — cycling icon button (auto → light → dark → auto). ──
// The synchronous bootstrap in index.html has already applied any saved
// preference; here we render the right icon for the current state, and
// rotate on click.
(function wireTheme() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const order = ["auto", "light", "dark"];
  // Stroke=currentColor so the icon picks up var(--text-secondary).
  const icons = {
    // half-filled circle for auto
    auto: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/>
            <path d="M12 3 A9 9 0 0 0 12 21 Z" fill="currentColor" stroke="none"/>
          </svg>`,
    // sun for light
    light: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
             <circle cx="12" cy="12" r="4"/>
             <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
           </svg>`,
    // moon for dark
    dark: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
          </svg>`,
  };
  const labels = { auto: "Theme: auto (OS)", light: "Theme: light", dark: "Theme: dark" };

  function read() {
    try { const v = localStorage.getItem("nrw-theme"); return v === "light" || v === "dark" ? v : "auto"; }
    catch (_) { return "auto"; }
  }
  function apply(state) {
    try {
      if (state === "auto") {
        localStorage.removeItem("nrw-theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("nrw-theme", state);
        document.documentElement.setAttribute("data-theme", state);
      }
    } catch (_) {}
    btn.innerHTML = icons[state];
    btn.title = labels[state] + " — click to cycle";
    btn.setAttribute("aria-label", labels[state]);
  }
  apply(read());
  btn.addEventListener("click", () => {
    const next = order[(order.indexOf(read()) + 1) % order.length];
    apply(next);
  });
})();

function buildNav() {
  const right = nav.querySelector("#nav-right");
  for (const a of nav.querySelectorAll(":scope > a")) a.remove();
  for (const scene of scenes) {
    // Home is reached by clicking the mascot logo — no text link needed.
    if (scene.id === "home") continue;
    const a = document.createElement("a");
    a.href = `#${scene.id}`;
    a.dataset.sceneId = scene.id;
    a.textContent = scene.label;
    nav.insertBefore(a, right);
  }
}

function activate(sceneId) {
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.sceneId === sceneId);
  }
  // Mascot is permanent in the nav. On home it desaturates + pauses
  // (and ignores clicks) to signal the user is already there. The outer
  // .home-dim class halts the wrapper swim keyframe; syncMascotPause()
  // also postMessages into the iframe so its internal layer animations
  // (tail, hair, eyes) freeze too.
  const mascot = document.getElementById("brand-mascot");
  if (mascot) mascot.classList.toggle("home-dim", sceneId === "home");
  currentSceneId = sceneId;
  syncMascotPause();

  const scene = scenes.find((s) => s.id === sceneId) || scenes[0];
  view.innerHTML = "";
  // Reset any per-scene width override (e.g. analysis_results.js widening
  // #view for its charts) before the next scene renders, so it can't leak
  // across navigation.
  view.style.maxWidth = "";
  try {
    scene.module.render(view, { isStub: !!scene.stub });
  } catch (err) {
    view.innerHTML = `<div class="panel error">scene "${scene.id}" failed to render: ${err.message}</div>`;
    console.error(err);
  }
  // Some scenes do their first render synchronously, then patch markup
  // in async callbacks (selection lists, etc). Catch both with one
  // microtask + one rAF tick.
  Promise.resolve().then(() => applySteppers(view));
  requestAnimationFrame(() => applySteppers(view));
}

function onHashChange() {
  const id = (location.hash || "#home").slice(1);
  activate(id);
  // Scroll the new scene into view from the top — otherwise navigating
  // (e.g. after clicking a finish button on a long scene) leaves the
  // user looking at the middle of the next page.
  window.scrollTo(0, 0);
}

let currentSceneId = null;
buildNav();
mountMascot(document.getElementById("brand-mascot"));
// Nav mascot doubles as the Home link — left-click navigates. On home
// it has pointer-events: none, so clicks are ignored. Middle-click still
// toggles pause (handled inside mascot.js).
document.getElementById("brand-mascot").addEventListener("click", (ev) => {
  if (ev.button === 0) location.hash = "#home";
});
// Iframe may not be loaded by the time the first activate() runs.
// Re-sync the pause state once it fires its load event.
{
  const frame = document.querySelector("#brand-mascot iframe");
  if (frame) frame.addEventListener("load", syncMascotPause);
}
decorateEarnedNavLinks();

// Send {still: bool} into the mascot iframe so its internal layer
// animations follow the current scene + user pause preference. On home
// we force-pause; elsewhere we restore the user's middle-click choice.
function syncMascotPause() {
  const frame = document.querySelector("#brand-mascot iframe");
  if (!frame || !frame.contentWindow) return;
  let still = currentSceneId === "home";
  if (currentSceneId !== "home") {
    try { still = sessionStorage.getItem("narwal-still") === "1"; } catch (_) {}
  }
  try { frame.contentWindow.postMessage({ still }, "*"); } catch (_) {}
}
document.addEventListener("nrw-stickers-changed", decorateEarnedNavLinks);
window.addEventListener("hashchange", onHashChange);
onHashChange();

// Place a small polar-unicorn sticker badge on each nav link whose scene
// has at least one earned sticker. Re-runs on bumpSticker and on every
// buildNav. Idempotent — clears existing badges before re-painting.
function decorateEarnedNavLinks() {
  const earned = earnedSceneIds();
  for (const a of nav.querySelectorAll("a")) {
    const old = a.querySelector(".nav-link-sticker");
    if (old) old.remove();
    if (earned.has(a.dataset.sceneId)) {
      const badge = document.createElement("img");
      badge.className = "nav-link-sticker";
      badge.src = "/assets/sticker-polar-unicorn.png";
      badge.alt = "";
      badge.title = "step finished";
      a.classList.add("has-sticker");
      a.appendChild(badge);
    } else {
      a.classList.remove("has-sticker");
    }
  }
}
