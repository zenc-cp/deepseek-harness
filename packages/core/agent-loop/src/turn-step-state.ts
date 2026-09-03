/**
 * Versioned immutable snapshot for one DSH turn/step (graph-architect slice 1).
 *
 * This is not `SESSION_FORMAT_VERSION` and not session-checkpoint-policy.
 * `applyPreStepDecision` is the first pure node. `routePreStep` is the first
 * declared router (`PRE_STEP_ROUTER_TARGETS`). `recordNodeVisit` caps
 * `apply-pre-step`. `validateTurnStepGraph` walks `TURN_STEP_GRAPH` before
 * `kick()` runs a turn. `checkpointAfterNode` freezes last-good State after a
 * declared node (in-memory; not session-checkpoint-policy). `resumeTurnStep`
 * loads that checkpoint and re-runs cheap routing without the node body.
 * `turn()` carries visits across iterations. `applyTurnStepFailure` writes
 * routable `{ message, code }` facts; `routeFailure` maps them to
 * `continue` / `stop-turn`. `applyRequestError` writes `retry` / `throw`;
 * `routeRequestError` maps them. `routeClaimed` declares empty-claimed exits.
 * Visit cap stays a throw. Tool-scheduler join failure is returned as data
 * then routed with `routeFailure`. `preStep` / `step` bodies are not rewritten.
 *
 * Field mapping from the current loop:
 * - `phaseKind`, `wakeRequested`, `abortCause` <- mutable `Phase` (`AbortController` stays live)
 * - `inbox` / `claimed` / `claimTarget` <- live `Inbox` queues copied at snapshot time
 * - `preStep` / `startsRequestSeries` <- `PreparedStep` / `PreStepDecision`
 * - `requestError` <- `agent/request-error` retry|throw (`applyRequestError`)
 * - `stepEnd` / `turnEnd` <- `StepEndReason` / `TurnEndReason`
 * - `route` / `requestHeaderLogged` / `surfaceGeneration` <- `buildRequest` locals
 * - `visits` <- per-node graph visit counts (`apply-pre-step` this slice)
 * - checkpoint `{ schemaVersion, node, state }` <- last-good after a node
 * - resume `{ state, route }` <- load checkpoint + `routePreStep` (no node body)
 * - `failure` <- routable `{ message, code }` facts (`applyTurnStepFailure`)
 *
 * @module dsh-agent-loop/turn-step-state
 */

