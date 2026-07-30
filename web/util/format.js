// Shared percentage formatting — used by every scene so a share/coverage
// value reads the same way everywhere:
//   · exactly 0 (no results)  -> "0%", always, never rounded off some other
//     way
//   · >= 0.1%                 -> rounded to 1 decimal place
//   · > 0 and < 0.1%          -> exactly 1 significant digit, in plain
//     decimal notation (e.g. "0.00002%") — never "<0.1%" and never
//     scientific notation, so a real but tiny result never reads as absent
//     or as an unreadable exponent.

export function round1(x) {
  return Math.round(x * 10) / 10;
}

// Magnitude only (no "%"/"pp" suffix), for callers that append their own
// unit — e.g. a legend tick or a signed percentage-point difference.
export function formatPercentMagnitude(pct) {
  if (!(pct > 0)) return "0";
  if (pct >= 0.1) return String(round1(pct));
  const exp = Math.floor(Math.log10(pct));
  const digits = Math.min(100, Math.max(0, -exp)); // toFixed's max is 100
  return pct.toFixed(digits);
}

// `pct` on the 0-100 scale (not a 0-1 fraction).
export function formatPercent(pct) {
  return `${formatPercentMagnitude(pct)}%`;
}

// For a signed value (e.g. a percentage-point difference) where the sign
// still needs to be shown but 0 shouldn't get a "+"/"-" in front of it.
export function formatSignedPercent(v, unit = "%") {
  if (!v) return `0${unit}`;
  const sign = v > 0 ? "+" : "-";
  return `${sign}${formatPercentMagnitude(Math.abs(v))}${unit}`;
}
