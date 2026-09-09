import { describe, expect, it, vi } from 'vitest'
import { createResumableNodeRunV2 } from '../src/resumable-node-run-v2.ts'
import { createGraphState, type GraphState } from '../src/state.ts'
import type { DomainResult } from '../src/domain-result.ts'
import { VisitCapError } from '../src/visit-cap.ts'
import { parseExecutionSnapshotV2, type ExecutionSnapshotV2 } from '../src/execution-snapshot-v2.ts'

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
  it.each(['success', 'failure'])('restores interruption after prior %s without replay', (kind) => {
    let capture = () => {}
    let reserved: ExecutionSnapshotV2 | undefined
    const next = vi.fn((value: GraphState) => { capture(); return success(value) })
    const nodes = { a: () => kind === 'success' ? success(state()) : failure(), b: next, recover: next }
    const run = createResumableNodeRunV2(initial(), expected, nodes, route)
    run.step()
    capture = () => { reserved = run.snapshot }
    run.step()
    const restored = createResumableNodeRunV2(reserved, expected, nodes, route)
    expect(restored.snapshot.haltReason).toBe('interrupted')
    expect(() => restored.step()).toThrow(/halted/)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each(['a', 'b'])('rejects forged recovery reservation targeting %s', (target) => {
    const nodes = { a: () => failure(), b: (value: GraphState) => success(value), recover: () => success(state()) }
    const run = createResumableNodeRunV2(initial(), expected, nodes, route)
    run.step()
    const forged = {
      ...run.snapshot, revision: 3, status: 'ready', pending: { attempt: 2, nodeId: target },
      visits: run.snapshot.visits.map(v => v.nodeId === target ? { ...v, count: v.count + 1 } : v),
    }
    expect(() => parseExecutionSnapshotV2(forged, expected)).toThrow()
  })

  it('settles a recovery exception and preserves the original error', () => {
    const error = new Error('recovery exploded')
    const nodes = {
      a: () => failure(), b: (value: GraphState) => success(value),
      recover: () => { throw error },
    }
    const run = createResumableNodeRunV2(initial(), expected, nodes, route)
    run.step()
    expect(() => run.step()).toThrow(error)
    expect(run.snapshot.haltReason).toBe('failed')
    expect(run.snapshot.pending).toBeNull()
    expect(run.snapshot.revision).toBe(4)
    expect(run.snapshot.expectedFailureSeq).toBe(1)
    expect(() => run.step()).toThrow(/halted/)
  })

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
    const before = run.snapshot
    expect(() => run.step()).toThrow(/undeclared/)
    expect(run.snapshot).toEqual({ ...before, status: 'halted', haltReason: 'control' })
    expect(() => run.step()).toThrow(/halted/)
    expect(a).toHaveBeenCalledTimes(1)

    const bad = createResumableNodeRunV2(initial(), expected, {
      a: () => failure('OTHER'),
      b: (value: GraphState) => success(value),
      recover: (value: GraphState) => success(value),
    }, route)
    expect(() => bad.step()).toThrow()
    expect(bad.snapshot.status).toBe('halted')
  })

  it.each([new Error('router exploded'), new VisitCapError('b', 1, 1)])(
    'halts router exceptions as control faults and preserves error identity: %s', (error) => {
      const a = vi.fn(() => success(state(1)))
      const b = vi.fn((value: GraphState) => success(value))
      const nodes = { a, b, recover: b }
      const router = vi.fn(() => { throw error })
      const run = createResumableNodeRunV2(initial(), expected, nodes, router)
      run.step()
      const before = run.snapshot
      let caught: unknown
      try { run.step() } catch (thrown) { caught = thrown }
      expect(caught).toBe(error)
      expect(run.snapshot).toEqual({ ...before, status: 'halted', haltReason: 'control' })
      const restored = createResumableNodeRunV2(JSON.parse(JSON.stringify(run.snapshot)), expected, nodes, router)
      expect(restored.snapshot).toEqual(run.snapshot)
      expect(() => restored.step()).toThrow(/halted/)
      expect(() => run.step()).toThrow(/halted/)
      expect(router).toHaveBeenCalledTimes(1)
      expect(a).toHaveBeenCalledTimes(1)
      expect(b).not.toHaveBeenCalled()
    },
  )

  it('halts at a success-route cap without reserving or running again', () => {
    const cappedGraph = {
      ...graph,
      nodes: graph.nodes.map(node => node.nodeId === 'a' ? { ...node, budget: 1, targets: ['a'] } : node),
    }
    const expectation = { ...expected, graph: cappedGraph }
    const a = vi.fn(() => success(state(1)))
    const nodes = { a, b: a, recover: a }
    const router = vi.fn(() => 'a')
    const run = createResumableNodeRunV2({ ...initial(), graph: cappedGraph }, expectation, nodes, router)
    run.step()
    const before = run.snapshot
    expect(() => run.step()).toThrow(VisitCapError)
    expect(run.snapshot).toEqual({ ...before, status: 'halted', haltReason: 'cap-exhausted' })
    const restored = createResumableNodeRunV2(JSON.parse(JSON.stringify(run.snapshot)), expectation, nodes, router)
    expect(restored.snapshot).toEqual(run.snapshot)
    expect(() => restored.step()).toThrow(/halted/)
    expect(() => run.step()).toThrow(/halted/)
    expect(a).toHaveBeenCalledTimes(1)
    expect(router).toHaveBeenCalledTimes(1)
  })

  it('halts at an exhausted recovery target without losing the expected failure', () => {
    const recoveryGraph = {
      ...graph, entry: 'recover',
      nodes: graph.nodes.map(node => node.nodeId === 'recover' ? { ...node, targets: ['a'] } : node),
    }
    const expectation = { ...expected, graph: recoveryGraph }
    const recover = vi.fn(() => success(state(1)))
    const a = vi.fn(() => failure())
    const nodes = { a, b: recover, recover }
    const router = vi.fn(() => 'a')
    const run = createResumableNodeRunV2({ ...initial(), graph: recoveryGraph }, expectation, nodes, router)
    run.step()
    run.step()
    const before = run.snapshot
    expect(before.status).toBe('recoverable')
    expect(() => run.step()).toThrow(VisitCapError)
    expect(run.snapshot).toEqual({ ...before, status: 'halted', haltReason: 'cap-exhausted' })
    const restored = createResumableNodeRunV2(JSON.parse(JSON.stringify(run.snapshot)), expectation, nodes, router)
    expect(restored.snapshot).toEqual(run.snapshot)
    expect(() => restored.step()).toThrow(/halted/)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(router).toHaveBeenCalledTimes(1)
  })

  it('halts a declared success route back to a failed node', () => {
    const retryGraph = {
      ...graph,
      nodes: graph.nodes.map(node => node.nodeId === 'recover' ? { ...node, targets: ['a'] } : node),
    }
    const expectation = { ...expected, graph: retryGraph }
    const a = vi.fn(() => failure())
    const recover = vi.fn(() => success(state(1)))
    const nodes = { a, b: recover, recover }
    const run = createResumableNodeRunV2({ ...initial(), graph: retryGraph }, expectation, nodes, () => 'a')
    run.step()
    run.step()
    const before = run.snapshot
    expect(() => run.step()).toThrow(/cannot route to failed node/)
    expect(run.snapshot).toEqual({ ...before, status: 'halted', haltReason: 'control' })
    const restored = createResumableNodeRunV2(run.snapshot, expectation, nodes, () => 'a')
    expect(() => restored.step()).toThrow(/halted/)
    expect(a).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2])('rejects cap halts without an exhausted eligible target (entry budget %s)', (budget) => {
    const checkedGraph = { ...graph, nodes: graph.nodes.map(n => n.nodeId === 'a' ? { ...n, budget } : n) }
    const expectation = { ...expected, graph: checkedGraph }
    const body = () => success(state())
    const run = createResumableNodeRunV2({ ...initial(), graph: checkedGraph }, expectation, {
      a: body, b: body, recover: body,
    }, route)
    run.step()
    // Only b is a declared next target. Exhausting a is not evidence of a cap on b.
    expect(() => parseExecutionSnapshotV2({
      ...run.snapshot, status: 'halted', haltReason: 'cap-exhausted',
    }, expectation)).toThrow()
  })

  it.each(['control', 'cap-exhausted'])('rejects %s halts that hide pending or unaccounted attempts', (haltReason) => {
    const body = () => success(state())
    const run = createResumableNodeRunV2(initial(), expected, { a: body, b: body, recover: body }, route)
    run.step()
    const visits = run.snapshot.visits.map(v => v.nodeId === 'b' ? { ...v, count: 1 } : v)
    expect(() => parseExecutionSnapshotV2({
      ...run.snapshot, visits, revision: 3, pending: { attempt: 2, nodeId: 'b' }, status: 'halted', haltReason,
    }, expected)).toThrow()
    expect(() => parseExecutionSnapshotV2({
      ...run.snapshot, visits, revision: 4, pending: null, status: 'halted', haltReason,
    }, expected)).toThrow()
  })

  it('halts revision exhaustion before reserving an invocation', () => {
    const attempts = Math.floor(Number.MAX_SAFE_INTEGER / 2)
    const largeGraph = {
      ...graph,
      nodes: graph.nodes.map(n => n.nodeId === 'a' ? { ...n, targets: ['a'], budget: attempts + 1 } : n),
    }
    const expectation = { ...expected, graph: largeGraph }
    const invocation = { attempt: attempts, nodeId: 'a' }
    const candidate = {
      ...initial(), graph: largeGraph, revision: attempts * 2, successSeq: attempts,
      visits: initial().visits.map(v => v.nodeId === 'a' ? { ...v, count: attempts } : v),
      lastGood: { state: state(), completed: invocation }, latestOutcome: { kind: 'success', invocation },
    }
    const body = vi.fn(() => success(state()))
    const run = createResumableNodeRunV2(candidate, expectation, { a: body, b: body, recover: body }, () => 'a')
    const before = run.snapshot
    expect(() => run.step()).toThrow(/revision exhausted/)
    expect(run.snapshot).toEqual({ ...before, status: 'halted', haltReason: 'control' })
    expect(body).not.toHaveBeenCalled()
    const restored = createResumableNodeRunV2(run.snapshot, expectation, { a: body, b: body, recover: body }, () => 'a')
    expect(() => restored.step()).toThrow(/halted/)
  })

  it('keeps a node-thrown VisitCapError as a settled body failure', () => {
    const error = new VisitCapError('a', 2, 2)
    const run = createResumableNodeRunV2(initial(), expected, {
      a: () => { throw error }, b: () => success(state()), recover: () => success(state()),
    }, route)
    let caught: unknown
    try { run.step() } catch (thrown) { caught = thrown }
    expect(caught).toBe(error)
    expect(run.snapshot.haltReason).toBe('failed')
    expect(run.snapshot.revision).toBe(2)
    expect(run.snapshot.visits[0]?.count).toBe(1)
    expect(run.snapshot.pending).toBeNull()
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
