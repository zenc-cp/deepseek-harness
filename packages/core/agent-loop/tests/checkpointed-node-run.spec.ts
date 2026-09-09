import { describe, expect, it, vi } from 'vitest'
import { createCheckpointedNodeRun } from '../src/checkpointed-node-run.ts'
import { createGraphState, type GraphState } from '../src/state.ts'
import { enterRunning } from '../src/enter-running.ts'
import { VisitCapError } from '../src/visit-cap.ts'

const idle = () => createGraphState({
  sessionId: 'test', phase: { kind: 'idle', lastTurn: 0 },
  inbox: { nextTurnCount: 1, nextStepCount: 0 },
})

describe('checkpointed experimental node run', () => {
  it('publishes one validated checkpoint per success, across nodes', () => {
    const run = createCheckpointedNodeRun([
      { nodeId: 'enter', budget: 1, node: enterRunning },
      { nodeId: 'same', budget: 1, node: (state: GraphState) => state },
    ])
    expect(run.lastCheckpoint).toBeUndefined()
    const first = run.invoke('enter', idle())
    const cp = run.lastCheckpoint
    expect(cp).toMatchObject({ nodeId: 'enter', seq: 1, state: first })
    expect(cp?.state).toBe(first)
    run.invoke('same', first)
    expect(run.lastCheckpoint).toMatchObject({ nodeId: 'same', seq: 2 })
    expect(cp?.seq).toBe(1)
    expect(Object.isFrozen(cp)).toBe(true)
    expect(Object.isFrozen(first.phase)).toBe(true)
    expect(Object.isFrozen(run)).toBe(true)
  })

  it('preserves last good checkpoint on thrown bodies and exhausted caps', () => {
    const node = vi.fn(() => { throw new Error('failed') })
    const run = createCheckpointedNodeRun([
      { nodeId: 'good', budget: 1, node: enterRunning },
      { nodeId: 'bad', budget: 1, node },
    ])
    run.invoke('good', idle())
    const cp = run.lastCheckpoint
    expect(() => run.invoke('bad', idle())).toThrow('failed')
    expect(run.lastCheckpoint).toBe(cp)
    expect(() => run.invoke('bad', idle())).toThrow(VisitCapError)
    expect(run.lastCheckpoint).toBe(cp)
    expect(node).toHaveBeenCalledTimes(1)
  })

  it('does not publish invalid output or advance sequence on failure', () => {
    const run = createCheckpointedNodeRun([
      { nodeId: 'good', budget: 2, node: enterRunning },
      { nodeId: 'invalid', budget: 1, node: () => null as unknown as GraphState },
    ])
    run.invoke('good', idle())
    const cp = run.lastCheckpoint
    expect(() => run.invoke('invalid', idle())).toThrow()
    expect(run.lastCheckpoint).toBe(cp)
    expect(() => run.invoke('invalid', idle())).toThrow(VisitCapError)
    run.invoke('good', idle())
    expect(run.lastCheckpoint?.seq).toBe(2)
  })

  it('rejects reentrant execution before nested bodies can publish', () => {
    let nested: () => void = () => {}
    const inner = vi.fn(enterRunning)
    const run = createCheckpointedNodeRun([
      { nodeId: 'outer', budget: 1, node: (state: GraphState) => { nested(); return state } },
      { nodeId: 'inner', budget: 1, node: inner },
    ])
    nested = () => { run.invoke('inner', idle()) }
    expect(() => run.invoke('outer', idle())).toThrow(/reentrant/)
    expect(inner).not.toHaveBeenCalled()
    expect(run.lastCheckpoint).toBeUndefined()
    run.invoke('inner', idle())
    expect(run.lastCheckpoint?.seq).toBe(1)
  })
})