import type { InboxTarget, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { MessageId, ProviderRequestId, type LlmFailure, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type AgentCancelCause, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { assertNever, deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { TOOL_CALL_JOIN_POLICY, type ToolCallJoinPolicy } from './tool-calls.ts'

/** Monotonic State schema version. Independent of the session log format. */
export const TURN_STEP_STATE_VERSION = 2 as const

/** Resume of a checkpoint whose `schemaVersion` is not {@link TURN_STEP_STATE_VERSION}. */
export class TurnStepStateVersionError extends Error {
  /** The only version this build reads. */
  readonly expected = TURN_STEP_STATE_VERSION

  /**
   * @param found - the value at `schemaVersion`, or the whole input when it is not an object.
   */
  constructor(readonly found: unknown) {
    super(`turn/step State schemaVersion mismatch: expected ${TURN_STEP_STATE_VERSION}, found ${String(found)}`)
    this.name = 'TurnStepStateVersionError'
  }
}

/** A v2 snapshot that is the right version but not a valid State object. */
export class TurnStepStateInvalidError extends Error {
  /** @param message - stable reason the snapshot is not v2 State. */
  constructor(message: string) {
    super(message)
    this.name = 'TurnStepStateInvalidError'
  }
}

/** Declared graph failed pre-run validation. Does not execute a node. */
export class TurnStepGraphInvalidError extends Error {
  /** @param reason - stable first failing check. */
  constructor(readonly reason: string) {
    super(`turn/step graph is invalid: ${reason}`)
    this.name = 'TurnStepGraphInvalidError'
  }
}

/** A node visit exceeded {@link TURN_STEP_VISIT_CAPS}. Early error, not a routable `failure`. */
export class TurnStepVisitCapError extends Error {
  /**
   * @param node - declared node id that exceeded its cap.
   * @param cap - maximum allowed visits for that node.
   * @param found - visit count after the increment that overflowed.
   */
  constructor(
    readonly node: TurnStepNodeId,
    readonly cap: number,
    readonly found: number,
  ) {
    super(`turn/step visit cap exceeded: node ${node} cap ${cap} found ${found}`)
    this.name = 'TurnStepVisitCapError'
  }
}

/** Timing for an in-memory declared-node trace entry is invalid. */
export class TurnStepTraceInvalidError extends Error {
  /** @param message - stable reason the timestamps cannot form a trace entry. */
  constructor(message: string) {
    super(message)
    this.name = 'TurnStepTraceInvalidError'
  }
}

const STATE_KEYS = [
  'schemaVersion',
  'sessionId',
  'turn',
  'step',
  'phaseKind',
  'wakeRequested',
  'abortCause',
  'claimTarget',
  'inbox',
  'claimed',
  'preStep',
  'startsRequestSeries',
  'requestError',
  'stepEnd',
  'turnEnd',
  'route',
  'surfaceGeneration',
  'requestHeaderLogged',
  'failure',
  'visits',
] as const

const PHASE_KINDS = ['idle', 'maintenance', 'running'] as const
const PRE_STEP_KINDS = ['pending', 'enter', 'reject'] as const
const REQUEST_ERROR_KINDS = ['none', 'retry', 'throw'] as const
const CLAIM_TARGETS = ['next-turn', 'next-step'] as const
const STEP_END_KINDS = ['completed', 'max-tokens'] as const
const SIMPLE_TURN_END_KINDS = ['completed', 'blocked', 'max-tokens', 'interrupted'] as const
const MESSAGE_KEYS = ['id', 'role', 'content', 'source'] as const
const INBOX_KEYS = ['nextTurn', 'nextStep'] as const
const ROUTE_KEYS = ['provider', 'model'] as const
const FAILURE_KEYS = ['message', 'code'] as const
const LLM_FAILURE_KEYS = ['message', 'code', 'status', 'providerRetryAfterMs', 'requestId'] as const

/** Driver reservation kind copied from the live `Phase` union. */
export type TurnStepPhaseKind = (typeof PHASE_KINDS)[number]

/** `preStep` waterfall outcome, plus `pending` before that node runs. */
export type TurnStepPreStepKind = (typeof PRE_STEP_KINDS)[number]

/** Explicit `routePreStep` destinations. Empty-claimed shortcuts stay in `turn()`. */
export const PRE_STEP_ROUTER_TARGETS = ['block-turn', 'enter-step'] as const

/** One destination from {@link PRE_STEP_ROUTER_TARGETS}. */
export type PreStepRouterTarget = (typeof PRE_STEP_ROUTER_TARGETS)[number]

/** Explicit `routeFailure` destinations. Visit cap and `request-error` stay separate. */
export const FAILURE_ROUTER_TARGETS = ['continue', 'stop-turn'] as const

/** One destination from {@link FAILURE_ROUTER_TARGETS}. */
export type FailureRouterTarget = (typeof FAILURE_ROUTER_TARGETS)[number]

/** Explicit `routeRequestError` destinations. `none` is pending, not a target. */
export const REQUEST_ERROR_ROUTER_TARGETS = ['retry', 'throw'] as const

/** One destination from {@link REQUEST_ERROR_ROUTER_TARGETS}. */
export type RequestErrorRouterTarget = (typeof REQUEST_ERROR_ROUTER_TARGETS)[number]

/** Explicit `routeClaimed` destinations after an entered pre-step decision. */
export const CLAIMED_ROUTER_TARGETS = [
  'enter-step',
  'complete-turn',
  'preserve-turn-end',
] as const

/** One destination from {@link CLAIMED_ROUTER_TARGETS}. */
export type ClaimedRouterTarget = (typeof CLAIMED_ROUTER_TARGETS)[number]

/** Explicit destinations after the pure `apply-step-outcome` node. */
export const STEP_OUTCOME_ROUTER_TARGETS = ['finish-turn', 'next-pre-step'] as const

/** One destination from {@link STEP_OUTCOME_ROUTER_TARGETS}. */
export type StepOutcomeRouterTarget = (typeof STEP_OUTCOME_ROUTER_TARGETS)[number]

/** Declared graph nodes that may carry a visit cap. */
export const TURN_STEP_NODES = ['apply-pre-step', 'apply-step-outcome'] as const

/** One id from {@link TURN_STEP_NODES}. */
export type TurnStepNodeId = (typeof TURN_STEP_NODES)[number]

/** Per-node visit budgets. Graph safety rail, not a product turn budget. */
export const TURN_STEP_VISIT_CAPS: { readonly [K in TurnStepNodeId]: number } = {
  'apply-pre-step': 256,
  'apply-step-outcome': 256,
}

/** Frozen per-node visit counts. Exact keys = {@link TURN_STEP_NODES}. */
export type TurnStepVisits = { readonly [K in TurnStepNodeId]: number }

const CHECKPOINT_KEYS = ['schemaVersion', 'node', 'state'] as const
const GRAPH_KEYS = ['entry', 'nodes', 'routers', 'terminals', 'edges', 'caps', 'joins'] as const
const ROUTER_IDS = ['route-pre-step', 'route-claimed', 'route-step-outcome'] as const
const ROUTER_KEYS = ['after', 'targets'] as const
const NODE_EDGE_KEYS = ['from', 'to'] as const
const ROUTER_EDGE_KEYS = ['from', 'on', 'to'] as const
const JOIN_IDS = ['tool-calls'] as const
const JOIN_KEYS = ['onEdge', 'policy'] as const
const JOIN_POLICY_KEYS = ['kind', 'commitOrder', 'conclusion', 'abort', 'schedulerFailure'] as const

/** Static declared pre-step graph. `step()` stays on the enter-step edge, not a node. */
export interface TurnStepGraph {
  readonly entry: TurnStepNodeId
  readonly nodes: readonly TurnStepNodeId[]
  readonly routers: {
    readonly 'route-pre-step': {
      readonly after: TurnStepNodeId
      readonly targets: readonly PreStepRouterTarget[]
    }
    readonly 'route-claimed': {
      readonly after: TurnStepNodeId
      readonly targets: readonly ClaimedRouterTarget[]
    }
    readonly 'route-step-outcome': {
      readonly after: TurnStepNodeId
      readonly targets: readonly StepOutcomeRouterTarget[]
    }
  }
  readonly terminals: readonly string[]
  readonly edges: readonly {
    readonly from: string
    readonly to: string
    readonly on?: string
  }[]
  readonly caps: TurnStepVisits
  readonly joins: {
    readonly 'tool-calls': {
      readonly onEdge: {
        readonly from: string
        readonly on: string
        readonly to: string
      }
      readonly policy: ToolCallJoinPolicy
    }
  }
}

/** Canonical graph `kick()` validates before the first turn. */
export const TURN_STEP_GRAPH: TurnStepGraph = deepFreeze({
  entry: 'apply-pre-step',
  nodes: [...TURN_STEP_NODES],
  routers: {
    'route-pre-step': {
      after: 'apply-pre-step',
      targets: [...PRE_STEP_ROUTER_TARGETS],
    },
    'route-claimed': {
      after: 'apply-pre-step',
      targets: [...CLAIMED_ROUTER_TARGETS],
    },
    'route-step-outcome': {
      after: 'apply-step-outcome',
      targets: [...STEP_OUTCOME_ROUTER_TARGETS],
    },
  },
  terminals: ['block-turn', 'complete-turn', 'preserve-turn-end', 'finish-turn'],
  edges: [
    { from: 'apply-pre-step', to: 'route-pre-step' },
    { from: 'route-pre-step', on: 'block-turn', to: 'terminal' },
    { from: 'route-pre-step', on: 'enter-step', to: 'route-claimed' },
    { from: 'route-claimed', on: 'complete-turn', to: 'terminal' },
    { from: 'route-claimed', on: 'preserve-turn-end', to: 'terminal' },
    { from: 'route-claimed', on: 'enter-step', to: 'apply-step-outcome' },
    { from: 'apply-step-outcome', to: 'route-step-outcome' },
    { from: 'route-step-outcome', on: 'finish-turn', to: 'terminal' },
    { from: 'route-step-outcome', on: 'next-pre-step', to: 'apply-pre-step' },
  ],
  caps: { ...TURN_STEP_VISIT_CAPS },
  joins: {
    'tool-calls': {
      onEdge: { from: 'route-claimed', on: 'enter-step', to: 'apply-step-outcome' },
      policy: TOOL_CALL_JOIN_POLICY,
    },
  },
})

/** `agent/request-error` action, plus `none` when no request failed. */
export type TurnStepRequestErrorKind = (typeof REQUEST_ERROR_KINDS)[number]

/** Step outcome the loop currently returns from `step()`. */
export type TurnStepStepEnd = { readonly kind: 'completed' } | { readonly kind: 'max-tokens' }

/** Uniform frozen snapshot every later graph node will take in and return. */
export interface TurnStepState {
  readonly schemaVersion: typeof TURN_STEP_STATE_VERSION
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly phaseKind: TurnStepPhaseKind
  readonly wakeRequested: boolean
  readonly abortCause: AgentCancelCause | null
  readonly claimTarget: InboxTarget
  readonly inbox: {
    readonly nextTurn: readonly UserMessage[]
    readonly nextStep: readonly UserMessage[]
  }
  readonly claimed: readonly UserMessage[]
  readonly preStep: TurnStepPreStepKind
  readonly startsRequestSeries: boolean
  readonly requestError: TurnStepRequestErrorKind
  readonly stepEnd: TurnStepStepEnd | null
  readonly turnEnd: TurnEndReason | null
  readonly route: {
    readonly provider: string
    readonly model: string
  }
  readonly surfaceGeneration: number | null
  readonly requestHeaderLogged: boolean
  readonly failure: { readonly message: string; readonly code: string } | null
  readonly visits: TurnStepVisits
}

/** Fields `evolveTurnStepState` may replace. `schemaVersion` stays 1. */
export type TurnStepStatePatch = Partial<Omit<TurnStepState, 'schemaVersion'>>

/** Last-good frozen record after a declared node. In-memory only; not a session event. */
export interface TurnStepCheckpoint {
  readonly schemaVersion: typeof TURN_STEP_STATE_VERSION
  readonly node: TurnStepNodeId
  readonly state: TurnStepState
}

/** One completed declared-node path entry. Agent-owned, not a session event. */
export interface TurnStepTraceEntry {
  readonly node: TurnStepNodeId
  readonly turn: number
  readonly step: number
  readonly startedAt: number
  readonly durationMs: number
  readonly state: TurnStepState
}

/** Load a checkpoint and re-run cheap routing. Does not re-run a node body. */
export type TurnStepResume =
  | {
    readonly state: TurnStepState
    readonly node: 'apply-pre-step'
    readonly route: PreStepRouterTarget
  }
  | {
    readonly state: TurnStepState
    readonly node: 'apply-step-outcome'
    readonly route: StepOutcomeRouterTarget
  }

/**
 * Clone and deep-freeze a v2 snapshot. Rejects functions, live handles, and
 * version mismatches before freeze.
 * @param state - candidate snapshot.
 * @returns a frozen v2 {@link TurnStepState}.
 */
export function freezeTurnStepState(state: TurnStepState): TurnStepState {
  return parseTurnStepState(state)
}

/**
 * Validate, re-brand ids, and freeze a JSON snapshot.
 * @param value - unknown JSON (or an in-memory snapshot).
 * @returns a frozen v2 {@link TurnStepState}.
 */
export function parseTurnStepState(value: unknown): TurnStepState {
  const found = foundVersion(value)
  if (found !== TURN_STEP_STATE_VERSION) throw new TurnStepStateVersionError(found)
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) {
    throw new TurnStepStateInvalidError('turn/step State must be lossless JSON (no functions or live handles)')
  }
  return deepFreeze(normalizeState(snapshot))
}

/**
 * Copy-on-write update. The input object stays frozen and JSON-equal.
 * @param state - previously frozen v2 snapshot.
 * @param patch - fields to replace.
 * @returns a new frozen snapshot.
 */
export function evolveTurnStepState(state: TurnStepState, patch: TurnStepStatePatch): TurnStepState {
  return parseTurnStepState({
    ...state,
    ...patch,
    schemaVersion: TURN_STEP_STATE_VERSION,
  })
}

/**
 * Write or clear routable failure facts. Not a graph node. Visit cap still
 * throws instead of using this field.
 * @param state - frozen snapshot from before the overlay.
 * @param failure - `{ message, code }` or `null` to clear.
 */
export function applyTurnStepFailure(
  state: TurnStepState,
  failure: { readonly message: string; readonly code: string } | null,
): TurnStepState {
  return evolveTurnStepState(state, { failure })
}

/**
 * Map frozen `failure` onto explicit targets. Null continues; facts stop the turn.
 * @param state - frozen snapshot after {@link applyTurnStepFailure} or a clean node.
 */
export function routeFailure(state: TurnStepState): FailureRouterTarget {
  return state.failure === null ? 'continue' : 'stop-turn'
}

/**
 * Write a request-recovery decision onto State. Does not write `failure`.
 * @param state - frozen snapshot from before the overlay.
 * @param kind - `retry` or `throw` from the `agent/request-error` waterfall.
 */
export function applyRequestError(state: TurnStepState, kind: RequestErrorRouterTarget): TurnStepState {
  return evolveTurnStepState(state, { requestError: kind })
}

/**
 * Map frozen `requestError` onto explicit targets. `none` is invalid here.
 * @param state - frozen snapshot after {@link applyRequestError}.
 */
export function routeRequestError(state: TurnStepState): RequestErrorRouterTarget {
  switch (state.requestError) {
    case 'none':
      throw new TurnStepStateInvalidError('requestError is none; apply a recovery decision before routing')
    case 'retry':
      return 'retry'
    case 'throw':
      return 'throw'
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      assertNever(state.requestError, 'request-error router')
  }
}

/**
 * Route an entered pre-step State by claimed messages and prior turn outcome.
 * @param state - frozen State after {@link applyPreStepDecision}.
 */
export function routeClaimed(state: TurnStepState): ClaimedRouterTarget {
  if (state.claimed.length > 0) return 'enter-step'
  if (state.turnEnd !== null) return 'preserve-turn-end'
  return state.claimTarget === 'next-turn' ? 'complete-turn' : 'enter-step'
}

/**
 * Second pure node: project the effectful step result and refreshed inbox onto State.
 * @param state - frozen State from before step effects.
 * @param outcome - completed, max-tokens, or null when tools continue the turn.
 * @param inbox - inbox snapshot after effects and any turn-stopping hook.
 */
export function applyStepOutcome(
  state: TurnStepState,
  outcome: TurnStepStepEnd | null,
  inbox: TurnStepState['inbox'],
): TurnStepState {
  const turnEnd = state.turnEnd?.kind === 'max-tokens'
    ? state.turnEnd
    : outcome
  return evolveTurnStepState(state, {
    inbox,
    stepEnd: outcome,
    turnEnd,
  })
}

/** Route the pure step-outcome node using its frozen outcome and inbox snapshot. */
export function routeStepOutcome(state: TurnStepState): StepOutcomeRouterTarget {
  return state.turnEnd !== null && state.inbox.nextStep.length === 0
    ? 'finish-turn'
    : 'next-pre-step'
}

/**
 * First pure node: write a pre-step enter/reject decision onto State.
 * Claiming, prompt assembly, and the waterfall stay in the driver.
 * @param state - frozen snapshot from before the decision is applied.
 * @param decision - `agent/pre-step` enter or reject.
 * @returns a new frozen snapshot.
 */
export function applyPreStepDecision(state: TurnStepState, decision: PreStepDecision): TurnStepState {
  if (decision.kind === 'reject') {
    return evolveTurnStepState(state, {
      preStep: 'reject',
      claimed: [],
      startsRequestSeries: false,
    })
  }
  return evolveTurnStepState(state, {
    preStep: 'enter',
    claimed: decision.messages,
    startsRequestSeries: decision.startsRequestSeries === true,
  })
}

/**
 * First declared router: map frozen `preStep` onto explicit targets.
 * Pending State is invalid here; apply a decision first.
 * @param state - frozen snapshot after {@link applyPreStepDecision}.
 * @returns `block-turn` or `enter-step`.
 */
export function routePreStep(state: TurnStepState): PreStepRouterTarget {
  switch (state.preStep) {
    case 'pending':
      throw new TurnStepStateInvalidError('preStep is pending; apply a decision before routing')
    case 'reject':
      return 'block-turn'
    case 'enter':
      return 'enter-step'
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      assertNever(state.preStep, 'pre-step router')
  }
}

/**
 * Freeze last-good State after a declared node. Input State stays frozen.
 * @param state - frozen snapshot the node just returned.
 * @param node - declared node that completed.
 */
export function checkpointAfterNode<N extends TurnStepNodeId>(
  state: TurnStepState,
  node: N,
): TurnStepCheckpoint & { readonly node: N } {
  const parsed = parseTurnStepCheckpoint({
    schemaVersion: TURN_STEP_STATE_VERSION,
    node,
    state,
  })
  return deepFreeze({ ...parsed, node })
}

/**
 * Freeze a completed declared-node path entry from last-good checkpoint State.
 * Timing is instrumentation, not State. Invalid timestamps throw
 * {@link TurnStepTraceInvalidError}.
 * @param checkpoint - frozen or JSON {@link TurnStepCheckpoint}.
 * @param startedAt - non-negative epoch milliseconds when the node started.
 * @param finishedAt - non-negative epoch milliseconds when the node finished.
 */
export function traceAfterNode(
  checkpoint: unknown,
  startedAt: number,
  finishedAt: number,
): TurnStepTraceEntry {
  const parsed = parseTurnStepCheckpoint(checkpoint)
  if (
    !Number.isSafeInteger(startedAt)
    || !Number.isSafeInteger(finishedAt)
    || startedAt < 0
    || finishedAt < startedAt
  ) {
    throw new TurnStepTraceInvalidError('trace timestamps must be non-negative integers with finishedAt >= startedAt')
  }
  const original = (checkpoint as TurnStepCheckpoint).state
  const state = Object.isFrozen(original) ? original : parsed.state
  return deepFreeze({
    node: parsed.node,
    turn: parsed.state.turn,
    step: parsed.state.step,
    startedAt,
    durationMs: finishedAt - startedAt,
    state,
  })
}

/**
 * Validate and freeze a JSON checkpoint. Wrong `schemaVersion` throws
 * {@link TurnStepStateVersionError}; unknown node or extra keys throw
 * {@link TurnStepStateInvalidError}.
 * @param value - unknown JSON (or an in-memory checkpoint).
 */
export function parseTurnStepCheckpoint(value: unknown): TurnStepCheckpoint {
  const found = foundVersion(value)
  if (found !== TURN_STEP_STATE_VERSION) throw new TurnStepStateVersionError(found)
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) {
    throw new TurnStepStateInvalidError('turn/step checkpoint must be lossless JSON (no functions or live handles)')
  }
  const record = asRecord(snapshot, 'checkpoint')
  exactKeys(record, CHECKPOINT_KEYS, 'checkpoint')
  return deepFreeze({
    schemaVersion: TURN_STEP_STATE_VERSION,
    node: oneOf(record.node, TURN_STEP_NODES, 'checkpoint.node'),
    state: parseTurnStepState(record.state),
  })
}

/**
 * Load last-good State and re-run the declared router. Does not call
 * {@link applyPreStepDecision}. Not `agents.resume`.
 * @param checkpoint - frozen or JSON {@link TurnStepCheckpoint}.
 */
export function resumeTurnStep(
  checkpoint: TurnStepCheckpoint & { readonly node: 'apply-pre-step' },
): Extract<TurnStepResume, { readonly node: 'apply-pre-step' }>
export function resumeTurnStep(
  checkpoint: TurnStepCheckpoint & { readonly node: 'apply-step-outcome' },
): Extract<TurnStepResume, { readonly node: 'apply-step-outcome' }>
export function resumeTurnStep(checkpoint: unknown): TurnStepResume
export function resumeTurnStep(checkpoint: unknown): TurnStepResume {
  const parsed = parseTurnStepCheckpoint(checkpoint)
  if (parsed.node === 'apply-pre-step') {
    return deepFreeze({
      state: parsed.state,
      node: 'apply-pre-step' as const,
      route: routePreStep(parsed.state),
    })
  }
  return deepFreeze({
    state: parsed.state,
    node: 'apply-step-outcome' as const,
    route: routeStepOutcome(parsed.state),
  })
}

/**
 * Increment one node's visit count. Throws {@link TurnStepVisitCapError} when
 * the new count exceeds that node's cap. Does not write `failure`.
 * @param state - frozen snapshot whose `visits` already carry prior counts.
 * @param node - declared node being entered.
 * @returns a new frozen snapshot with the incremented count.
 */
export function recordNodeVisit(state: TurnStepState, node: TurnStepNodeId): TurnStepState {
  const next = state.visits[node] + 1
  const evolved = evolveTurnStepState(state, {
    visits: { ...state.visits, [node]: next },
  })
  if (next > TURN_STEP_VISIT_CAPS[node]) {
    throw new TurnStepVisitCapError(node, TURN_STEP_VISIT_CAPS[node], next)
  }
  return evolved
}

/**
 * Walk the declared graph without executing a node. `kick()` calls this once
 * before the first turn.
 * @param graph - canonical {@link TURN_STEP_GRAPH} unless a test supplies a clone.
 */
export function validateTurnStepGraph(graph: unknown = TURN_STEP_GRAPH): void {
  const record = graphRecord(graph, 'graph')
  graphExactKeys(record, GRAPH_KEYS, 'graph')
  const nodes = graphStringList(record.nodes, 'nodes')
  if (typeof record.entry !== 'string' || !nodes.includes(record.entry)) {
    invalidGraph('entry is not a declared node')
  }
  const routers = graphRecord(record.routers, 'routers')
  const routerIds = Object.keys(routers)
  if (routerIds.length === 0) invalidGraph('routers must declare at least one router')
  const routerTargets = new Map<string, string[]>()
  for (const id of routerIds) {
    const router = graphRecord(routers[id], id)
    graphExactKeys(router, ROUTER_KEYS, id)
    if (typeof router.after !== 'string' || !nodes.includes(router.after)) {
      invalidGraph(`${id}.after is not a declared node`)
    }
    routerTargets.set(id, graphStringList(router.targets, `${id}.targets`))
  }
  const targets = [...routerTargets.values()].flat()
  const terminals = graphStringList(record.terminals, 'terminals')
  const caps = graphRecord(record.caps, 'caps')
  for (const [node, cap] of Object.entries(caps)) {
    if (!nodes.includes(node)) invalidGraph('caps has a key that is not a node')
    if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0) {
      invalidGraph(`caps.${node} must be a positive integer`)
    }
  }
  if (sameStringList(nodes, TURN_STEP_NODES)) {
    if (!sameStringList(routerIds, ROUTER_IDS)) invalidGraph('routers drifted from declared router ids')
    // oxlint-disable-next-line typescript/no-non-null-assertion -- router ids matched ROUTER_IDS
    if (!sameStringList(routerTargets.get('route-pre-step')!, PRE_STEP_ROUTER_TARGETS)) {
      invalidGraph('route-pre-step.targets drifted from PRE_STEP_ROUTER_TARGETS')
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- router ids matched ROUTER_IDS
    if (!sameStringList(routerTargets.get('route-claimed')!, CLAIMED_ROUTER_TARGETS)) {
      invalidGraph('route-claimed.targets drifted from CLAIMED_ROUTER_TARGETS')
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- router ids matched ROUTER_IDS
    if (!sameStringList(routerTargets.get('route-step-outcome')!, STEP_OUTCOME_ROUTER_TARGETS)) {
      invalidGraph('route-step-outcome.targets drifted from STEP_OUTCOME_ROUTER_TARGETS')
    }
    if (
      !sameStringList(Object.keys(caps), Object.keys(TURN_STEP_VISIT_CAPS))
      || TURN_STEP_NODES.some(node => caps[node] !== TURN_STEP_VISIT_CAPS[node])
    ) {
      invalidGraph('caps drifted from TURN_STEP_VISIT_CAPS')
    }
  }
  if (!Array.isArray(record.edges)) invalidGraph('edges must be an array')
  const joins = graphRecord(record.joins, 'joins')
  graphExactKeys(joins, JOIN_IDS, 'joins')
  const toolJoin = graphRecord(joins['tool-calls'], 'joins.tool-calls')
  graphExactKeys(toolJoin, JOIN_KEYS, 'joins.tool-calls')
  const joinEdge = graphRecord(toolJoin.onEdge, 'joins.tool-calls.onEdge')
  graphExactKeys(joinEdge, ROUTER_EDGE_KEYS, 'joins.tool-calls.onEdge')
  const joinPolicy = graphRecord(toolJoin.policy, 'joins.tool-calls.policy')
  graphExactKeys(joinPolicy, JOIN_POLICY_KEYS, 'joins.tool-calls.policy')
  for (const key of JOIN_POLICY_KEYS) {
    if (joinPolicy[key] !== TOOL_CALL_JOIN_POLICY[key]) {
      invalidGraph(`joins.tool-calls.policy.${key} drifted from TOOL_CALL_JOIN_POLICY`)
    }
  }
  const nodeSet = new Set(nodes)
  const routerIdSet = new Set(routerIds)
  const terminalSet = new Set(terminals)
  const outgoing = new Map<string, string[]>()
  const seenTargetOn = new Set<string>()
  for (const [index, edge] of record.edges.entries()) {
    const row = graphRecord(edge, `edges[${index}]`)
    const isRouterEdge = Object.hasOwn(row, 'on')
    graphExactKeys(row, isRouterEdge ? ROUTER_EDGE_KEYS : NODE_EDGE_KEYS, `edges[${index}]`)
    if (typeof row.from !== 'string' || typeof row.to !== 'string') {
      invalidGraph(`edges[${index}] endpoints must be strings`)
    }
    const from = row.from
    const to = row.to
    if (isRouterEdge) {
      if (!routerIdSet.has(from)) invalidGraph(`edges[${index}].from is not a router`)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- `from` was proven present in routerIdSet
      const allowedTargets = routerTargets.get(from)!
      if (typeof row.on !== 'string' || !allowedTargets.includes(row.on)) {
        invalidGraph(`edges[${index}].on is not a router target`)
      }
      seenTargetOn.add(`${from}:${row.on}`)
      if (to !== 'terminal' && !nodeSet.has(to) && !routerIdSet.has(to)) {
        invalidGraph(`edges[${index}].to is not a node, router, or terminal`)
      }
      if (to === 'terminal' && !terminalSet.has(row.on)) {
        invalidGraph(`edges[${index}] terminal is not declared`)
      }
    } else if (!nodeSet.has(from)) {
      invalidGraph(`edges[${index}].from is not a node`)
    } else if (!routerIdSet.has(to) && !nodeSet.has(to)) {
      invalidGraph(`edges[${index}].to is not a node or router`)
    }
    const list = outgoing.get(from) ?? []
    list.push(to)
    outgoing.set(from, list)
  }
  const hasJoinEdge = record.edges.some((edge) => {
    const candidate = edge as Record<string, unknown>
    return candidate.from === joinEdge.from && candidate.on === joinEdge.on && candidate.to === joinEdge.to
  })
  if (!hasJoinEdge) invalidGraph('joins.tool-calls.onEdge is not a declared edge')
  for (const [routerId, declaredTargets] of routerTargets) {
    for (const target of declaredTargets) {
      if (!seenTargetOn.has(`${routerId}:${target}`)) invalidGraph(`router target ${routerId}:${target} has no edge`)
    }
  }
  for (const terminal of terminals) {
    if (!targets.includes(terminal)) invalidGraph(`terminal ${terminal} is not a router target`)
  }

  const reachable = new Set<string>()
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (id: string, path: string[]): void => {
    if (id === 'terminal') return
    if (visiting.has(id)) {
      const cycle = path.slice(path.indexOf(id))
      const capped = cycle.some(item => nodeSet.has(item) && typeof caps[item] === 'number' && (caps[item] as number) > 0)
      if (!capped) invalidGraph('cycle has no visit cap')
      return
    }
    if (done.has(id)) return
    visiting.add(id)
    reachable.add(id)
    for (const next of outgoing.get(id) ?? []) walk(next, [...path, id])
    visiting.delete(id)
    done.add(id)
  }
  walk(record.entry, [])
  for (const node of nodes) {
    if (!reachable.has(node)) invalidGraph(`node ${node} is not reachable from entry`)
  }
}

function invalidGraph(reason: string): never {
  throw new TurnStepGraphInvalidError(reason)
}

function graphRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidGraph(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function graphExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    invalidGraph(`${label} has an invalid key set`)
  }
}

function graphStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    invalidGraph(`${label} must be an array of non-empty strings`)
  }
  return value as string[]
}

