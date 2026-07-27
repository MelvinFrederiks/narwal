"""Build a Hashtopolis v2 supertask JSON payload from a Narwal plan.

Per the storyboard's "Send to Hashtopolis" CTA spec — preview-only mode
that returns the constructed payload + the URL/headers it would POST to,
without making any live call.

Hashtopolis v2 supertask schema (paraphrased from upstream docs):
  POST /api/v2/ui/supertasks  (multipart of pretasks, with a wrapper)

We construct a minimal but complete payload: one pretask per attack step,
chained in order, attached to the user's hashlist if present.
"""

from __future__ import annotations

import os
from typing import Any

from backend.models import (
    ClusterSpec,
    PipelineStep,
    TargetSpec,
)


def build(
    *,
    name: str,
    pipeline: list[PipelineStep],
    target: TargetSpec,
    cluster: ClusterSpec,
    base_url: str | None = None,
) -> dict[str, Any]:
    """Return a dict with `request` (URL/method/headers/body) and `payload`
    (the supertask JSON Hashtopolis v2 expects).
    """
    base = (base_url or os.getenv("HASHTOPOLIS_URL") or "http://hashtopolis:8080/api/v2").rstrip("/")
    api_key = os.getenv("HASHTOPOLIS_API_KEY", "<your-api-key-here>")

    pretasks = []
    for i, step in enumerate(pipeline, start=1):
        pretasks.append(
            {
                "taskName": f"{name} · {i:02d} · {step.label}",
                "attackCmd": _attack_cmd_for(step),
                "chunkTime": 600,
                "statusTimer": 5,
                "color": "1F77B4",
                "isCpuTask": False,
                "isSmall": False,
                "useNewBench": True,
                "priority": 1000 - i,
                # Attached files / wordlists / rules go here in a real call —
                # users pre-upload them to Hashtopolis and reference by id.
            }
        )

    supertask = {
        "supertaskName": name,
        "pretasks": pretasks,
    }

    return {
        "request": {
            "method": "POST",
            "url": f"{base}/ui/supertasks",
            "headers": {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        },
        "payload": supertask,
        "metadata": {
            "target_hash_type": target.hash_type,
            "target_hash_count": target.hash_count,
            "cluster": cluster.model_dump(),
            "step_count": len(pretasks),
            "estimated_total_seconds": sum(s.estimated_seconds for s in pipeline),
            "preview_only": True,
            "note": (
                "This is the payload Narwal would POST to Hashtopolis. "
                "No live call made. Set HASHTOPOLIS_URL and HASHTOPOLIS_API_KEY "
                "env vars and use a proper REST client to dispatch."
            ),
        },
    }


def _attack_cmd_for(step: PipelineStep) -> str:
    """Reconstruct an approximate hashcat command for the step.

    The label encodes enough to round-trip a reasonable command. A real
    integration would carry the structured attack spec end-to-end.
    """
    label = step.label.lower()
    if label.startswith("?"):
        return f"-a 3 #HL# {step.label}"
    if "rules" in label or "+" in label:
        # Wordlist + rules
        return f"-a 0 #HL# #WL# -r #RULE#"
    if " straight" in label or label.endswith(" straight"):
        return f"-a 0 #HL# #WL#"
    return f"#HL# {step.label}"
