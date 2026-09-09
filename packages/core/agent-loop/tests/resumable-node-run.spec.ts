import { describe, expect, it, vi } from 'vitest'
import { createResumableNodeRun } from '../src/resumable-node-run.ts'
import { createGraphState, type GraphState } from '../src/state.ts'
import type { ExecutionSnapshot } from '../src/execution-snapshot.ts'

const state = () => createGraphState({ sessionId: 's', phase: { kind: 'idle', lastTurn: 0 }, inbox: { nextTurnCount: 0, nextStepCount: 0 } })
const expected = {
  runId: 'r', sessionId: 's', graph: {
    graphId: 'g', graphRevision: '1', routingRevision: '1', entry: 'a',
    nodes: [{ nodeId: 'a', budget: 2, targets: ['a', 'b'] }, { nodeId: 'b', budget: 1, targets: [] }],
  },
}
const initial = () => ({ executionSnapshotVersion: 1, ...structuredClone(expected), revision: 0, successSeq: 0, lastGood: { state: state(), completed: null }, visits: [{ nodeId: 'a', count: 0 }, { nodeId: 'b', count: 0 }], pending: null, status: 'ready', haltReason: null })
const route = (_state: GraphState, completed: string) => completed === 'a' ? 'b' : null

describe('experimental resumable pure-node run', () => {
  it('restores after a completion without replaying its body', () => {
    const a = vi.fn((value: GraphState) => value)
    const b = vi.fn((value: GraphState) => value)
    const first = createResumableNodeRun(initial(), expected, { a, b }, route)
    first.step()
    const restored = createResumableNodeRun(first.snapshot, expected, { a, b }, route)
    restored.step()
    restored.step()
    restored.step()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(restored.snapshot.status).toBe('terminal')
    expect(restored.snapshot.successSeq).toBe(2)
  })

  it('preserves budget across round trips and rejects before the body', () => {
    const a = vi.fn((value: GraphState) => value)
    const nodes = { a, b: (value: GraphState) => value }
    const first = createResumableNodeRun(initial(), expected, nodes, () => 'a')
    first.step()
    const restored = createResumableNodeRun(first.snapshot, expected, nodes, () => 'a')
    restored.step()
    expect(() => restored.step()).toThrow(/visit cap/)
    expect(a).toHaveBeenCalledTimes(2)
  })

  it('publishes reservation before body and restores it as interrupted', () => {
    let capture: () => void = () => {}
    let reserved: ExecutionSnapshot | undefined
    const a = vi.fn((value: GraphState) => { capture(); return value })
    const nodes = { a, b: (value: GraphState) => value }
    const run = createResumableNodeRun(initial(), expected, nodes, route)
    capture = () => { reserved = run.snapshot }
    run.step()
    expect(reserved?.pending).toEqual({ attempt: 1, nodeId: 'a' })
    const restored = createResumableNodeRun(reserved, expected, nodes, route)
    expect(restored.snapshot.haltReason).toBe('interrupted')
    expect(restored.snapshot.visits[0]?.count).toBe(1)
    expect(() => restored.step()).toThrow(/halted/)
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('retains last good State and consumed attempt on failure', () => {
    const run = createResumableNodeRun(initial(), expected, {
      a: (value: GraphState) => value,
      b: () => { throw new Error('body failed') },
    }, route)
    run.step()
    const good = run.snapshot.lastGood
    expect(() => run.step()).toThrow('body failed')
    expect(run.snapshot.lastGood).toEqual(good)
    expect(run.snapshot.visits[1]?.count).toBe(1)
    expect(run.snapshot.haltReason).toBe('failed')
    expect(() => run.step()).toThrow(/halted/)
  })

  it('fails closed on cross-session output and reentrant execution', () => {
    const run = createResumableNodeRun(initial(), expected, { a: () => ({ ...state(), sessionId: 'other' }), b: (value: GraphState) => value }, route)
    expect(() => run.step()).toThrow()
    expect(run.snapshot.status).toBe('halted')
    let nested: () => void = () => {}
    const recursive = createResumableNodeRun(initial(), expected, {
      a: (value: GraphState) => { nested(); return value },
      b: (value: GraphState) => value,
    }, route)
    nested = () => { recursive.step() }
    expect(() => recursive.step()).toThrow(/reentrant/)
    expect(recursive.snapshot.status).toBe('halted')
  })

  it('rejects registry mismatch and undeclared routing before body', () => {
    const a = vi.fn((value: GraphState) => value)
    expect(() => createResumableNodeRun(initial(), expected, { a }, route)).toThrow(/registry/)
    const run = createResumableNodeRun(initial(), expected, { a, b: (value: GraphState) => value }, () => 'ghost')
    run.step()
    expect(() => run.step()).toThrow(/undeclared/)
    expect(a).toHaveBeenCalledTimes(1)
  })
})
