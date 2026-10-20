// Client for the optional read-only "server wordlists" directory (see
// backend/routes/wordlists.py + .env.example). Every call degrades to "no
// files" if the feature isn't configured on the backend — scenes just skip
// rendering the picker in that case, same as if the corpus were empty.

// Lists files under the configured directory whose name ends with `ext`
// (pass "" for no filter). Never throws — network/parse failures just mean
// no server files to offer.
export async function listServerFiles(ext = "") {
  try {
    const res = await fetch(`/api/wordlists?ext=${encodeURIComponent(ext)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.enabled ? data.files : [];
  } catch {
    return [];
  }
}

export async function listRuleFiles(ext="") {
  // TODO Create wrapper around listServerFiles to avoid duplication of logic here
  try {
    const res = await fetch(`/api/rules?ext=${encodeURIComponent(ext)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.enabled ? data.files : [];
  } catch {
    return [];
  }
}

// Fetches a server-side file and wraps it as a real File object, so callers
// can feed it straight into the same code path as a browser-picked upload.
export async function fetchServerFile(path, ext = "") {
  const url = `/api/wordlists/content?path=${encodeURIComponent(path)}&ext=${encodeURIComponent(ext)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${path} (${res.status})`);
  const blob = await res.blob();
  return new File([blob], path.split("/").pop());
}

// Inline searchable-dropdown markup for a list of server-side files. Returns
// "" when there are none, so callers can splice this straight into a
// template without an extra conditional. `idSuffix` must be unique per
// picker on the page (e.g. a scene name or slot key).
export function serverFilePickerHtml(files, idSuffix) {
  if (!files.length) return "";
  const listId = `server-files-${idSuffix}`;
  return `
    <div class="server-file-picker" style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:12px">
      <span style="color:var(--text-tertiary);white-space:nowrap">or pick from server library:</span>
      <input list="${listId}" data-server-input="${idSuffix}" placeholder="search…" style="flex:1;min-width:160px;padding:4px 6px"/>
      <datalist id="${listId}">
        ${files.map((f) => `<option value="${escapeAttr(f.path)}">`).join("")}
      </datalist>
      <button data-server-load="${idSuffix}" style="padding:4px 10px">Load</button>
    </div>
  `;
}

// Wires the Load button + Enter key for a picker rendered by
// serverFilePickerHtml with the same `idSuffix`, searched for within `root`.
// No-ops if that picker wasn't rendered (empty file list). `beforeLoad`, if
// given, is called with the picked file's listing entry (which already
// carries `size`) before it's fetched — return false to abort, so a caller
// can warn about a large file without downloading it first.
export function wireServerFilePicker(root, files, idSuffix, ext, onLoad, beforeLoad) {
  const input = root.querySelector(`[data-server-input="${idSuffix}"]`);
  const btn = root.querySelector(`[data-server-load="${idSuffix}"]`);
  if (!input || !btn) return;
  const byPath = new Map(files.map((f) => [f.path, f]));

  async function load() {
    const path = input.value.trim();
    const meta = byPath.get(path);
    if (!meta) return;
    if (beforeLoad && (await beforeLoad(meta)) === false) return;
    btn.disabled = true;
    try {
      const file = await fetchServerFile(path, ext);
      input.value = "";
      await onLoad(file);
    } catch (err) {
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener("click", load);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
