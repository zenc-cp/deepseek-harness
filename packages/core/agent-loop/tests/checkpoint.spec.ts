import { describe, expect, it } from 'vitest'
import { createGraphState } from '@deepseek-ai/dsh-agent-loop/state'
import {
  CHECKPOINT_VERSION,
  createCheckpoint,
  isValidCheckpoint,
} from '../src/checkpoint.ts'

const sampleState = createGraphState({
  sessionId: 'sess-1',
  phase: { kind: 'running', turn: 3, step: 1, wakeRequested: false },
  inbox: { nextTurnCount: 0, nextStepCount: 0 },
})

describe('checkpoint', () => {
  it.each([
    { state: null }, { state: {} }, { state: { ...sampleState, version: 99 } },
    { nodeId: '' }, { seq: -1 }, { seq: 1.5 }, { seq: NaN }, { seq: Infinity },
    { seq: Number.MAX_SAFE_INTEGER + 1 }, { timestamp: -1 }, { timestamp: NaN },
    { timestamp: Infinity }, { extra: true },
  ])('rejects malformed checkpoint %j', (patch) => {
    expect(isValidCheckpoint({ ...createCheckpoint(sampleState, 'node', 0), ...patch })).toBe(false)
  })

  it('validates creation and detaches the nested state', () => {
    expect(() => createCheckpoint(sampleState, '', 0)).toThrow()
    expect(() => createCheckpoint(sampleState, 'node', -1)).toThrow()
    const mutable = structuredClone(sampleState)
    const cp = createCheckpoint(mutable, 'node', 0)
    mutable.inbox.nextTurnCount = 99
    expect(cp.state.inbox.nextTurnCount).toBe(0)
    expect(Object.isFrozen(cp.state.inbox)).toBe(true)
  })

  it('creates a frozen checkpoint with correct version and metadata', () => {
    const cp = createCheckpoint(sampleState, 'enterRunning', 5)
    expect(cp.version).toBe(CHECKPOINT_VERSION)
    expect(cp.nodeId).toBe('enterRunning')
    expect(cp.seq).toBe(5)
    expect(cp.state).toEqual(sampleState)
    expect(Object.isFrozen(cp)).toBe(true)
    expect(Object.isFrozen(cp.state)).toBe(true)
  })

  it('isValidCheckpoint accepts well-formed checkpoints', () => {
    const cp = createCheckpoint(sampleState, 'latchWake', 1)
    expect(isValidCheckpoint(cp)).toBe(true)
  })

  it('isValidCheckpoint rejects wrong version or missing fields', () => {
    expect(isValidCheckpoint({ version: 0, state: sampleState, nodeId: 'x', seq: 1, timestamp: Date.now() })).toBe(false)
    expect(isValidCheckpoint(null)).toBe(false)
    expect(isValidCheckpoint({ version: 1, nodeId: 'x', seq: 1 })).toBe(false)
  })
})
