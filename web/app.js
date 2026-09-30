// Hash-router and scene host. Each scene exports `render(mountEl)` and
// `name`. The registry decides what shows in the nav bar.

import { scenes } from "./scenes/registry.js";

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
    const a = document.createElement("a");
    a.href = `#${scene.id}`;
    a.dataset.sceneId = scene.id;
    a.textContent = scene.label;
    nav.insertBefore(a, right);
  }
}

// `route` is everything after the scene id — `#mergeability/ab12` renders the
// mergeability scene with route "ab12". Scenes that don't take a parameter
// simply ignore the second argument.
function activate(sceneId, route) {
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.sceneId === sceneId);
  }

  const scene = scenes.find((s) => s.id === sceneId) || scenes[0];
  view.innerHTML = "";
  // Reset any per-scene width override (e.g. analysis_results.js widening
  // #view for its charts) before the next scene renders, so it can't leak
  // across navigation.
  view.style.maxWidth = "";
  try {
    scene.module.render(view, route);
  } catch (err) {
    view.innerHTML = `<div class="panel error">scene "${scene.id}" failed to render: ${err.message}</div>`;
    console.error(err);
  }
}

function onHashChange() {
  const hash = (location.hash || `#${scenes[0].id}`).slice(1);
  const slash = hash.indexOf("/");
  const id = slash === -1 ? hash : hash.slice(0, slash);
  activate(id, slash === -1 ? "" : hash.slice(slash + 1));
  // Scroll the new scene into view from the top — otherwise navigating
  // away from a long scene leaves the user looking at the middle of the
  // next page.
  window.scrollTo(0, 0);
}

buildNav();
window.addEventListener("hashchange", onHashChange);
onHashChange();
