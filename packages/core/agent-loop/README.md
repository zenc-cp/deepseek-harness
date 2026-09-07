---
description: "The default agent driver for users and maintainers choosing, configuring, or debugging how agents are created and how turns and steps run."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop` creates agents — fresh or resumed from persisted history — and runs the turn and step lifecycle that claims prompts, assembles requests, streams model responses, dispatches tool calls, and appends every result back to the session log.
As the default driver it implements the `Agent` interface from `dsh-agent` and registers its factory there, so plugins create and drive agents through `ctx.agents` without depending on this package.
Declarative config entries start agents automatically at boot, and `maxParallelToolCalls` caps how many parallel-safe tool calls run at once.
It is the harness's only concrete loop — everything beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy.
Choose it as the driver for standard compositions; swap it by implementing `Agent` and registering through `ctx.agents`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-agent-loop` in any composition that should run agents.
It supplies the driver behind `ctx.agents` and starts any agents you declare in its config; the standard demo composition is [`examples/agent-spine-demo`](../../../packages/examples/agent-spine-demo/README.md).

### Configure declarative agents

Agents declared in the config start automatically when the plugin loads.
Each entry needs an `id` label; a model call additionally requires both `provider` and `model` (`agent/request` may supply a missing pair before dispatch).

```yaml
- name: '@deepseek-ai/dsh-agent-loop'
  config:
    maxParallelToolCalls: 10
    agents:
      - id: 'main'
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: high
        cwd: /workspace
```

| Field | Default | Meaning |
|---|---|---|
| `maxParallelToolCalls` | `10` | Parallel-safe tool calls in flight per step; `1` is serial |
| `agents[].id` | required | Stable label; a fresh session mints `${id}-session-<uuid>` unless `sessionId` is set |
| `agents[].provider` / `agents[].model` | — | Model route; both required before dispatch |
| `agents[].reasoningEffort` | — | Non-empty initial reasoning effort; `agent/request` may override it |
| `agents[].maxTokens` | — | Positive per-request output-token cap |
| `agents[].cwd` | — | Workspace directory for a fresh session |
| `agents[].sessionId` | — | Exact identity: first use creates, a remount resumes materialized history |
| `agents[].resumeSessionId` | — | Load this persisted session instead of creating one; mutually exclusive with `sessionId` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-loop) is the exhaustive source for every accepted field.
The adapter validates the effective reasoning effort and the loop records it in the request header.
`maxParallelToolCalls` is also the whole `agent-loop` settings section, so a user layer over this entry caps the next tool group without a restart.

### Create or resume agents programmatically

