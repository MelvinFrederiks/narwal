// Animated narwal mascot — embedded as a transparent iframe so the
// per-layer CSS+JS animations stay self-contained in narwal-mascot.html.
//
// mountMascot(el, opts?) drops the iframe into `el`, wraps it in the
// `swim` keyframe gesture, and wires click-to-settle (sessionStorage,
// also posted into the iframe via postMessage in case the inner page
// listens for it).
//
// Tooltip + aria-label match the brand voice.

const KEY = "narwal-still";
const ASSET = "/assets/narwal-mascot.html";

export function mountMascot(el, opts = {}) {
  if (!el) return;
  // `alwaysAnimated: true` ignores sessionStorage + middle-click pausing
  // and force-runs the animation. Used for the home hero, which is a
  // pure showcase and shouldn't inherit the nav-mascot's pause state.
  const always = !!opts.alwaysAnimated;
  el.classList.add("nrw-mascot");
  el.setAttribute("title", opts.title || "Narwal — crack smart. save polarbears.");
  el.setAttribute("aria-label",
    opts.ariaLabel || "Narwal mascot — click to settle for the session.");
  el.innerHTML = `
    <iframe class="nrw-mascot-frame"
            src="${ASSET}"
            title="Narwal mascot"
            tabindex="-1"
            scrolling="no"></iframe>
  `;

  const frame = el.querySelector(".nrw-mascot-frame");

  function postStill(isStill) {
    if (!frame || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage({ still: !!isStill }, "*"); } catch (_) {}
  }
  function postHappy(isHappy) {
    if (!frame || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage({ happy: !!isHappy }, "*"); } catch (_) {}
  }
  function apply() {
    if (always) {
      // Force-running mode: outer wrapper never gets .still, inner
      // iframe is told to resume on every apply().
      el.classList.remove("still");
      postStill(false);
      return;
    }
    let still = false;
    try { still = sessionStorage.getItem(KEY) === "1"; } catch (_) {}
    el.classList.toggle("still", still);
    postStill(still);
  }

  // In always-animated mode (the home hero), don't wire pause controls
  // OR the hover-happy gesture — the excited tail-wag is reserved for the
  // nav mascot on non-home scenes. (On the home scene the nav mascot is
  // `.home-dim` with pointer-events:none, so it can't be hovered there
  // either — net effect: happy wag only when you're NOT on the homepage.)
  if (!always) {
    // Hovering the mascot makes it happy: the whole logo does an excited
    // wiggle (outer .happy-hover class) AND the inner tail wags harder
    // (postHappy → body.happy inside the iframe). Class-driven rather than
    // CSS :hover so it's testable and immune to the element wandering out
    // from under a static pointer while it's animating.
    el.addEventListener("mouseenter", () => { el.classList.add("happy-hover"); postHappy(true); });
    el.addEventListener("mouseleave", () => { el.classList.remove("happy-hover"); postHappy(false); });

    // Middle-click toggles: settle ↔ animate. State persists for the
    // session so hash-navigating between scenes doesn't reset it. Left
    // click is intentionally NOT bound — the mascot is now a brand badge,
    // not a control, and accidentally pausing it while clicking around
    // was annoying.
    el.addEventListener("auxclick", (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      let was = false;
      try { was = sessionStorage.getItem(KEY) === "1"; } catch (_) {}
      try {
        if (was) sessionStorage.removeItem(KEY);
        else sessionStorage.setItem(KEY, "1");
      } catch (_) {}
      apply();
    });
    // Suppress the default middle-click action (autoscroll on most
    // browsers, "open in new tab" on links) inside the mascot area.
    el.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) ev.preventDefault();
    });
  }

  if (frame) frame.addEventListener("load", apply);
  apply();
}

// ── One-time stylesheet injection ────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById("nrw-mascot-styles")) return;
  const css = `
    .nrw-mascot {
      width: var(--nrw-mascot-size, 76px);
      height: var(--nrw-mascot-size, 76px);
      position: relative;
      cursor: pointer;
      user-select: none;
      filter: drop-shadow(0 4px 12px rgba(135, 198, 240, 0.25));
      transform-origin: 35% 60%;
      animation: nrw-mascot-swim 4.4s ease-in-out infinite;
    }
    .nrw-mascot .nrw-mascot-frame {
      width: 100%; height: 100%; border: 0; background: transparent;
      pointer-events: none;
    }
    /* Settled = paused in place: keep the running animation but freeze
       its play-state. Re-clicking resumes from the exact same frame
       instead of snapping back to a neutral pose. */
    .nrw-mascot.still {
      animation-play-state: paused;
    }
    @keyframes nrw-mascot-swim {
      0%, 100% { transform: translateY(0px) rotate(-3deg); }
      30%      { transform: translateY(-4px) rotate(1deg); }
      50%      { transform: translateY(-6px) rotate(4deg); }
      70%      { transform: translateY(-3px) rotate(2deg); }
    }
    /* Hover = happy: the whole logo does a quick, unmistakable wag so the
       gesture reads even at nav size. The inner tail wags harder too. */
    .nrw-mascot.happy-hover {
      animation: nrw-mascot-happy 0.42s ease-in-out infinite;
    }
    @keyframes nrw-mascot-happy {
      0%, 100% { transform: translateY(-2px) rotate(-9deg); }
      50%      { transform: translateY(-3px) rotate(9deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .nrw-mascot { animation: none; }
    }
  `;
  const style = document.createElement("style");
  style.id = "nrw-mascot-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
injectStyles();
