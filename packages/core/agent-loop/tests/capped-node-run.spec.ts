import { describe, expect, it, vi } from 'vitest'
import { createCappedNodeRun } from '../src/capped-node-run.ts'
import { createGraphState } from '../src/state.ts'
import { enterRunning } from '../src/enter-running.ts'
import { VisitCapError } from '../src/visit-cap.ts'

const idle = () => createGraphState({
  sessionId: 'test',
  phase: { kind: 'idle', lastTurn: 0 },
  inbox: { nextTurnCount: 1, nextStepCount: 0 },
})

describe('capped experimental node run', () => {
  it('allows exactly N visits and rejects before the next body invocation', () => {
    const node = vi.fn(enterRunning)
    const run = createCappedNodeRun([{ nodeId: 'enter', budget: 2, node }])
    const state = idle()
    expect(run.invoke('enter', state).phase.kind).toBe('running')
    run.invoke('enter', idle())
    expect(() => run.invoke('enter', idle())).toThrow(VisitCapError)
    expect(node).toHaveBeenCalledTimes(2)
    expect(state.phase.kind).toBe('idle')
    expect(Object.isFrozen(state.phase)).toBe(true)
    expect(Object.isFrozen(run)).toBe(true)
    expect(Object.keys(run)).toEqual(['invoke'])
  })

  it('keeps independent counts for distinct nodes and runs', () => {
    const node = vi.fn(enterRunning)
    const declarations = [{ nodeId: 'a', budget: 1, node }, { nodeId: 'b', budget: 2, node }]
    const run = createCappedNodeRun(declarations)
    run.invoke('a', idle())
    expect(() => run.invoke('a', idle())).toThrow(VisitCapError)
    run.invoke('b', idle())
    run.invoke('b', idle())
    expect(() => run.invoke('b', idle())).toThrow(VisitCapError)
    createCappedNodeRun(declarations).invoke('a', idle())
    expect(node).toHaveBeenCalledTimes(4)
  })

  it('consumes a visit even when the node throws', () => {
    const failure = new Error('body failed')
    const node = vi.fn(() => { throw failure })
    const run = createCappedNodeRun([{ nodeId: 'fail', budget: 1, node }])
    expect(() => run.invoke('fail', idle())).toThrow(failure)
    expect(() => run.invoke('fail', idle())).toThrow(VisitCapError)
    expect(node).toHaveBeenCalledTimes(1)
  })

  it('snapshots declarations so caller mutation cannot reset or replace a node', () => {
    const node = vi.fn(enterRunning)
    const replacement = vi.fn(enterRunning)
    const declaration = { nodeId: 'a', budget: 1, node }
    const run = createCappedNodeRun([declaration])
    declaration.budget = 100
    declaration.node = replacement
    run.invoke('a', idle())
    expect(() => run.invoke('a', idle())).toThrow(VisitCapError)
    expect(node).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('reserves a visit before reentrant execution', () => {
    let invokeAgain: () => void = () => {}
    const node = vi.fn((state: ReturnType<typeof idle>) => {
      invokeAgain()
      return state
    })
    const run = createCappedNodeRun([{ nodeId: 'a', budget: 1, node }])
    invokeAgain = () => { run.invoke('a', idle()) }
    expect(() => run.invoke('a', idle())).toThrow(VisitCapError)
    expect(node).toHaveBeenCalledTimes(1)
  })

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid budget %s at construction', (budget) => {
    expect(() => createCappedNodeRun([{ nodeId: 'a', budget, node: enterRunning }])).toThrow(TypeError)
  })

  it('rejects duplicate, empty and unknown node identifiers', () => {
    const declaration = { nodeId: 'a', budget: 1, node: enterRunning }
    expect(() => createCappedNodeRun([declaration, declaration])).toThrow(TypeError)
    expect(() => createCappedNodeRun([{ ...declaration, nodeId: '' }])).toThrow(TypeError)
    expect(() => createCappedNodeRun([declaration]).invoke('missing', idle())).toThrow(TypeError)
  })
})
