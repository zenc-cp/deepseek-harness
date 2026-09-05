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