function sameStringList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((item, index) => actual[index] === item)
}

function foundVersion(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  return (value as { schemaVersion?: unknown }).schemaVersion
}

function normalizeState(value: unknown): TurnStepState {
  const record = asRecord(value, 'state')
  exactKeys(record, STATE_KEYS, 'state')
  return {
    schemaVersion: TURN_STEP_STATE_VERSION,
    sessionId: SessionId(nonEmptyString(record.sessionId, 'sessionId')),
    turn: nonNegativeInt(record.turn, 'turn'),
    step: nonNegativeInt(record.step, 'step'),
    phaseKind: oneOf(record.phaseKind, PHASE_KINDS, 'phaseKind'),
    wakeRequested: booleanOf(record.wakeRequested, 'wakeRequested'),
    abortCause: parseAbortCause(record.abortCause, 'abortCause'),
    claimTarget: oneOf(record.claimTarget, CLAIM_TARGETS, 'claimTarget'),
    inbox: parseInbox(record.inbox),
    claimed: parseMessages(record.claimed, 'claimed'),
    preStep: oneOf(record.preStep, PRE_STEP_KINDS, 'preStep'),
    startsRequestSeries: booleanOf(record.startsRequestSeries, 'startsRequestSeries'),
    requestError: oneOf(record.requestError, REQUEST_ERROR_KINDS, 'requestError'),
    stepEnd: parseStepEnd(record.stepEnd),
    turnEnd: parseTurnEnd(record.turnEnd),
    route: parseRoute(record.route),
    surfaceGeneration: record.surfaceGeneration === null
      ? null
      : nonNegativeInt(record.surfaceGeneration, 'surfaceGeneration'),
    requestHeaderLogged: booleanOf(record.requestHeaderLogged, 'requestHeaderLogged'),
    failure: record.failure === null ? null : parseExactFailure(record.failure, 'failure'),
    visits: parseVisits(record.visits),
  }
}

