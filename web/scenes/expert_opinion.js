// Scene — Expert opinion.
//
// Pick any combination of .masks / .pack / .json / .dict files and ask a
// configured LLM (see backend/routes/llm.py + .env.example) for a
// paragraph-long, factual comparison of what they show. The backend proxies
// the request to NARWAL_LLM_ENDPOINT so its API key never reaches the
// browser; this scene is a no-op (shows a setup hint instead of the picker)
// until that's configured.
//
// Files are read client-side (same as every other scene) and their raw text
// is embedded in the prompt — no parsing happens here, since the whole point
// is to hand the LLM the same files a human analyst would open, headered by
// filename so it can tell them apart.

import { listServerFiles, serverFilePickerHtml, wireServerFilePicker } from "../util/serverFiles.js";

export const name = "expert-opinion";

const EXTENSIONS = [".masks", ".pack", ".json", ".dict"];

// Keeps a single huge file from blowing the LLM's context window (and the
// request payload) while still giving it a representative sample — most of
// these formats put their most useful information first (mask/count lines
// sorted by count, statsgen summaries, histogram headers).
const MAX_CHARS_PER_FILE = 20_000;

const PROMPT_INSTRUCTIONS =
  "give a paragraph-long explanation of the most notable differences between the underlying password " +
  "corpora that these files are analyses of — for example differences in typical length, character-class " +
  "usage, common masks, letter/digit frequency, or password strength (zxcvbn) distribution. Be factual, do " +
  "not make mistakes. Do NOT comment on differences in file structure, format, or layout between the input " +
  "files themselves — only on what the data says about the corpora. A .masks file contains lines and counts " +
  "on password mask structure with l=lower, u=upper, d=digit, s=special. A .pack file is a human-readable " +
  "analysis summary of a password corpus containing info like length and charsets. A json file can contain " +
  "a histogram or bivariate histogram, containing info described by 'name'. Infer the rest of the contents " +
  "by the file, for example a histogram with name 'letters' is a frequency analysis of the letters which " +
  "occur in the corpus. A histogram with name 'zxcvbn' is a summary of the password scores, as rated by the " +
  "zxcvbn algorithm.";

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <h2>Expert opinion</h2>
      <div class="sub">
        Pick any combination of <code>.masks</code>, <code>.pack</code>, <code>.json</code>, and
        <code>.dict</code> files and ask a configured LLM to summarize the most notable differences between
        them. The files' raw contents are sent to the endpoint set in <code>.env</code> — unlike every other
        scene, this one does leave the browser.
      </div>
      <div id="body"><div class="loading">checking configuration…</div></div>
    </div>
  `;

  const body = mount.querySelector("#body");
  const enabled = await fetchLlmEnabled();
  if (!enabled) {
    body.innerHTML = `
      <div class="sub" style="margin:0">
        No LLM endpoint is configured. Set <code>NARWAL_LLM_ENDPOINT</code> (and optionally
        <code>NARWAL_LLM_API_KEY</code> / <code>NARWAL_LLM_MODEL</code>) in <code>.env</code> to enable this tab.
      </div>
    `;
    return;
  }

  body.innerHTML = `
    <div id="drop" style="border:1px dashed var(--border-2);border-radius:8px;padding:24px;text-align:center;color:var(--text-secondary);margin-bottom:10px">
      <input type="file" id="file-input" accept="${EXTENSIONS.join(",")}" multiple style="display:none"/>
      <button id="pick" class="primary" style="padding:10px 18px">Add file(s)</button>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px">or drop files here · ${EXTENSIONS.map((e) => `<code>${e}</code>`).join(" ")}</div>
      <div id="serverPicker"></div>
    </div>
    <div id="files" style="margin-bottom:10px"></div>
    <div id="msg"></div>
    <div style="margin:10px 0">
      <button id="ask" class="primary" style="padding:10px 18px" disabled>Ask the expert</button>
    </div>
    <div id="answer"></div>
  `;

  const fileInput = body.querySelector("#file-input");
  const drop = body.querySelector("#drop");
  const filesBox = body.querySelector("#files");
  const msg = body.querySelector("#msg");
  const askBtn = body.querySelector("#ask");
  const answerBox = body.querySelector("#answer");

  const files = []; // [{ name, content, truncated }]

  body.querySelector("#pick").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "var(--info-border)"; });
  drop.addEventListener("dragleave", () => { drop.style.borderColor = "var(--border-2)"; });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.style.borderColor = "var(--border-2)";
    handleFiles(e.dataTransfer.files);
  });

  const serverPickerBox = body.querySelector("#serverPicker");
  serverPickerBox.innerHTML = `<div class="sub" style="margin:8px 0 0">indexing…</div>`;
  listServerFiles("").then((allFiles) => {
    const matching = allFiles.filter((f) => EXTENSIONS.some((ext) => f.path.endsWith(ext)));
    serverPickerBox.innerHTML = serverFilePickerHtml(matching, "expert");
    wireServerFilePicker(serverPickerBox, matching, "expert", "", (file) => handleFiles([file]));
  });

  askBtn.addEventListener("click", ask);

  async function handleFiles(fileList) {
    const picked = [...(fileList || [])];
    const errors = [];
    for (const file of picked) {
      if (!EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) {
        errors.push(`${file.name}: not one of ${EXTENSIONS.join(", ")}`);
        continue;
      }
      let text;
      try { text = await file.text(); }
      catch { errors.push(`could not read ${file.name}`); continue; }
      const truncated = text.length > MAX_CHARS_PER_FILE;
      const content = truncated ? text.slice(0, MAX_CHARS_PER_FILE) : text;
      const existing = files.findIndex((f) => f.name === file.name);
      const entry = { name: file.name, content, truncated };
      if (existing >= 0) files[existing] = entry;
      else files.push(entry);
    }
    fileInput.value = "";
    msg.innerHTML = errors.length ? `<div class="card danger">${errors.map(escapeHtml).join("<br>")}</div>` : "";
    renderFileChips();
  }

  function removeAt(i) { files.splice(i, 1); renderFileChips(); }
  function clearAll() { files.length = 0; renderFileChips(); }

  function renderFileChips() {
    askBtn.disabled = files.length === 0;
    if (!files.length) { filesBox.innerHTML = ""; return; }
    filesBox.innerHTML = files.map((f, i) => `
      <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border-2);border-radius:14px;font-size:12px;margin:0 6px 6px 0">
        ${escapeHtml(f.name)}
        ${f.truncated ? `<span class="pill pill-warning" title="only the first ${MAX_CHARS_PER_FILE.toLocaleString()} characters are sent">truncated</span>` : ""}
        <button data-rm="${i}" title="remove" style="border:0;background:none;cursor:pointer;color:var(--text-secondary);padding:0 2px;font-size:14px;line-height:1">×</button>
      </span>
    `).join("") + `<button id="clear-all" style="font-size:12px">clear all</button>`;
    filesBox.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => removeAt(+b.dataset.rm)));
    filesBox.querySelector("#clear-all").addEventListener("click", clearAll);
  }

  async function ask() {
    askBtn.disabled = true;
    answerBox.innerHTML = `<div class="loading" style="margin-top:10px">asking the expert…</div>`;
    try {
      const prompt = buildPrompt(files);
      const res = await fetch("/api/llm/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail || `request failed (${res.status})`);
      answerBox.innerHTML = `
        <div class="card" style="margin-top:10px;white-space:pre-wrap">${escapeHtml(data.content)}</div>
      `;
    } catch (err) {
      answerBox.innerHTML = `<div class="card danger" style="margin-top:10px">${escapeHtml(err.message)}</div>`;
    } finally {
      askBtn.disabled = files.length === 0;
    }
  }
}

async function fetchLlmEnabled() {
  try {
    const res = await fetch("/api/llm/status");
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.enabled;
  } catch {
    return false;
  }
}

function buildPrompt(files) {
  const blocks = files.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n");
  return `Given the following files:\n\n${blocks}\n\n${PROMPT_INSTRUCTIONS}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
