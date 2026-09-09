/**
 * Checkpoint after every node.
 * Produces a frozen, versioned snapshot of GraphState after a node completes.
 * Not yet wired into the live driver.
 * @module @deepseek-ai/dsh-agent-loop/checkpoint
 */
import { z as zod } from 'zod'
import { parseGraphState, type GraphState } from './state.ts'

export const CHECKPOINT_VERSION = 1

export interface GraphCheckpoint {
  readonly version: number
  readonly state: GraphState
  readonly nodeId: string
  readonly seq: number
  readonly timestamp: number
}

const checkpointSchema = zod.object({
  version: zod.literal(CHECKPOINT_VERSION),
  state: zod.unknown(),
  nodeId: zod.string().min(1),
  seq: zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: zod.number().finite().nonnegative(),
}).strict()

/** Validate and detach a serialized snapshot. No migration or routing occurs. */
export function parseCheckpoint(value: unknown): GraphCheckpoint {
  const cp = checkpointSchema.parse(value)
  return Object.freeze({ ...cp, state: parseGraphState(cp.state) })
}

export function createCheckpoint(
  state: GraphState,
  nodeId: string,
  seq: number,
): GraphCheckpoint {
  return parseCheckpoint({
    version: CHECKPOINT_VERSION,
    state,
    nodeId,
    seq,
    timestamp: Date.now(),
  })
}

export function isValidCheckpoint(value: unknown): value is GraphCheckpoint {
  try {
    parseCheckpoint(value)
    return true
  } catch {
    return false
  }
}
