import { describe, expect, it } from 'vitest'
import { createGraphState } from '@deepseek-ai/dsh-agent-loop/state'
import { enterRunning } from '../src/enter-running.ts'
import { GraphStateError } from '@deepseek-ai/dsh-agent-loop/state'

function idle(lastTurn: number, inbox = { nextTurnCount: 0, nextStepCount: 0 }) {
  return createGraphState({
    sessionId: 'sess-1',
    phase: { kind: 'idle', lastTurn },
    inbox,
  })
}

describe('enterRunning', () => {
  it('opens running from idle with lastTurn copied and step 0', () => {
    const input = idle(3, { nextTurnCount: 1, nextStepCount: 0 })
    const out = enterRunning(input)
    expect(out).not.toBe(input)
    expect(out.version).toBe(1)
    expect(out.sessionId).toBe('sess-1')
    expect(out.phase).toEqual({
      kind: 'running',
      turn: 3,
      step: 0,
      wakeRequested: false,
    })
    expect(out.inbox).toEqual(input.inbox)
    expect(Object.isFrozen(out)).toBe(true)
    expect(out.phase).not.toHaveProperty('abort')
  })

  it('opens running even when the idle inbox is empty', () => {
    const out = enterRunning(idle(0))
    expect(out.phase).toEqual({
      kind: 'running',
      turn: 0,
      step: 0,
      wakeRequested: false,
    })
    expect(out.inbox).toEqual({ nextTurnCount: 0, nextStepCount: 0 })
  })

  it('does not increment lastTurn (turn() owns that later)', () => {
    const out = enterRunning(idle(4))
    expect(out.phase.kind).toBe('running')
    if (out.phase.kind === 'running') expect(out.phase.turn).toBe(4)
  })

  it('rejects running and maintenance instead of latching', () => {
    const running = createGraphState({
      sessionId: 'sess-1',
      phase: { kind: 'running', turn: 1, step: 0, wakeRequested: false },
      inbox: { nextTurnCount: 0, nextStepCount: 0 },
    })
    const maintenance = createGraphState({
      sessionId: 'sess-1',
      phase: { kind: 'maintenance', lastTurn: 1, wakeRequested: false },
      inbox: { nextTurnCount: 1, nextStepCount: 0 },
    })
    expect(() => enterRunning(running)).toThrow(GraphStateError)
    expect(() => enterRunning(maintenance)).toThrow(GraphStateError)
    try {
      enterRunning(running)
    } catch (error) {
      expect((error as GraphStateError).code).toBe('INVALID')
    }
  })
})
