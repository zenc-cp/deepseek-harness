import { describe, expect, it, vi } from 'vitest'
import { createResumableNodeRunV2 } from '../src/resumable-node-run-v2.ts'
import { createGraphState, type GraphState } from '../src/state.ts'
import type { DomainResult } from '../src/domain-result.ts'
import type { ExecutionSnapshotV2 } from '../src/execution-snapshot-v2.ts'

const state = (turn = 0) => createGraphState({
  sessionId: 's',
  phase: { kind: 'idle', lastTurn: turn },
  inbox: { nextTurnCount: 0, nextStepCount: 0 },
})
const success = (value: GraphState): DomainResult => ({ kind: 'success', state: value })
const failure = (code = 'NOT_FOUND'): DomainResult => ({
  kind: 'failure', failure: { code, message: 'missing' },
})

const graph = {
  graphId: 'g', graphRevision: '1', routingRevision: '1', resultContractRevision: '1',
  entry: 'a',
  nodes: [
    { nodeId: 'a', budget: 2, targets: ['b'] },
    { nodeId: 'b', budget: 1, targets: [] },
    { nodeId: 'recover', budget: 1, targets: [] },
  ],
  failureCodes: ['NOT_FOUND'],
  recoveryTargets: [{ code: 'NOT_FOUND', target: 'recover' }],
}
const expected = { runId: 'r', sessionId: 's', graph }
const initial = () => ({
  executionSnapshotVersion: 2 as const,
  ...structuredClone(expected),
  revision: 0, successSeq: 0, expectedFailureSeq: 0,
  lastGood: { state: state(), completed: null },
  visits: [
    { nodeId: 'a', count: 0 }, { nodeId: 'b', count: 0 }, { nodeId: 'recover', count: 0 },
  ],
  pending: null, failedNodes: [] as string[], latestOutcome: null,
  status: 'ready' as const, haltReason: null,
})

const route = (_state: GraphState, completed: string) => completed === 'a' ? 'b' : null

describe('experimental resumable pure-node run v2', () => {
  it('routes expected failure to declared recovery without replaying the producer', () => {
    const a = vi.fn((_value: GraphState) => failure())
    const recover = vi.fn((_value: GraphState) => success(state(1)))
    const b = vi.fn((_value: GraphState) => success(state(2)))
    const run = createResumableNodeRunV2(initial(), expected, { a, b, recover }, route)
    const afterFailure = run.step()
    expect(afterFailure).toEqual(state())
    expect(run.snapshot.status).toBe('recoverable')
    expect(run.snapshot.failedNodes).toEqual(['a'])
    expect(run.snapshot.expectedFailureSeq).toBe(1)
    expect(run.snapshot.successSeq).toBe(0)
    const restored = createResumableNodeRunV2(run.snapshot, expected, { a, b, recover }, route)
    const recovered = restored.step()
    expect(recovered).toEqual(state(1))
    expect(a).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(restored.snapshot.successSeq).toBe(1)
    expect(restored.snapshot.lastGood.completed).toEqual({ attempt: 2, nodeId: 'recover' })
  })

  it('halts unexpected throws and does not enter recovery', () => {
    const run = createResumableNodeRunV2(initial(), expected, {
      a: () => { throw new Error('boom') },
      b: (value: GraphState) => success(value),
      recover: (value: GraphState) => success(value),
    }, route)
    expect(() => run.step()).toThrow('boom')
    expect(run.snapshot.status).toBe('halted')
    expect(run.snapshot.haltReason).toBe('failed')
    expect(run.snapshot.expectedFailureSeq).toBe(0)
    expect(run.snapshot.latestOutcome).toBeNull()
    expect(() => run.step()).toThrow(/halted/)
  })

  it('consumes recovery budget and terminates when recovery target is already failed', () => {
    const recover = vi.fn((_value: GraphState) => failure())
    const nodes = {
      a: (_value: GraphState) => failure(),
      b: (value: GraphState) => success(value),
      recover,
    }
    const run = createResumableNodeRunV2(initial(), expected, nodes, route)
    run.step()
    expect(run.snapshot.status).toBe('recoverable')
    // Recovery node fails with the same code; target recover is now itself failed => terminal.
    run.step()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(run.snapshot.failedNodes).toEqual(['a', 'recover'])
    expect(run.snapshot.status).toBe('terminal')
    expect(run.snapshot.successSeq).toBe(0)
    expect(run.snapshot.expectedFailureSeq).toBe(2)
    expect(run.snapshot.visits.find(v => v.nodeId === 'recover')?.count).toBe(1)
    run.step()
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('publishes reservation before body and restores interrupted pending as halted', () => {
    let capture: () => void = () => {}
    let reserved: ExecutionSnapshotV2 | undefined
    const a = vi.fn((value: GraphState) => {
      capture()
      return success(value)
    })
    const nodes = {
      a,
      b: (value: GraphState) => success(value),
      recover: (value: GraphState) => success(value),
    }
    const run = createResumableNodeRunV2(initial(), expected, nodes, route)
    capture = () => { reserved = run.snapshot }
    run.step()
    expect(reserved?.pending).toEqual({ attempt: 1, nodeId: 'a' })
    const restored = createResumableNodeRunV2(reserved, expected, nodes, route)
    expect(restored.snapshot.status).toBe('halted')
    expect(restored.snapshot.haltReason).toBe('interrupted')
    expect(restored.snapshot.visits[0]?.count).toBe(1)
    expect(() => restored.step()).toThrow(/halted/)
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('rejects undeclared success routing and unknown domain failure codes before next body', () => {
    const a = vi.fn((_value: GraphState) => success(state()))
    const run = createResumableNodeRunV2(initial(), expected, {
      a,
      b: (value: GraphState) => success(value),
      recover: (value: GraphState) => success(value),
    }, () => 'ghost')
    run.step()
    expect(() => run.step()).toThrow(/undeclared/)
    expect(a).toHaveBeenCalledTimes(1)

    const bad = createResumableNodeRunV2(initial(), expected, {
      a: () => failure('OTHER'),
      b: (value: GraphState) => success(value),
      recover: (value: GraphState) => success(value),
    }, route)
    expect(() => bad.step()).toThrow()
    expect(bad.snapshot.status).toBe('halted')
  })

  it('does not automatically retry a failed producer via recovery target', () => {
    const graphSelf = {
      ...graph,
      recoveryTargets: [{ code: 'NOT_FOUND', target: 'a' }],
    }
    const expectedSelf = { ...expected, graph: graphSelf }
    const initialSelf = { ...initial(), graph: structuredClone(graphSelf) }
    const a = vi.fn((_value: GraphState) => failure())
    const run = createResumableNodeRunV2(initialSelf, expectedSelf, {
      a,
      b: (value: GraphState) => success(value),
      recover: (value: GraphState) => success(value),
    }, route)
    run.step()
    expect(run.snapshot.status).toBe('terminal')
    expect(a).toHaveBeenCalledTimes(1)
    expect(() => run.step()).not.toThrow()
    expect(a).toHaveBeenCalledTimes(1)
  })
})
