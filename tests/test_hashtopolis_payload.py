"""Tests for the Hashtopolis v2 supertask payload builder."""

from __future__ import annotations

from backend.models import ClusterSpec, PipelineStep, TargetSpec
from backend.pipeline import hashtopolis_payload


def _step(attack_id: str, label: str) -> PipelineStep:
    return PipelineStep(
        attack_id=attack_id,
        label=label,
        estimated_keyspace=1_000_000_000,
        estimated_seconds=1.2,
        expected_yield_pct=20.0,
    )


def test_build_payload_has_expected_top_level_keys():
    out = hashtopolis_payload.build(
        name="my-plan",
        pipeline=[_step("rockyou_best64", "rockyou + best64")],
        target=TargetSpec(hash_type="ntlm", hash_count=100),
        cluster=ClusterSpec(),
    )
    assert "request" in out and "payload" in out and "metadata" in out
    assert out["request"]["method"] == "POST"
    assert out["request"]["url"].endswith("/supertasks")
    assert out["payload"]["supertaskName"] == "my-plan"


def test_build_one_pretask_per_pipeline_step():
    pipeline = [_step("rockyou_best64", "rockyou + best64"), _step("mask_l8_d2", "?l×8 ?d×2")]
    out = hashtopolis_payload.build(
        name="multi",
        pipeline=pipeline,
        target=TargetSpec(hash_type="ntlm", hash_count=1),
        cluster=ClusterSpec(),
    )
    assert len(out["payload"]["pretasks"]) == 2
    assert out["payload"]["pretasks"][0]["taskName"].startswith("multi · 01 · ")
    assert out["payload"]["pretasks"][1]["taskName"].startswith("multi · 02 · ")


def test_metadata_is_preview_only():
    out = hashtopolis_payload.build(
        name="x",
        pipeline=[_step("a", "a")],
        target=TargetSpec(hash_type="ntlm", hash_count=1),
        cluster=ClusterSpec(),
    )
    assert out["metadata"]["preview_only"] is True
    assert out["metadata"]["step_count"] == 1


def test_mask_attack_command_uses_attack_mode_3():
    out = hashtopolis_payload.build(
        name="m",
        pipeline=[_step("mask_l6", "?l×6")],
        target=TargetSpec(hash_type="ntlm", hash_count=1),
        cluster=ClusterSpec(),
    )
    assert "-a 3" in out["payload"]["pretasks"][0]["attackCmd"]
