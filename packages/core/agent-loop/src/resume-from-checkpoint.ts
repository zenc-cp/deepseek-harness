/**
 * Resume from last good checkpoint.
 * Pure helper that restores GraphState from a GraphCheckpoint.
 * Not yet wired into ReactLoopAgent.
 * @module @deepseek-ai/dsh-agent-loop/resume-from-checkpoint
 */
import type { GraphState } from './state.ts'
import { parseCheckpoint } from './checkpoint.ts'

export interface ResumeResult {
  readonly state: GraphState
  readonly nodeId: string
  readonly seq: number
}

export class ResumeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResumeError'
  }
}

export function resumeFromCheckpoint(cp: unknown): ResumeResult {
  try {
    const parsed = parseCheckpoint(cp)
    return Object.freeze({
      state: parsed.state,
      nodeId: parsed.nodeId,
      seq: parsed.seq,
    })
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown validation failure'
    throw new ResumeError(`Invalid or incompatible checkpoint: ${detail}`, { cause })
  }
}
