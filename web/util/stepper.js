// Stepper buttons for `<input type=number>`.
//
// Wrap any number input with [-] [input] [+] buttons that respect the
// input's min/max/step. Adding/removing buttons is idempotent — calling
// applySteppers() twice on the same root is fine. Hold-to-repeat is
// wired in for long-press stepping. Triggers an "input" + "change" event
// after each step so scene listeners pick up the new value.
//
// Usage:
//   import { applySteppers } from "../util/stepper.js";
//   applySteppers(mount);

const WRAPPED = "data-stepper-wrapped";

function step(input, dir) {
  const min = input.min !== "" ? parseFloat(input.min) : -Infinity;
  const max = input.max !== "" ? parseFloat(input.max) : Infinity;
  const stepSize = input.step !== "" && input.step !== "any" ? parseFloat(input.step) : 1;
  const cur = parseFloat(input.value);
  const base = Number.isFinite(cur) ? cur : (Number.isFinite(min) ? min : 0);
  let next = base + dir * stepSize;
  // Snap to step grid relative to min when min is finite.
  if (Number.isFinite(min) && stepSize > 0) {
    next = Math.round((next - min) / stepSize) * stepSize + min;
  }
  next = Math.max(min, Math.min(max, next));
  // Trim FP noise for nice display.
  if (Number.isInteger(stepSize) && Number.isInteger(min === -Infinity ? 0 : min)) {
    next = Math.round(next);
  } else {
    next = parseFloat(next.toFixed(6));
  }
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function wireHold(btn, onStep) {
  let t1 = null, t2 = null;
  const start = (e) => {
    e.preventDefault();
    onStep();
    t1 = setTimeout(() => {
      t2 = setInterval(onStep, 65);
    }, 380);
  };
  const stop = () => {
    if (t1) { clearTimeout(t1); t1 = null; }
    if (t2) { clearInterval(t2); t2 = null; }
  };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("touchstart", start, { passive: false });
  for (const ev of ["mouseup", "mouseleave", "touchend", "touchcancel", "blur"]) {
    btn.addEventListener(ev, stop);
  }
}

export function applySteppers(root) {
  if (!root) return;
  for (const input of root.querySelectorAll('input[type="number"]')) {
    if (input.hasAttribute(WRAPPED)) continue;
    input.setAttribute(WRAPPED, "1");

    const wrap = document.createElement("span");
    wrap.className = "num-stepper";
    // Preserve any inline width the input had — apply to wrap, slim the input.
    if (input.style.width) {
      wrap.style.width = input.style.width;
      input.style.width = "100%";
    }

    const dec = document.createElement("button");
    dec.type = "button";
    dec.className = "num-step-btn num-step-dec";
    dec.setAttribute("aria-label", "decrease");
    dec.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 6h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    const inc = document.createElement("button");
    inc.type = "button";
    inc.className = "num-step-btn num-step-inc";
    inc.setAttribute("aria-label", "increase");
    inc.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 6h8M6 2v8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(dec);
    wrap.appendChild(input);
    wrap.appendChild(inc);

    wireHold(dec, () => step(input, -1));
    wireHold(inc, () => step(input, +1));
  }
}

// One-time stylesheet injection — kept here so callers don't have to
// remember to import a separate CSS file.
function injectStyles() {
  if (document.getElementById("stepper-styles")) return;
  const css = `
    .num-stepper {
      display: inline-flex; align-items: stretch;
      border: 0.5px solid var(--border-2);
      border-radius: var(--radius-md);
      background: var(--surface);
      overflow: hidden;
      vertical-align: middle;
      height: 28px;
    }
    .num-stepper input[type="number"] {
      border: 0; outline: none; background: transparent;
      text-align: center;
      padding: 2px 4px; min-width: 0;
      font: inherit; color: var(--text);
      -moz-appearance: textfield;
      appearance: textfield;
    }
    .num-stepper input[type="number"]::-webkit-outer-spin-button,
    .num-stepper input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .num-step-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; padding: 0;
      border: 0; background: var(--surface-2); color: var(--text-secondary);
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
      border-radius: 0;
    }
    .num-step-btn:hover { background: var(--surface-3); color: var(--text); }
    .num-step-btn:active { background: var(--border); }
    .num-step-dec { border-right: 0.5px solid var(--border); }
    .num-step-inc { border-left:  0.5px solid var(--border); }
    .num-step-btn:focus-visible { outline: 1.5px solid var(--info-border); outline-offset: -1px; }
  `;
  const style = document.createElement("style");
  style.id = "stepper-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
injectStyles();
