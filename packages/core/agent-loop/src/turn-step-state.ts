/**
 * Versioned immutable snapshot for one DSH turn/step (graph-architect slice 1).
 *
 * This is not `SESSION_FORMAT_VERSION` and not session-checkpoint-policy.
 * The live driver (`kick` / `turn` / `preStep` / `step`) is not wired to it.
 *
 * Field mapping from the current loop:
 * - `phaseKind`, `wakeRequested`, `abortCause` <- mutable `Phase` (`AbortController` stays live)
 * - `inbox` / `claimed` / `claimTarget` <- live `Inbox` queues copied at snapshot time
 * - `preStep` / `startsRequestSeries` <- `PreparedStep` / `PreStepDecision`
 * - `requestError` <- `agent/request-error` retry|throw
 * - `stepEnd` / `turnEnd` <- `StepEndReason` / `TurnEndReason`
 * - `route` / `requestHeaderLogged` / `surfaceGeneration` <- `buildRequest` locals
 * - `failure` <- routable error facts (slice 8 later)
 *
 * @module dsh-agent-loop/turn-step-state
 */

import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import { MessageId, ProviderRequestId, type LlmFailure, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type AgentCancelCause, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

/** Monotonic State schema version. Independent of the session log format. */
export const TURN_STEP_STATE_VERSION = 1 as const

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

/** A v1 snapshot that is the right version but not a valid State object. */
export class TurnStepStateInvalidError extends Error {
  /** @param message - stable reason the snapshot is not v1 State. */
  constructor(message: string) {
    super(message)
    this.name = 'TurnStepStateInvalidError'
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
}

/** Fields `evolveTurnStepState` may replace. `schemaVersion` stays 1. */
export type TurnStepStatePatch = Partial<Omit<TurnStepState, 'schemaVersion'>>

/**
 * Clone and deep-freeze a v1 snapshot. Rejects functions, live handles, and
 * version mismatches before freeze.
 * @param state - candidate snapshot.
 * @returns a frozen v1 {@link TurnStepState}.
 */
export function freezeTurnStepState(state: TurnStepState): TurnStepState {
  return parseTurnStepState(state)
}

/**
 * Validate, re-brand ids, and freeze a JSON snapshot.
 * @param value - unknown JSON (or an in-memory snapshot).
 * @returns a frozen v1 {@link TurnStepState}.
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
 * @param state - previously frozen v1 snapshot.
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
  throw new TurnStepStateInvalidError(`${label}.kind is not a v1 value`)
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
  throw new TurnStepStateInvalidError('turnEnd.kind is not a v1 value')
}

function parseRoute(value: unknown): TurnStepState['route'] {
  const record = asRecord(value, 'route')
  exactKeys(record, ROUTE_KEYS, 'route')
  return {
    provider: stringOf(record.provider, 'route.provider'),
    model: stringOf(record.model, 'route.model'),
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
    throw new TurnStepStateInvalidError(`${label} is not a v1 value`)
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
