/**
 * Resume from last good checkpoint.
 * Pure helper that restores GraphState from a GraphCheckpoint.
 * Not yet wired into ReactLoopAgent.
 * @module @deepseek-ai/dsh-agent-loop/resume-from-checkpoint
 */
import type { GraphState } from './state.ts'
import { CHECKPOINT_VERSION, isValidCheckpoint } from './checkpoint.ts'

export interface ResumeResult {
  state: GraphState
  nodeId: string
  seq: number
}

export class ResumeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResumeError'
  }
}

export function resumeFromCheckpoint(cp: unknown): ResumeResult {
  if (!isValidCheckpoint(cp)) {
    throw new ResumeError('Invalid or incompatible checkpoint')
  }
  if (cp.version !== CHECKPOINT_VERSION) {
    throw new ResumeError(
      `Checkpoint version mismatch: expected ${CHECKPOINT_VERSION}, got ${cp.version}`,
    )
  }
  return {
    state: cp.state,
    nodeId: cp.nodeId,
    seq: cp.seq,
  }
}
