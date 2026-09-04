import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  GRAPH_STATE_VERSION,
  GraphStateError,
  createGraphState,
  parseGraphState,
} from '@deepseek-ai/dsh-agent-loop/state'

const runningInput = {
  sessionId: 'sess-1',
  phase: { kind: 'running' as const, turn: 1, step: 2, wakeRequested: false },
  inbox: { nextTurnCount: 1, nextStepCount: 0 },
}

describe('graph state v1', () => {
  it('stamps GRAPH_STATE_VERSION 1 and is not the session format version', () => {
    expect(GRAPH_STATE_VERSION).toBe(1)
    expect(GRAPH_STATE_VERSION).not.toBe(SESSION_FORMAT_VERSION)
  })

  it('createGraphState freezes a running snapshot without abort', () => {
    const state = createGraphState(runningInput)
    expect(state.version).toBe(1)
    expect(state.sessionId).toBe('sess-1')
    expect(state.phase).toEqual(runningInput.phase)
    expect(state.inbox).toEqual(runningInput.inbox)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.phase)).toBe(true)
    expect(Object.isFrozen(state.inbox)).toBe(true)
    expect(state).not.toHaveProperty('abort')
    expect(state.phase).not.toHaveProperty('abort')
    expect(() => {
      (state as { sessionId: string }).sessionId = 'nope'
    }).toThrow(TypeError)
    expect(() => {
      (state.inbox as { nextTurnCount: number }).nextTurnCount = 9
    }).toThrow(TypeError)
  })

  it('accepts idle and maintenance phases that match the driver kinds', () => {
    const idle = createGraphState({
      sessionId: 's',
      phase: { kind: 'idle', lastTurn: 3 },
      inbox: { nextTurnCount: 0, nextStepCount: 0 },
    })
    expect(idle.phase).toEqual({ kind: 'idle', lastTurn: 3 })
    const maintenance = createGraphState({
      sessionId: 's',
      phase: { kind: 'maintenance', lastTurn: 3, wakeRequested: true },
      inbox: { nextTurnCount: 0, nextStepCount: 1 },
    })
    expect(maintenance.phase).toEqual({
      kind: 'maintenance',
      lastTurn: 3,
      wakeRequested: true,
    })
  })

  it('JSON round-trips through parseGraphState and stays frozen', () => {
    const state = createGraphState(runningInput)
    const again = parseGraphState(JSON.parse(JSON.stringify(state)))
    expect(again).toEqual(state)
    expect(Object.isFrozen(again)).toBe(true)
    expect(again.version).toBe(GRAPH_STATE_VERSION)
  })

  it('fails loudly on version mismatch with no migration', () => {
    const payload = { ...createGraphState(runningInput), version: 0 }
    expect(() => parseGraphState(payload)).toThrow(GraphStateError)
    expect(() => parseGraphState(payload)).toThrow(/version mismatch/)
    try {
      parseGraphState(payload)
    } catch (error) {
      expect(error).toBeInstanceOf(GraphStateError)
      expect((error as GraphStateError).code).toBe('VERSION_MISMATCH')
      expect((error as GraphStateError).found).toBe(0)
      expect((error as GraphStateError).expected).toBe(1)
    }
  })

  it('rejects abort on phase and unknown keys', () => {
    expect(() => createGraphState({
      sessionId: 's',
      phase: {
        kind: 'running',
        turn: 1,
        step: 0,
        wakeRequested: false,
        abort: true,
      } as never,
      inbox: { nextTurnCount: 0, nextStepCount: 0 },
    })).toThrow(GraphStateError)
    expect(() => parseGraphState({
      version: 1,
      sessionId: 's',
      phase: { kind: 'idle', lastTurn: 0 },
      inbox: { nextTurnCount: 0, nextStepCount: 0 },
      extra: true,
    })).toThrow(GraphStateError)
  })

  it('rejects missing version as INVALID rather than migrating', () => {
    try {
      parseGraphState({
        sessionId: 's',
        phase: { kind: 'idle', lastTurn: 0 },
        inbox: { nextTurnCount: 0, nextStepCount: 0 },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(GraphStateError)
      expect((error as GraphStateError).code).toBe('INVALID')
      return
    }
    expect.fail('expected parseGraphState to throw')
  })
})
