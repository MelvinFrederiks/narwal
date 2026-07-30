// Scene registry. Drop a new scene module here to make it appear in
// the nav bar. A scene exports `name` and `render(mountEl)`.

import * as home from "./home.js";
import * as keyspace from "./keyspace.js";
import * as analysisResults from "./analysis_results.js";
import * as overlap from "./overlap.js";

export const scenes = [
  { id: "home", label: "Home", module: home },
  { id: "keyspace", label: "Mask file analysis", module: keyspace },
  { id: "analysis-results", label: "Analysis results", module: analysisResults },
  { id: "overlap", label: "Overlap", module: overlap },
];
