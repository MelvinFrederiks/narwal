// Scene registry. Drop a new scene module here to make it appear in
// the nav bar. A scene exports `name` and `render(mountEl)`.

import * as keyspace from "./keyspace.js";
import * as analysisResults from "./analysis_results.js";

export const scenes = [
  { id: "keyspace", label: "Keyspace viz", module: keyspace },
  { id: "analysis-results", label: "Analysis results", module: analysisResults },
];
