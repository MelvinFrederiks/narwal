// Deterministic per-attack icons.
//
// Color = wordlist family (rockyou / hibp / mask / omen / unknown).
// Shape = djb2 hash of the attack id, mod the shape vocabulary.
//
// The point isn't beauty — it's that two scenes can both ask "what does
// rockyou_d3ad0ne look like?" and get the same purple triangle (or whatever)
// so the user builds a mental map.

const FAMILY_COLORS = {
  rockyou: "#534AB7",   // purple
  hibp:    "#185FA5",   // blue
  mask:    "#D85A30",   // orange
  omen:    "#0F6E56",   // green
  default: "#5F5E5A",   // grey
};

const SHAPES = ["circle", "square", "triangle", "diamond", "hexagon", "pentagon", "star", "cross"];

export function familyOf(attack) {
  if (attack.type === "mask") return "mask";
  if (attack.type === "omen") return "omen";
  const wl = (attack.wordlist || "").toLowerCase();
  if (wl.startsWith("rockyou")) return "rockyou";
  if (wl.startsWith("hibp")) return "hibp";
  return "default";
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function iconFor(attack) {
  return {
    color: FAMILY_COLORS[familyOf(attack)] || FAMILY_COLORS.default,
    shape: SHAPES[hashId(attack.id) % SHAPES.length],
    family: familyOf(attack),
  };
}

export function renderIconSvg(attack, r = 18) {
  const { color, shape } = iconFor(attack);
  const stroke = darken(color);
  switch (shape) {
    case "square":
      return `<rect x="${-r}" y="${-r}" width="${2*r}" height="${2*r}" rx="2" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "triangle":
      return `<polygon points="${pts(3, r, -90)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "diamond":
      return `<polygon points="0,${-r} ${r},0 0,${r} ${-r},0" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "hexagon":
      return `<polygon points="${pts(6, r, 0)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "pentagon":
      return `<polygon points="${pts(5, r, -90)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "star":
      return `<polygon points="${starPts(r)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "cross":
      return crossSvg(r, color, stroke);
    case "circle":
    default:
      return `<circle r="${r}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
  }
}

// Inline icon for use in HTML (e.g. inside a draggable chip). Returns a
// small standalone <svg> sized to inline with text.
export function iconChip(attack, size = 18) {
  const half = size / 2;
  return `<svg width="${size}" height="${size}" viewBox="-${half} -${half} ${size} ${size}" style="vertical-align:middle">${renderIconSvg(attack, half * 0.85)}</svg>`;
}

function pts(n, r, startDeg) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = ((startDeg + (360 / n) * i) * Math.PI) / 180;
    out.push(`${(r * Math.cos(t)).toFixed(1)},${(r * Math.sin(t)).toFixed(1)}`);
  }
  return out.join(" ");
}

function starPts(r) {
  const ri = r * 0.45;
  const out = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : ri;
    const t = ((-90 + 36 * i) * Math.PI) / 180;
    out.push(`${(rr * Math.cos(t)).toFixed(1)},${(rr * Math.sin(t)).toFixed(1)}`);
  }
  return out.join(" ");
}

function crossSvg(r, fill, stroke) {
  const t = r * 0.4;
  return `<g stroke="${stroke}" stroke-width="1.5" fill="${fill}">
    <rect x="${-t/2}" y="${-r}" width="${t}" height="${2*r}"/>
    <rect x="${-r}" y="${-t/2}" width="${2*r}" height="${t}"/>
  </g>`;
}

function darken(hex) {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = (((num >> 16) & 0xff) * 0.65) | 0;
  const g = (((num >> 8) & 0xff) * 0.65) | 0;
  const b = ((num & 0xff) * 0.65) | 0;
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}
