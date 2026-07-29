// Word-domain primitives — comparing wordlists by their actual entries.
//
// Holding 14M+ strings in a Set costs roughly 700MB per file, and the UI keeps
// both files loaded at once. So instead of the strings themselves we keep a
// 53-bit hash of each word in a Float64Array: 8 bytes per distinct word, about
// 110MB for a rockyou-sized list, and both slots fit comfortably.
//
// 53 bits is the largest integer a double holds exactly. At 14M distinct words
// the expected number of hash collisions is ~0.01, so the counts are exact in
// practice; a collision would very slightly overstate the overlap.

// Two independent 32-bit lanes spliced into 53 bits.
export function hash53(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0xdeadbeef;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  h1 >>>= 0;
  h2 >>>= 0;
  // 32 bits from h1, 21 from h2 => 53.
  return h1 * 2097152 + (h2 >>> 11);
}

// Append-only Float64Array that grows in fixed blocks, so the peak allocation
// is one block rather than a doubling copy of the whole buffer.
const BLOCK = 1 << 20; // 1M values = 8MB

export class HashBuffer {
  constructor() {
    this.blocks = [new Float64Array(BLOCK)];
    this.used = 0;
    this.total = 0;
  }

  push(v) {
    if (this.used === BLOCK) {
      this.blocks.push(new Float64Array(BLOCK));
      this.used = 0;
    }
    this.blocks[this.blocks.length - 1][this.used++] = v;
    this.total++;
  }

  // Flatten, sort ascending, and drop duplicates. Returns a view sized to the
  // distinct count. TypedArray sort is numeric, so no comparator is needed.
  finish() {
    const out = new Float64Array(this.total);
    let at = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const n = i === this.blocks.length - 1 ? this.used : BLOCK;
      out.set(b.subarray(0, n), at);
      at += n;
    }
    this.blocks = null; // release the blocks before sorting
    out.sort();

    let n = 0;
    for (let i = 0; i < out.length; i++) {
      if (i === 0 || out[i] !== out[i - 1]) out[n++] = out[i];
    }
    return out.subarray(0, n);
  }
}

// Number of values present in both sorted, deduplicated arrays.
export function intersectSortedCount(a, b) {
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; }
    else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

// Whether a sorted array contains v.
export function sortedHas(arr, v) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = arr[mid];
    if (x === v) return true;
    if (x < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

// Sentinel used to break out of streamLines' per-line callback early.
const STOP = Symbol("stop");

// Re-stream a wordlist and keep the first `limit` entries whose hash is also
// present in `sorted` (another file's distinct-word hashes). Reading stops as
// soon as the cap is hit, so this normally costs a small partial pass — and no
// extra memory, since the other side is already a sorted hash array.
//
// Imported lazily to avoid a circular import at module-evaluation time:
// masks.js imports the hashing primitives from here.
export async function sampleSharedWords(stream, sorted, limit = 20) {
  const { streamLines } = await import("./masks.js");
  const found = [];
  const seen = new Set();
  try {
    await streamLines(stream, (line) => {
      if (found.length >= limit) throw STOP;
      if (!line || seen.has(line)) return;
      if (sortedHas(sorted, hash53(line))) {
        seen.add(line);
        found.push(line);
      }
    });
  } catch (err) {
    if (err !== STOP) throw err;
  }
  return found;
}

// Set overlap between two distinct-word hash arrays.
export function computeWordOverlap(a, b) {
  const shared = intersectSortedCount(a, b);
  const totalA = a.length;
  const totalB = b.length;
  const union = totalA + totalB - shared;
  return {
    totalA,
    totalB,
    shared,
    onlyA: totalA - shared,
    onlyB: totalB - shared,
    union,
    jaccard: union ? shared / union : 0,
  };
}
