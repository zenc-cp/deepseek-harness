/**
 * Versioned immutable graph State for one turn/step snapshot.
 * Not the session log, not SessionHeader.version, not turnBoundary.
 * @module @deepseek-ai/dsh-agent-loop/state
 */
import { z as zod } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/** Graph snapshot schema version. Bump when GraphState fields change. No v1 migration. */
export const GRAPH_STATE_VERSION = 1 as const

export type GraphStateErrorCode = 'VERSION_MISMATCH' | 'INVALID'

/** Loud failure for unknown or other-version snapshots. */
export class GraphStateError extends Error {
  readonly code: GraphStateErrorCode
  readonly found: number | undefined
  readonly expected: number

  constructor(code: GraphStateErrorCode, message: string, found?: number) {
    super(message)
    this.name = 'GraphStateError'
    this.code = code
    this.found = found
    this.expected = GRAPH_STATE_VERSION
  }
}

const idlePhaseSchema = zod.object({
  kind: zod.literal('idle'),
  lastTurn: zod.number().int().nonnegative(),
}).strict()

const maintenancePhaseSchema = zod.object({
  kind: zod.literal('maintenance'),
  lastTurn: zod.number().int().nonnegative(),
  wakeRequested: zod.boolean(),
}).strict()

const runningPhaseSchema = zod.object({
  kind: zod.literal('running'),
  turn: zod.number().int().nonnegative(),
  step: zod.number().int().nonnegative(),
  wakeRequested: zod.boolean(),
}).strict()

const graphPhaseSchema = zod.discriminatedUnion('kind', [
  idlePhaseSchema,
  maintenancePhaseSchema,
  runningPhaseSchema,
])

const inboxSchema = zod.object({
  nextTurnCount: zod.number().int().nonnegative(),
  nextStepCount: zod.number().int().nonnegative(),
}).strict()

const graphStateSchema = zod.object({
  version: zod.literal(GRAPH_STATE_VERSION),
  sessionId: zod.string().min(1),
  phase: graphPhaseSchema,
  inbox: inboxSchema,
}).strict()

export type GraphPhase = zod.infer<typeof graphPhaseSchema>
export type GraphState = zod.infer<typeof graphStateSchema>
export type GraphStateInput = Omit<GraphState, 'version'>

/** Validate, clone, stamp version, and deep-freeze. */
export function createGraphState(input: GraphStateInput): GraphState {
  return parseGraphState({ ...input, version: GRAPH_STATE_VERSION })
}

/** Parse an unknown snapshot. Other versions fail. No migration. */
export function parseGraphState(value: unknown): GraphState {
  if (typeof value === 'object' && value !== null && 'version' in value) {
    const found = (value as { version: unknown }).version
    if (typeof found === 'number' && found !== GRAPH_STATE_VERSION) {
      throw new GraphStateError(
        'VERSION_MISMATCH',
        `graph state version mismatch: found ${found}, expected ${GRAPH_STATE_VERSION}`,
        found,
      )
    }
  }
  const parsed = graphStateSchema.safeParse(value)
  if (!parsed.success) {
    throw new GraphStateError('INVALID', parsed.error.message)
  }
  return deepFreeze(structuredClone(parsed.data))
}

/** Resume/load helper: fail loudly when the stamped version is not current. */
export function assertGraphStateVersion(state: { version: number }): asserts state is GraphState {
  if (state.version !== GRAPH_STATE_VERSION) {
    throw new GraphStateError(
      'VERSION_MISMATCH',
      `graph state version mismatch: found ${state.version}, expected ${GRAPH_STATE_VERSION}`,
      state.version,
    )
  }
}
