// Shared hashcat-mask primitives.
//
// Everything here works off a ReadableStream of bytes rather than a File, so
// the same parser serves a local upload (`file.stream()`) and, later, a remote
// fetch (`response.body`) without changes. That is the seam for pulling
// corpora from an API.
//
// Three input kinds are understood:
//   · wordlist — one password per line
//   · masks    — PACK statsgen `-o` output: `<mask>,<count>` per line
//   · hcmask   — hashcat mask file: one mask per line, no counts, with
//                optional custom-charset fields ahead of the mask
//
// The kind is normally sniffed from the content, but callers can force it.

import { HashBuffer, hash53 } from "./words.js";

export const KINDS = ["wordlist", "masks", "hcmask"];

export const KIND_LABELS = {
  wordlist: "wordlist",
  masks: "PACK .masks",
  hcmask: "hashcat .hcmask",
};

// A PACK statsgen line: `<mask>,<count>` — e.g. `?l?l?l?l?d?d,601152`.
export const MASK_LINE_RE = /^([^,]+),\s*(\d+)\s*$/;

// Banner / summary chatter emitted by PACK around the data lines.
export function isBannerLine(line) {
  return (
    !line ||
    line.startsWith("[") ||
    line.startsWith("_") ||
    /MaskGen|StatsGen|iphelix/i.test(line)
  );
}

// Built-in hashcat charsets, used to resolve custom ?1–?4 definitions back to
// a standard token where they happen to be equivalent. ?b (raw 0x00–0xff) is
// deliberately absent — it has no meaningful string expansion here.
const CHARSET = {
  l: "abcdefghijklmnopqrstuvwxyz",
  u: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  d: "0123456789",
  s: " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  h: "0123456789abcdef",
  H: "0123456789ABCDEF",
};
CHARSET.a = CHARSET.l + CHARSET.u + CHARSET.d + CHARSET.s;

const sortedUnique = (s) => [...new Set(s)].sort().join("");
const STD_BY_CHARS = new Map(
  Object.entries(CHARSET).map(([k, v]) => [sortedUnique(v), "?" + k]),
);

// Charset identifiers hashcat accepts after a `?`.
const MASK_TOKENS = new Set(["l", "u", "d", "s", "a", "b", "h", "H", "1", "2", "3", "4"]);

// Split on commas that are not backslash-escaped, unescaping as we go.
// hashcat uses `\,` for a literal comma inside a custom charset.
function splitUnescaped(line) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) { cur += line[i + 1]; i++; continue; }
    if (ch === ",") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Split a hashcat mask into tokens: `?x` pairs, or single literal chars.
export function tokenizeMask(mask) {
  const toks = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "?" && i + 1 < mask.length) {
      toks.push(mask.slice(i, i + 2));
      i++;
    } else {
      toks.push(mask[i]);
    }
  }
  return toks;
}

// True when every character of `s` belongs to a `?x` token — no literals.
// Used only for *detecting* an .hcmask file, where being strict avoids
// mistaking a password like "a?l" for a mask. Parsing is permissive.
function isPureMask(s) {
  if (!s) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "?") return false;
    const next = s[i + 1];
    if (next === undefined) return false;
    if (next !== "?" && !MASK_TOKENS.has(next)) return false;
    i++;
    n++;
  }
  return n > 0;
}

// Expand a custom-charset definition into its literal characters, resolving
// any built-in tokens it references (e.g. "?l?d" -> lowercase plus digits).
function expandCharset(def) {
  let out = "";
  for (let i = 0; i < def.length; i++) {
    if (def[i] === "?" && i + 1 < def.length) {
      const n = def[i + 1];
      if (n === "?") { out += "?"; i++; continue; }
      if (CHARSET[n]) { out += CHARSET[n]; i++; continue; }
    }
    out += def[i];
  }
  return out;
}

