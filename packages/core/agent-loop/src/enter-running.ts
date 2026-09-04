/**
 * Pure node: idle GraphState in, running GraphState out.
 * Mirrors wakeDriver's idle snapshot without AbortController or kick().
 * @module @deepseek-ai/dsh-agent-loop/enter-running
 */
import {
  createGraphState,
  GraphStateError,
  type GraphState,
} from './state.ts'

/** Enter running from idle. Inbox is unchanged. Does not increment turn. */
export function enterRunning(state: GraphState): GraphState {
  if (state.phase.kind !== 'idle') {
    throw new GraphStateError(
      'INVALID',
      `enterRunning requires idle phase, got ${state.phase.kind}`,
    )
  }
  return createGraphState({
    sessionId: state.sessionId,
    phase: {
      kind: 'running',
      turn: state.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    },
    inbox: {
      nextTurnCount: state.inbox.nextTurnCount,
      nextStepCount: state.inbox.nextStepCount,
    },
  })
}