function parseInbox(value: unknown): TurnStepState['inbox'] {
  const record = asRecord(value, 'inbox')
  exactKeys(record, INBOX_KEYS, 'inbox')
  return {
    nextTurn: parseMessages(record.nextTurn, 'inbox.nextTurn'),
    nextStep: parseMessages(record.nextStep, 'inbox.nextStep'),
  }
}

function parseMessages(value: unknown, label: string): UserMessage[] {
  if (!Array.isArray(value)) throw new TurnStepStateInvalidError(`${label} must be an array`)
  return value.map((entry, index) => parseUserMessage(entry, `${label}[${index}]`))
}

function parseUserMessage(value: unknown, label: string): UserMessage {
  const record = asRecord(value, label)
  exactKeys(record, MESSAGE_KEYS, label)
  if (record.role !== 'user') throw new TurnStepStateInvalidError(`${label}.role must be user`)
  if (!Array.isArray(record.content)) throw new TurnStepStateInvalidError(`${label}.content must be an array`)
  asRecord(record.source, `${label}.source`)
  return {
    id: MessageId(nonEmptyString(record.id, `${label}.id`)),
    role: 'user',
    content: record.content as UserMessage['content'],
    source: record.source as UserMessage['source'],
  }
}

function parseAbortCause(value: unknown, label: string): AgentCancelCause | null {
  if (value === null) return null
  const record = asRecord(value, label)
  if (record.kind === 'user' || record.kind === 'parent' || record.kind === 'disposed') {
    exactKeys(record, ['kind'], label)
    return { kind: record.kind }
  }
  if (record.kind === 'hook') {
    exactKeys(record, ['kind', 'reason'], label)
    return { kind: 'hook', reason: nonEmptyString(record.reason, `${label}.reason`) }
  }
  throw new TurnStepStateInvalidError(`${label}.kind is not a v2 value`)
}