// Parse one hashcat mask-file line into a comparable mask string.
//
// The last comma-separated field is the mask; any earlier fields are custom
// charsets bound to ?1, ?2, ?3, ?4 in order. A custom charset is substituted
// back into the mask when it is exactly equivalent to a built-in class
// (`?l?d,?1?1?1?1` becomes a mask over lowercase+digits, which no built-in
// token names, so it stays ?1) — otherwise the token is left as-is and the
// line is reported as custom, since it cannot be compared against standard
// masks on equal terms.
//
// Returns { mask, custom } or null when the line is not a mask at all.
export function parseHcMaskLine(line) {
  const parts = splitUnescaped(line);
  const mask = parts[parts.length - 1];
  if (!mask || !mask.includes("?")) return null;

  const defs = parts.slice(0, -1);
  if (!defs.length) return { mask, custom: false };

  const resolved = defs.map((d) => STD_BY_CHARS.get(sortedUnique(expandCharset(d))) || null);
  let custom = false;
  let out = "";
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === "?" && i + 1 < mask.length) {
      const n = mask[i + 1];
      const idx = "1234".indexOf(n);
      if (idx >= 0 && idx < resolved.length) {
        if (resolved[idx]) out += resolved[idx];
        else { out += "?" + n; custom = true; }
        i++;
        continue;
      }
      out += mask.slice(i, i + 2);
      i++;
      continue;
    }
    out += mask[i];
  }
  return { mask: out, custom };
}

// Derive a word's hashcat mask: ?l lowercase, ?u uppercase, ?d digit, ?s
// everything else. Note that hashcat's ?s is strictly printable-ASCII
// specials; folding non-ASCII into it too is a deliberate simplification so
// every line yields a mask. Astral pairs count as one character.
export function maskOf(word) {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c >= 97 && c <= 122) out += "?l";
    else if (c >= 65 && c <= 90) out += "?u";
    else if (c >= 48 && c <= 57) out += "?d";
    else {
      out += "?s";
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < word.length) i++;
    }
  }
  return out;
}

// Feed a byte stream to `onLine` one line at a time, without ever holding the
// whole file in memory. `onChunk(bytesSoFar)` fires once per network/disk
// chunk — cheap enough to drive a progress bar.
//
// `onLine` may throw to stop early (see sampleSharedWords); the reader is
// cancelled either way so the underlying file handle is not left locked.
export async function streamLines(stream, onLine, onChunk) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });

      let start = 0;
      let i;
      while ((i = buf.indexOf("\n", start)) !== -1) {
        let line = buf.slice(start, i);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        start = i + 1;
      }
      buf = buf.slice(start);

      if (onChunk) await onChunk(bytes);
    }

    buf += decoder.decode();
    for (const raw of buf.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line) onLine(line);
    }
    if (onChunk) await onChunk(bytes);
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
}

// How many data lines to inspect before deciding the kind, and what share of
// them must match for a verdict. A wordlist can legitimately contain a line
// like `foo,123`, so the PACK side also requires a `?` in the mask field.
const DETECT_SAMPLE = 200;
const DETECT_SHARE = 0.8;

function packLineOf(line) {
  const m = line.match(MASK_LINE_RE);
  return m && m[1].includes("?") ? m : null;
}

// Strict test used only for the vote: the mask field must be nothing but
// `?x` tokens.
function looksHcMask(line) {
  const parts = splitUnescaped(line);
  return isPureMask(parts[parts.length - 1]);
}

// Decide a kind from a sample of data lines.
export function detectKind(sample) {
  const data = sample.filter((l) => !isBannerLine(l));
  if (!data.length) return "wordlist";
  const pack = data.reduce((n, l) => n + (packLineOf(l) ? 1 : 0), 0);
  if (pack >= data.length * DETECT_SHARE) return "masks";
  const hc = data.reduce((n, l) => n + (looksHcMask(l) ? 1 : 0), 0);
  if (hc >= data.length * DETECT_SHARE) return "hcmask";
  return "wordlist";
}

