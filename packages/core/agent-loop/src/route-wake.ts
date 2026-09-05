/**
 * Declared wake router over v1 GraphState phase kinds.
 * Does not see abort/disposed. Running therefore noops.
 * @module @deepseek-ai/dsh-agent-loop/route-wake
 */
import { enterRunning } from './enter-running.ts'
import {
  createGraphState,
  GraphStateError,
  type GraphState,
} from './state.ts'

export const WAKE_TARGETS = ['enterRunning', 'latchWake', 'noop'] as const
export type WakeTarget = (typeof WAKE_TARGETS)[number]

export function routeWake(state: GraphState): WakeTarget {
  switch (state.phase.kind) {
    case 'idle':
      return 'enterRunning'
    case 'maintenance':
      return 'latchWake'
    case 'running':
      return 'noop'
  }
}

export function latchWake(state: GraphState): GraphState {
  if (state.phase.kind !== 'maintenance') {
    throw new GraphStateError(
      'INVALID',
      `latchWake requires maintenance phase, got ${state.phase.kind}`,
    )
  }
  return createGraphState({
    sessionId: state.sessionId,
    phase: {
      kind: 'maintenance',
      lastTurn: state.phase.lastTurn,
      wakeRequested: true,
    },
    inbox: {
      nextTurnCount: state.inbox.nextTurnCount,
      nextStepCount: state.inbox.nextStepCount,
    },
  })
}

export function noop(state: GraphState): GraphState {
  if (state.phase.kind !== 'running') {
    throw new GraphStateError(
      'INVALID',
      `noop requires running phase, got ${state.phase.kind}`,
    )
  }
  return state
}

const WAKE_NODES: Record<WakeTarget, (state: GraphState) => GraphState> = {
  enterRunning,
  latchWake,
  noop,
}

export function applyWake(state: GraphState): GraphState {
  return WAKE_NODES[routeWake(state)](state)
}
