import { describe, expect, it } from 'vitest'
import { createGraphState } from '@deepseek-ai/dsh-agent-loop/state'
import { createCheckpoint } from '../src/checkpoint.ts'
import { resumeFromCheckpoint } from '../src/resume-from-checkpoint.ts'

const sampleState = createGraphState({
  sessionId: 'sess-resume',
  phase: { kind: 'running', turn: 5, step: 2, wakeRequested: true },
  inbox: { nextTurnCount: 1, nextStepCount: 0 },
})

describe('resume from checkpoint', () => {
  it('rejects invalid nested state and nested version mismatch', () => {
    const cp = createCheckpoint(sampleState, 'node', 0)
    expect(() => resumeFromCheckpoint({ ...cp, state: null })).toThrow()
    expect(() => resumeFromCheckpoint({ ...cp, state: { ...sampleState, version: 99 } })).toThrow(/version mismatch/)
  })

  it('loads a serialized checkpoint as a detached immutable snapshot', () => {
    const input = structuredClone(createCheckpoint(sampleState, 'node', 0))
    const restored = resumeFromCheckpoint(input)
    input.state.inbox.nextTurnCount = 99
    expect(restored.state.inbox.nextTurnCount).toBe(1)
    expect(Object.isFrozen(restored)).toBe(true)
    expect(Object.isFrozen(restored.state.inbox)).toBe(true)
  })

  it('restores GraphState and metadata from a valid checkpoint', () => {
    const cp = createCheckpoint(sampleState, 'enterRunning', 7)
    const resumed = resumeFromCheckpoint(cp)

    expect(resumed.state).toEqual(sampleState)
    expect(resumed.nodeId).toBe('enterRunning')
    expect(resumed.seq).toBe(7)
  })

  it('throws on invalid or version-mismatched checkpoint', () => {
    const bad = { version: 0, state: sampleState, nodeId: 'x', seq: 1, timestamp: Date.now() }
    expect(() => resumeFromCheckpoint(bad as unknown)).toThrow()
  })
})