Plugins and hosts create agents through `ctx.agents.create()` and resume persisted sessions through `ctx.agents.resume()`; both return an `AgentHandle` whose `dispose()` owns exact teardown.
The loop runs every created agent to completion — callers only need the handle when they must tear an agent down themselves.

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx) => { /* scoped tools, prompt sections, listeners */ },
})
```

### What a step does

Every step sends the agent's rendered system prompt, its visible tool schemas, and the session's derived history; tool calls from the model pass through the guarded tool pipeline and every accepted fact is appended to the session log before the next step derives from it.
Parallel-safe calls may overlap up to `maxParallelToolCalls`; exclusive calls run alone and form an ordering barrier.
Cancellation is cooperative: `agent.cancel()` aborts the current activity and clears pending work unless `keepInbox` is set; cancelled streams finalize text already delivered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

This section explains how the package fulfills the behaviour above; observable contracts are fully described in [Use this package](#use-this-package).

### Design philosophy

This package is the only concrete implementation of the public `Agent` contract.
It registers itself as the `AgentFactory` on `ctx.agents`, so consumers never import this package; ownership of every created agent belongs to the caller fiber AND the loop provider, fused into one memoized full-quiescence boundary.
Every observable effect happens through session events and the `agent/*` taxonomy — the package internals are never part of the public surface.

### Request headers & adapter defaults

After `agent/request` returns, `ctx.llm.prepareCall()` validates adapter-held fields under the active turn signal and resolves reasoning-effort and output-token defaults.
The loop keeps the same adapter across resolution, `request/header` recording, and dispatch.
The loop writes a full header for first requests, a changed envelope, an explicit start-of-messages anchor, a surface replacement, and resume; unchanged-content steps, retries, and plain successor turns inherit the latest header.
The loop strips adapter-default fields before the next waterfall, so the current route re-resolves them; explicit settings stay.
Unresolved routes still fail with `NO_ADAPTER`.

### Source map

| File | Purpose |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `AgentLoop` service, config schema, declarative agent startup, factory registration |
| [`src/agent.ts`](src/agent.ts) | Concrete `ReactLoopAgent` driver: inbox, turn/step state machine, cancellation |
| [`src/tool-calls.ts`](src/tool-calls.ts) | Tool dispatch: exclusive barrier and bounded parallel pool |
| [`src/constants.ts`](src/constants.ts) | Exposed `DEFAULT_MAX_PARALLEL_TOOL_CALLS` constant |
| [`src/runtime-context.ts`](src/runtime-context.ts) | Projected scoped context for tool execution and prompt rendering |
| [`src/turn-step-state.ts`](src/turn-step-state.ts) | Versioned frozen turn/step State, pure nodes, routers, visit caps, graph validation, checkpoints, trace, and failure edges |
| [`tests/`](tests/) | In-memory tests for the concrete driver and tool-calls runtime |

### Creation and teardown

Creation is one rollback-protected transaction: construct the private session, concrete agent and scoped context; await optional setup; enter both registries; announce `session/created` and `agent/created`; emit `agent/session-start`; only then start the driver.
Setup failure, commit failure or owner disposal rolls back without publishing either id.
Teardown stops and drains, revokes scope, detaches the agent, then detaches the session.
Each detach is bound to the exact registered object so an old disposer cannot remove a later replacement with the same id.

### Turn and step flow

The driver owns an agent throughout its lifetime and runs inside `ctx.agents.withInitiator(agent, ...)`.
At a turn boundary it opens the durable turn before atomically claiming pending next-step input and one queued prompt; between steps it claims only next-step input.
`agent/pre-step` decides what enters the step.
Each successful model call appends one `assistant/message` anchor referencing its chunk sequences; cancelled streams append an `interrupted: true` anchor with the delivered prefix so the next request includes what the user saw.
Exclusive calls form barriers, parallel-safe calls use a bounded rolling pool, and policy, durable results and result context retain model order.

### Failure and cancellation

Final adapter selection, dispatch and iteration failures reach `agent/request-error` as terminal finishes.
A listener owning recovery returns `{ kind: 'retry' }` without calling `next()`; unhandled failures are terminal.
Middleware, result processing, tools and other extension failures still throw and close the turn, not the loop.
Undispatched model tool calls receive synthetic `tool/call` and `ABORTED_BEFORE_DISPATCH` result pairs after cancellation.
The [explicit cancellation decision](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md) owns signal lifecycle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent package](../agent/README.md): the `Agent` handle, registry and `agent/*` events implemented by this loop.
- [Core subsystem](../../../docs/subsystems/core.md): turn flow and interception decisions.
- [Session subsystem](../../../docs/subsystems/session.md): the durable log written and projected by the loop.
- [Tools subsystem](../../../docs/subsystems/tools.md): the dispatch pipeline.
- [Explicit cancellation Agent Note](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md): signal lifecycle and cancellation races.
- [Core group map](../README.md): composition of core packages.
- [Subagent lifecycle](../../../docs/subsystems/subagent.md): owned sessions, continuation, inbox routing.
- [Session checkpoint policy](../../../packages/session/session-checkpoint-policy/README.md): durability of the event log.
- [Turn/step state source](src/turn-step-state.ts): declarations and validation for the turn/step graph; this source link is not an audit certification.

-----

<a id="model-experience"></a>
## Model Experience

<details>
<summary>Guidance for models reading this package — click to expand</summary>

### Complete conversation request

#### What the model sees

Each step sends the rendered system prompt, visible tool schemas and derived session messages.
The loop supplies `provider`, `model` and `cwd` variables but no fixed wording.

#### Token impact

System text and schemas count again each step.
Per-agent scope determines contributions; the authoritative assembly waterfall can change the final request, with its listeners responsible for protocol coherence.

#### KV Cache impact

Requests remain append-only only on the same provider/model route with byte-identical system text, schemas and previous history.
Token-bearing assembly rewrites or composition changes may invalidate reuse from the first changed token.

### Retained message history

#### What the model sees

Accepted user and assistant messages, tool calls/results, injected context and steering are recorded and sent in later steps.
Raw chunks, lifecycle boundaries and other log-only events are excluded.

#### Token impact

Input grows with each surface message until compaction supersedes older nodes.
Multi-step tool turns resend accumulated history each step.

#### KV Cache impact

Ordinary history growth appends and preserves reusable entries.
Surface replacement or compaction invalidates reuse from the first superseded historical token.

### Undispatched calls after cancellation

#### What the model sees

If a later request replays an aborted step, every tool call prevented from dispatch has error code `ABORTED_BEFORE_DISPATCH` and result text `Error: tool call aborted before dispatch`.

#### Token impact

Each skipped call retains a fixed error result in history until compaction supersedes it.

#### KV Cache impact

Append-only: each synthetic result follows the reusable request prefix and does not invalidate existing KV Cache entries.

The `ReactLoopAgent` is the default concrete Agent driver.
It does not own any prompt, tool definition, or system-prompt section — those are registered and composed by plugins through the scoped context created for each agent.
Work that involves "making the agent loop do something different" should almost always be done through plugin hooks (`agent/pre-step`, `agent/turn-stopping`, `tools/pre-execute`, `tools/post-execute`, session events) rather than by modifying the loop itself.

</details>

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Classification is unary**: calls whose safety depends on comparing sibling calls or resources must remain exclusive ([rationale](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)).
- **Configured labels create fresh sessions by default**: omitting `sessionId` creates `${id}-session-<uuid>` on each boot.
Exact resume-or-create requires an explicit stable `sessionId`; `resumeSessionId` requires existing persisted history.
- **Configured agents have no per-agent persona field or setup hook**: they use the deployment persona.
Only programmatic `ctx.agents.create()` / `resume()` factory options support scoped persona and tool composition.
- **No built-in turn budget**: tool calls or steering can continue the turn.
Policies limiting runaway turns must cancel through existing lifecycle extension points such as `agent/turn-stopping`.
- `publishNode` appends `session/checkpoint-node` and `session/trace-node` to the session log.
Persistence and flush guarantees belong to the configured backend; appending is not proof of a completed durable flush.
`Session.append()` explicitly marks these two informational event types with `ignorable: true`; other event types remain required by default. This applies to newly appended events and does not retrofit existing persisted records.
- `agents.resume` does not automatically select the latest node checkpoint from history.
`ResumeAgentOptions.turnStepCheckpoint` accepts an explicit checkpoint, parsed before publication.
- The special resume path is restricted to a running `apply-pre-step` checkpoint with `requestHeaderLogged`, an `enter` or `reject` pre-step decision, and the same session id.
It skips the normal pre-step and `step()` bodies.
It is not a general arbitrary-node continuation mechanism.
If the claimed-message router requires `enter-step`, the turn ends with structured error `CHECKPOINT_RESUME_UNSUPPORTED`: the seed does not reconstruct unfinished step effects. This refuses unsupported continuation rather than recording null or falsely reporting completion.
- Declared node boundaries do not expose every branch or retry inside the effectful `step()` body.
Passing tests and documentation gates do not establish complete crash recovery or exactly-once effects.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`TurnStepState` (`src/turn-step-state.ts`) is the versioned frozen snapshot for one turn/step.
It is not `SESSION_FORMAT_VERSION` and not session-checkpoint-policy.
State v2 declares three nodes: `applyPreStepDecision` (pure), `step` (effectful boundary), and `applyStepOutcome` (pure).
The `step()` body (model streaming, session writes, retries, tools) is the declared boundary between `route-claimed` and `apply-step-outcome`; `publishNode` checkpoints and traces it.
`routeStep` maps its outcome to `step-completed` / `step-max-tokens` / `step-tool-calls` / `step-error`.
`routePreStep`, `routeClaimed`, and `routeStepOutcome` declare the main path.
After a completed declared node, `turn()` can take the route from `resumeTurnStep` (load last-good checkpoint, re-run cheap routing, do not re-run the completed node body).
That is not `agents.resume`.
`recordNodeVisit` independently caps declared nodes at `TURN_STEP_VISIT_CAPS` (256); those are graph rails, not product turn budgets, and request retry stays uncapped.
`validateTurnStepGraph` walks all declared nodes, routers, targets, caps, joins, reachability, and capped cycles before `kick()` runs a turn; it does not execute a node.
`TOOL_CALL_JOIN_POLICY` declares the existing tool effect-edge contract as `all`: bounded dispatch may overlap, results commit in model order, any result may conclude the turn, abort drains started calls and synthesizes unstarted results, and scheduler failure drains started calls then returns the first failure; `routeFailure` maps that fact to `stop-turn` before `throwError`.
`checkpointAfterNode` freezes last-good State after each node; `ReactLoopAgent.lastNodeCheckpoint` holds the latest one in memory (cleared at `kick()` start).
`publishNode` also appends a `session/checkpoint-node` event; persistence and compatibility limitations are listed above.
`traceAfterNode` records an in-memory `TurnStepTraceEntry` (node, turn, step, start, duration, frozen State) immediately after that checkpoint; `ReactLoopAgent.nodeTrace` is the completed declared-node path for the current kick and is also cleared at `kick()` start.
`publishNode` also appends a `session/trace-node` event, subject to the persistence and compatibility limitations above.
The `step()` boundary is recorded; internal retries and sub-operations do not each produce declared-node entries.
`applyTurnStepFailure` writes `{ message, code }` onto `failure`; `routeFailure` maps null to `continue` and facts to `stop-turn`.
Visit caps still throw.
After `agent/request-error`, `step()` switches on `routeRequestError` (via `applyRequestError` writing `retry` / `throw`).
That is not `routeFailure`.
`routeClaimed` declares `enter-step`, `complete-turn`, and `preserve-turn-end`; the latter keeps an already-decided turn end when a continuation is rewritten to empty.
Normal turns run `preStep` / `step`; the restricted explicit-checkpoint exception and its unsupported-effect rejection are described in Known Limitations above.

Field mapping from the live `Phase`, inbox queues, `PreparedStep`, `requestHeaderLogged`, and `requestSurfaceGeneration` lives in that module.

</details>