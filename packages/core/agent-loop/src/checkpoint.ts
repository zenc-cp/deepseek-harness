/**
 * Checkpoint after every node.
 * Produces a frozen, versioned snapshot of GraphState after a node completes.
 * Not yet wired into the live driver.
 * @module @deepseek-ai/dsh-agent-loop/checkpoint
 */
import type { GraphState } from './state.ts'

export const CHECKPOINT_VERSION = 1

export interface GraphCheckpoint {
  readonly version: number
  readonly state: GraphState
  readonly nodeId: string
  readonly seq: number
  readonly timestamp: number
}

export function createCheckpoint(
  state: GraphState,
  nodeId: string,
  seq: number,
): GraphCheckpoint {
  return Object.freeze({
    version: CHECKPOINT_VERSION,
    state,
    nodeId,
    seq,
    timestamp: Date.now(),
  })
}

export function isValidCheckpoint(value: unknown): value is GraphCheckpoint {
  if (typeof value !== 'object' || value === null) return false
  const cp = value as Partial<GraphCheckpoint>
  return (
    cp.version === CHECKPOINT_VERSION &&
    typeof cp.nodeId === 'string' &&
    typeof cp.seq === 'number' &&
    typeof cp.timestamp === 'number' &&
    cp.state !== undefined
  )
}