// Parse a stream into a mask histogram: Map(mask -> count), and — for a
// wordlist, when `words` is set — the distinct word hashes as well.
//
// The mask histogram is always built: it is what makes a wordlist and a mask
// file comparable at all, and it stays small (even a 14M-line wordlist has
// only a few hundred thousand distinct masks). Word hashes are what let two
// wordlists be compared as the passwords they actually contain.
//
// Pass `kind` to skip detection and force an interpretation.
//
// Returns { kind, detected, masks, items, lines, skipped, custom, words }.
// `items` is the number of passwords represented (summed counts for a PACK
// file, line count otherwise); `custom` counts .hcmask lines using a charset
// that has no standard equivalent; `words` is a sorted, deduplicated
// Float64Array of hashes, or null unless the file is a wordlist and `words`
// was requested.
export async function parseCorpus(stream, { onChunk, words = false, kind = null } = {}) {
  const forced = kind && KINDS.includes(kind) ? kind : null;
  const masks = new Map();
  let resolved = forced;
  let detected = null;
  let items = 0;
  let lines = 0;
  let skipped = 0;
  let custom = 0;
  let hashes = null;
  const sample = [];
  let dataSeen = 0;

  const add = (mask, count) => {
    if (!mask) return;
    masks.set(mask, (masks.get(mask) || 0) + count);
    items += count;
  };

  const consume = (line) => {
    // A banner is only noise in a mask file; inside a wordlist "[" is a
    // perfectly ordinary password character.
    if (resolved !== "wordlist" && isBannerLine(line)) return;
    if (!line) return;
    lines++;

    if (resolved === "masks") {
      const m = packLineOf(line);
      if (!m) { skipped++; return; }
      add(m[1], +m[2]);
    } else if (resolved === "hcmask") {
      const r = parseHcMaskLine(line);
      if (!r) { skipped++; return; }
      if (r.custom) custom++;
      add(r.mask, 1);
    } else {
      add(maskOf(line), 1);
      if (hashes) hashes.push(hash53(line));
    }
  };

  const settle = () => {
    detected = detectKind(sample);
    resolved = forced || detected;
    // Only a wordlist has words to hash; start collecting before the sample is
    // replayed so the first lines are not missed.
    if (words && resolved === "wordlist") hashes = new HashBuffer();
    for (const l of sample) consume(l);
    sample.length = 0;
  };

  await streamLines(
    stream,
    (line) => {
      if (resolved === null || detected === null) {
        // Buffer until the vote can be taken. Banner lines are kept in the
        // sample (so a wordlist does not lose them) but excluded from the vote.
        sample.push(line);
        if (!isBannerLine(line)) dataSeen++;
        if (dataSeen >= DETECT_SAMPLE) settle();
        return;
      }
      consume(line);
    },
    onChunk,
  );

  // Fewer than DETECT_SAMPLE data lines in the whole file.
  if (detected === null) settle();

  return {
    kind: resolved,
    detected,
    masks,
    items,
    lines,
    skipped,
    custom,
    words: hashes ? hashes.finish() : null,
  };
}

// Multiset overlap between two mask histograms.
//
// Per mask, a = A's weight and b = B's weight; the shared region takes
// min(a, b) and each exclusive region keeps the remainder. In distinct mode
// every present mask weighs 1, which reduces the same formula to plain set
// intersection — so both modes run one code path.
//
// Sizes are consistent by construction: onlyA + shared === total weight of A.
export function computeOverlap(A, B, { weighted = false } = {}) {
  let onlyA = 0;
  let onlyB = 0;
  let shared = 0;
  let sharedMasks = 0;

  const w = (c) => (weighted ? c : c > 0 ? 1 : 0);

  for (const [mask, ca] of A) {
    const a = w(ca);
    const b = w(B.get(mask) || 0);
    const min = Math.min(a, b);
    shared += min;
    onlyA += a - min;
    if (B.has(mask)) sharedMasks++;
  }
  for (const [mask, cb] of B) {
    if (A.has(mask)) continue;
    onlyB += w(cb);
  }

  const union = onlyA + onlyB + shared;
  return {
    onlyA,
    onlyB,
    shared,
    union,
    sharedMasks,
    totalA: onlyA + shared,
    totalB: onlyB + shared,
    jaccard: union ? shared / union : 0,
  };
}

// The masks present in both, ranked by how much they contribute to the shared
// region (min of the two weights) — i.e. the overlap's actual drivers.
export function topSharedMasks(A, B, { weighted = false, top = 15 } = {}) {
  const rows = [];
  for (const [mask, ca] of A) {
    const cb = B.get(mask);
    if (!cb) continue;
    const a = weighted ? ca : 1;
    const b = weighted ? cb : 1;
    rows.push({ mask, countA: ca, countB: cb, weight: Math.min(a, b) });
  }
  rows.sort((x, y) => y.weight - x.weight || y.countA + y.countB - (x.countA + x.countB));
  return rows.slice(0, top);
}
