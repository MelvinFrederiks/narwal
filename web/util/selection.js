// Cross-scene dataset selection state.
//
// Persisted to localStorage. Scenes read this to filter dropdowns / series
// to whatever the user picked in Setup. If nothing has been picked yet,
// default to ALL cleaned datasets from /api/datasets.

const KEY = "narwal:selectedDatasets";

let listeners = new Set();
let cachedDatasets = null;

export async function allDatasets() {
  if (cachedDatasets) return cachedDatasets;
  const r = await fetch("/api/datasets");
  cachedDatasets = (await r.json()).datasets;
  return cachedDatasets;
}

export async function cleanedDatasets() {
  return (await allDatasets()).filter((d) => d.cleaned);
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function notify(ids) {
  for (const fn of listeners) {
    try { fn(ids); } catch (err) { console.error("selection listener", err); }
  }
}

export async function getSelected() {
  const stored = read();
  if (stored && stored.length > 0) {
    // Filter against current cleaned set in case a dataset was removed.
    const cleanedIds = new Set((await cleanedDatasets()).map((d) => d.id));
    const filtered = stored.filter((id) => cleanedIds.has(id));
    if (filtered.length > 0) return filtered;
  }
  // Default: everything cleaned.
  return (await cleanedDatasets()).map((d) => d.id);
}

export function setSelected(ids) {
  localStorage.setItem(KEY, JSON.stringify(ids));
  notify(ids);
}

export function clearSelected() {
  localStorage.removeItem(KEY);
  notify([]);
}

export function subscribe(fn) {
  listeners.add(fn);
  // Cross-tab sync via storage events.
  if (listeners.size === 1) {
    window.addEventListener("storage", (ev) => {
      if (ev.key === KEY) notify(read() || []);
    });
  }
  return () => listeners.delete(fn);
}

// Friendly display labels for IDs with awkward storage names.
const LABEL_OVERRIDES = {
  zerozeroowebhost: "000webhost",
  hibp_top10m: "HIBP top10M",
};

export function labelFor(id) {
  return LABEL_OVERRIDES[id] || id;
}
