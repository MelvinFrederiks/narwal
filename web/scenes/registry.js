// Scene registry. Drop a new scene module here to make it appear in
// the nav bar. See wiki/extending.md "Adding a new visualization".
//
// Order mirrors the storyboard: Setup → Composer → Coverage → Heatmap →
// Overlap → Cluster → Verdict → Architecture. Compare is an overflow
// view (all-datasets-on-one-chart) kept after Coverage's two-dataset mode.

import * as home from "./home.js";
import * as setup from "./setup.js";
import * as compose from "./compose.js";
import * as coverage from "./coverage.js";
import * as compare from "./compare.js";
import * as mergeability from "./mergeability.js";
import * as heatmap from "./heatmap.js";
import * as keyspace from "./keyspace.js";
import * as overlap2 from "./overlap_2.js";
import * as overlapMany from "./overlap_many.js";
import * as cluster from "./cluster.js";
import * as verdict from "./verdict.js";
import * as architecture from "./architecture.js";

export const scenes = [
  { id: "home", label: "Home", module: home },
  { id: "setup", label: "Setup", module: setup },
  { id: "coverage", label: "Coverage", module: coverage },
  { id: "compare", label: "Compare", module: compare },
  { id: "mergeability", label: "Mergeability", module: mergeability },
  { id: "heatmap", label: "Heatmap", module: heatmap },
  { id: "keyspace", label: "Keyspace viz", module: keyspace },
  { id: "overlap-2", label: "Overlap · pair", module: overlap2 },
  { id: "overlap-many", label: "Overlap · network", module: overlapMany },
  { id: "cluster", label: "Cluster", module: cluster },
  { id: "compose", label: "Composer", module: compose },
  { id: "verdict", label: "Verdict", module: verdict },
  { id: "architecture", label: "Architecture", module: architecture },
];
