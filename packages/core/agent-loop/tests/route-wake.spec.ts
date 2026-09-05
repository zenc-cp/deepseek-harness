import { describe, expect, it } from 'vitest'
import { createGraphState, GraphStateError } from '@deepseek-ai/dsh-agent-loop/state'
import { enterRunning } from '../src/enter-running.ts'
import {
  WAKE_TARGETS,
  applyWake,
  latchWake,
  noop,
  routeWake,
} from '../src/route-wake.ts'

const inbox = { nextTurnCount: 1, nextStepCount: 0 }

const idle = createGraphState({
  sessionId: 'sess-1',
  phase: { kind: 'idle', lastTurn: 2 },
  inbox,
})

const maintenance = createGraphState({
  sessionId: 'sess-1',
  phase: { kind: 'maintenance', lastTurn: 2, wakeRequested: false },
  inbox,
})

const running = createGraphState({
  sessionId: 'sess-1',
  phase: { kind: 'running', turn: 2, step: 1, wakeRequested: false },
  inbox,
})

describe('routeWake', () => {
  it('declares the only legal targets', () => {
    expect(WAKE_TARGETS).toEqual(['enterRunning', 'latchWake', 'noop'])
  })

  it('routes idle / maintenance / running to those targets', () => {
    expect(routeWake(idle)).toBe('enterRunning')
    expect(routeWake(maintenance)).toBe('latchWake')
    expect(routeWake(running)).toBe('noop')
  })
})

describe('applyWake', () => {
  it('dispatches idle through enterRunning', () => {
    expect(applyWake(idle)).toEqual(enterRunning(idle))
  })

  it('latches maintenance without leaving the phase', () => {
    const out = applyWake(maintenance)
    expect(out).not.toBe(maintenance)
    expect(out.phase).toEqual({
      kind: 'maintenance',
      lastTurn: 2,
      wakeRequested: true,
    })
    expect(out.inbox).toEqual(inbox)
    expect(Object.isFrozen(out)).toBe(true)
  })

  it('noops running (v1 cannot see wakeAfterAbort)', () => {
    const out = applyWake(running)
    expect(out).toEqual(running)
    expect(out.phase).toEqual(running.phase)
  })
})

describe('latchWake and noop preconditions', () => {
  it('latchWake rejects idle and running', () => {
    expect(() => latchWake(idle)).toThrow(GraphStateError)
    expect(() => latchWake(running)).toThrow(GraphStateError)
    try {
      latchWake(idle)
    } catch (error) {
      expect((error as GraphStateError).code).toBe('INVALID')
    }
  })

  it('noop returns the same frozen running snapshot', () => {
    expect(noop(running)).toBe(running)
    expect(() => noop(idle)).toThrow(GraphStateError)
    expect(() => noop(maintenance)).toThrow(GraphStateError)
  })
})