function parseStepEnd(value: unknown): TurnStepStepEnd | null {
  if (value === null) return null
  const record = asRecord(value, 'stepEnd')
  exactKeys(record, ['kind'], 'stepEnd')
  return { kind: oneOf(record.kind, STEP_END_KINDS, 'stepEnd.kind') }
}

function parseTurnEnd(value: unknown): TurnEndReason | null {
  if (value === null) return null
  const record = asRecord(value, 'turnEnd')
  if (typeof record.kind === 'string' && (SIMPLE_TURN_END_KINDS as readonly string[]).includes(record.kind)) {
    exactKeys(record, ['kind'], 'turnEnd')
    return { kind: record.kind as (typeof SIMPLE_TURN_END_KINDS)[number] }
  }
  if (record.kind === 'aborted') {
    exactKeys(record, ['kind', 'reason'], 'turnEnd')
    const reason = parseAbortCause(record.reason, 'turnEnd.reason')
    if (reason === null) throw new TurnStepStateInvalidError('turnEnd.reason is required')
    return { kind: 'aborted', reason }
  }
  if (record.kind === 'error') {
    exactKeys(record, ['kind', 'error'], 'turnEnd')
    return { kind: 'error', error: parseLlmFailure(record.error, 'turnEnd.error') }
  }
  throw new TurnStepStateInvalidError('turnEnd.kind is not a v2 value')
}

