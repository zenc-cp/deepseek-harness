/** In-memory experimental checkpoint boundary, not durable or live-driver wiring. */
import { createCappedNodeRun, type CappedNode } from './capped-node-run.ts'
import { createCheckpoint, type GraphCheckpoint } from './checkpoint.ts'
import type { GraphState } from './state.ts'

export interface CheckpointedNodeRun {
  readonly lastCheckpoint: GraphCheckpoint | undefined
  invoke(nodeId: string, state: GraphState): GraphState
}

/** Synchronous trusted-input nodes only. Successful output is validated before publication. */
export function createCheckpointedNodeRun(declarations: readonly CappedNode[]): CheckpointedNodeRun {
  const run = createCappedNodeRun(declarations)
  let lastCheckpoint: GraphCheckpoint | undefined
  let active = false
  return Object.freeze({
    get lastCheckpoint(): GraphCheckpoint | undefined {
      return lastCheckpoint
    },
    invoke(nodeId: string, state: GraphState): GraphState {
      if (active) throw new Error('reentrant checkpointed execution is not supported')
      const seq = (lastCheckpoint?.seq ?? 0) + 1
      if (!Number.isSafeInteger(seq)) throw new RangeError('checkpoint sequence exhausted')
      active = true
      try {
        const stateAfter = run.invoke(nodeId, state)
        const checkpoint = createCheckpoint(stateAfter, nodeId, seq)
        lastCheckpoint = checkpoint
        return checkpoint.state
      } finally {
        active = false
      }
    },
  })
}
