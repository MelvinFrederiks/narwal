// Two-circle area-proportional Venn geometry.
//
// Circle areas track each side's total and the lens area tracks the shared
// total, so all three regions read at one scale. Without solving for the
// centre distance the overlap width would be arbitrary and the picture would
// misrepresent the numbers.

// Area of the lens formed by two overlapping circles at centre distance d.
export function lensArea(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  return (
    r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)) +
    r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2)) -
    0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  );
}

// Invert lensArea for d. It decreases monotonically in d, so bisection is
// both sufficient and unconditionally stable here.
export function solveDistance(r1, r2, target) {
  const touching = r1 + r2;
  const contained = Math.abs(r1 - r2);
  if (target <= 0) return touching;
  if (target >= Math.PI * Math.min(r1, r2) ** 2) return contained;
  let lo = contained;
  let hi = touching;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lensArea(r1, r2, mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Lay out two circles for the given totals. `gap` separates them when there
// is no overlap at all, so disjoint sets read as visibly disjoint rather than
// merely tangent. Returns null when both sides are empty.
export function vennLayout(totalA, totalB, shared, { rMax = 108, pad = 34, gap = 14 } = {}) {
  const maxT = Math.max(totalA, totalB);
  if (!maxT) return null;

  const rA = rMax * Math.sqrt(totalA / maxT);
  const rB = rMax * Math.sqrt(totalB / maxT);
  const pxPerItem = (Math.PI * rMax * rMax) / maxT;
  const d = shared > 0 ? solveDistance(rA, rB, shared * pxPerItem) : rA + rB + gap;

  const width = pad * 2 + rA + d + rB;
  const height = pad * 2 + 2 * Math.max(rA, rB);
  const cx1 = pad + rA;
  const cx2 = cx1 + d;
  const cy = height / 2;

  // Horizontal midpoint of each region, for label placement. When the circles
  // are disjoint the shared midpoint is meaningless — callers skip that label
  // because `shared` is 0 anyway.
  const aL = cx1 - rA, aR = cx1 + rA;
  const bL = cx2 - rB, bR = cx2 + rB;

  return {
    rA, rB, d, width, height, cx1, cx2, cy, pxPerItem,
    xOnlyA: (aL + Math.min(aR, bL)) / 2,
    xOnlyB: (Math.max(bL, aR) + bR) / 2,
    xShared: (Math.max(aL, bL) + Math.min(aR, bR)) / 2,
  };
}