function parseRoute(value: unknown): TurnStepState['route'] {
  const record = asRecord(value, 'route')
  exactKeys(record, ROUTE_KEYS, 'route')
  return {
    provider: stringOf(record.provider, 'route.provider'),
    model: stringOf(record.model, 'route.model'),
  }
}

function parseVisits(value: unknown): TurnStepVisits {
  const record = asRecord(value, 'visits')
  exactKeys(record, TURN_STEP_NODES, 'visits')
  return {
    'apply-pre-step': nonNegativeInt(record['apply-pre-step'], 'visits.apply-pre-step'),
    'apply-step-outcome': nonNegativeInt(record['apply-step-outcome'], 'visits.apply-step-outcome'),
  }
}

function parseExactFailure(value: unknown, label: string): { readonly message: string; readonly code: string } {
  const record = asRecord(value, label)
  exactKeys(record, FAILURE_KEYS, label)
  return {
    message: nonEmptyString(record.message, `${label}.message`),
    code: nonEmptyString(record.code, `${label}.code`),
  }
}

function parseLlmFailure(value: unknown, label: string): LlmFailure {
  const record = asRecord(value, label)
  const keys = Object.keys(record)
  if (keys.some(key => !(LLM_FAILURE_KEYS as readonly string[]).includes(key))
    || !Object.hasOwn(record, 'message')
    || !Object.hasOwn(record, 'code')) {
    throw new TurnStepStateInvalidError(`${label} has an invalid key set`)
  }
  const failure: LlmFailure = {
    message: nonEmptyString(record.message, `${label}.message`),
    code: nonEmptyString(record.code, `${label}.code`),
    ...integerField(record, 'status', `${label}.status`),
    ...integerField(record, 'providerRetryAfterMs', `${label}.providerRetryAfterMs`),
    ...record.requestId === undefined
      ? {}
      : { requestId: ProviderRequestId(nonEmptyString(record.requestId, `${label}.requestId`)) },
  }
  return failure
}

function integerField<K extends 'status' | 'providerRetryAfterMs'>(
  record: Record<string, unknown>,
  key: K,
  label: string,
): Partial<Pick<LlmFailure, K>> {
  const value = record[key]
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TurnStepStateInvalidError(`${label} must be an integer`)
  }
  return { [key]: value } as Partial<Pick<LlmFailure, K>>
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TurnStepStateInvalidError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TurnStepStateInvalidError(`${label} has an invalid key set`)
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TurnStepStateInvalidError(`${label} is not a v2 value`)
  }
  return value as T
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TurnStepStateInvalidError(`${label} must be a non-empty string`)
  }
  return value
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TurnStepStateInvalidError(`${label} must be a string`)
  return value
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TurnStepStateInvalidError(`${label} must be a non-negative integer`)
  }
  return value
}

function booleanOf(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TurnStepStateInvalidError(`${label} must be a boolean`)
  return value
}
