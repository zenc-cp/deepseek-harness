# Agent Note: Python packaged-runtime snapshots pin graph events and zero trace clocks

Status: implemented

English | [中文](2026-09-09-python-packaged-runtime-graph-event-snapshots.zh.md)

## Problem

The turn/step graph now appends `session/checkpoint-node` and `session/trace-node` events to the Python SDK result and durable logs. Required packaged-runtime CI compares those transcripts byte-for-byte against `scripts/snapshots/python-sdk-single-exe/`. The previous baselines omitted the events, and each `session/trace-node` payload carries wall-clock `startedAt` and `durationMs` values that change across runs even when node identity, routing, visits, claimed messages, and event order stay the same.

## Decision

[The packaged-runtime smoke](../../../../scripts/smoke-python-runtime.py) keeps both graph event types in the reviewed expected output. `normalize_snapshot_value` zeros only numeric `data.startedAt` and `data.durationMs` on a `session/trace-node` event, including the same payload when it is wrapped as a `session.event` notification. Nested state fields with those names, checkpoint payloads, other event types, incomplete traces, visit counts, routes, claimed messages, and event order remain compared.

`python/sdk/tests/test_smoke_model.py` owns that boundary without launching a runtime. The `sdk-snapshot` and `sdk-restart` expected files under `scripts/snapshots/python-sdk-single-exe/` record the graph events with those two clocks already zeroed.

## Alternatives considered

**Drop checkpoint and trace events from the Python snapshots.** Rejected because those events are now part of the assembled SDK transcript. Omitting them would let a missing, reordered, or semantically changed graph event pass packaged-runtime CI.

**Zero every `startedAt` and `durationMs` field, or whole checkpoint payloads.** Rejected because nested state clocks and checkpoint contents can distinguish routing, visits, claimed messages, and outcomes. Broad scrubbing would hide those changes.

**Keep raw trace clocks in the committed files.** Rejected because each CI host writes different timestamps and durations, so the same graph behavior would fail the snapshot comparison.

**Refresh the baselines without a unit test.** Rejected because a later recorder could reintroduce volatile clocks or drop the events. The pytest cases fail first when either clock is left live or a graph-event distinction is lost.

## Consequences

A Python packaged-runtime snapshot now fails when a graph event is missing, reordered, or semantically changed, and it stays stable across hosts for identical graph behavior. Reviewers still inspect the checkpoint and trace payloads, including claimed sandbox and approval text captured in those events. The SEA Windows executable was not rebuilt here; local verification used the staged node carrier. Issue-policy GitHub App inputs remain a separate repository-configuration failure.
