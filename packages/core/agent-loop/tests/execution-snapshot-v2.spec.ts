import { describe, expect, it } from 'vitest'
import { parseExecutionSnapshotV2 } from '../src/execution-snapshot-v2.ts'
import { createGraphState } from '../src/state.ts'

const graph = {
  graphId: 'wake', graphRevision: '1', routingRevision: '1', resultContractRevision: '1',
  entry: 'a',
  nodes: [
    { nodeId: 'a', budget: 2, targets: ['b'] },
    { nodeId: 'b', budget: 1, targets: [] },
    { nodeId: 'recover', budget: 1, targets: [] },
  ],
  failureCodes: ['NOT_FOUND'],
  recoveryTargets: [{ code: 'NOT_FOUND', target: 'recover' }],
}
const expected = { runId: 'run', sessionId: 'session', graph }
const state = () => createGraphState({
  sessionId: 'session', phase: { kind: 'idle', lastTurn: 0 }, inbox: { nextTurnCount: 0, nextStepCount: 0 },
})
const initial = () => ({
  executionSnapshotVersion: 2 as const,
  runId: 'run', sessionId: 'session', graph: structuredClone(graph),
  revision: 0, successSeq: 0, expectedFailureSeq: 0,
  lastGood: { state: state(), completed: null },
  visits: [{ nodeId: 'a', count: 0 }, { nodeId: 'b', count: 0 }, { nodeId: 'recover', count: 0 }],
  pending: null,
  failedNodes: [] as string[],
  latestOutcome: null as null | Record<string, unknown>,
  status: 'ready' as const,
  haltReason: null as null | 'failed' | 'interrupted',
})
const reserved = () => ({
  ...initial(), revision: 1, pending: { attempt: 1, nodeId: 'a' },
  visits: [{ nodeId: 'a', count: 1 }, { nodeId: 'b', count: 0 }, { nodeId: 'recover', count: 0 }],
})
const failedExpected = () => ({
  ...reserved(), revision: 2, pending: null, expectedFailureSeq: 1,
  failedNodes: ['a'],
  latestOutcome: {
    kind: 'failure', invocation: { attempt: 1, nodeId: 'a' },
    failure: { code: 'NOT_FOUND', message: 'missing' },
  },
  status: 'recoverable' as const,
})
const recovered = () => ({
  ...failedExpected(), revision: 4, successSeq: 1, expectedFailureSeq: 1,
  pending: null, status: 'ready' as const,
  visits: [{ nodeId: 'a', count: 1 }, { nodeId: 'b', count: 0 }, { nodeId: 'recover', count: 1 }],
  lastGood: { state: state(), completed: { attempt: 2, nodeId: 'recover' } },
  latestOutcome: { kind: 'success', invocation: { attempt: 2, nodeId: 'recover' } },
})

describe('execution snapshot v2 parser', () => {
  it('parses initial, reserved, recoverable and recovered snapshots', () => {
    for (const value of [initial(), reserved(), failedExpected(), recovered()]) {
      expect(parseExecutionSnapshotV2(value, expected).executionSnapshotVersion).toBe(2)
    }
  })

  it('detaches and freezes nested graph, visits and failure payloads', () => {
    const value = failedExpected()
    const result = parseExecutionSnapshotV2(value, expected)
    value.graph.recoveryTargets[0]!.target = 'b'
    value.failedNodes.push('b')
    ;(value.latestOutcome as { failure: { message: string } }).failure.message = 'changed'
    expect(result.graph.recoveryTargets[0]?.target).toBe('recover')
    expect(result.failedNodes).toEqual(['a'])
    expect(result.latestOutcome?.kind).toBe('failure')
    if (result.latestOutcome?.kind !== 'failure') throw new Error('expected failure')
    expect(result.latestOutcome.failure.message).toBe('missing')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.failedNodes)).toBe(true)
    expect(Object.isFrozen(result.latestOutcome.failure)).toBe(true)
  })

  it('rejects v1 snapshots and silent upgrades', () => {
    expect(() => parseExecutionSnapshotV2({ ...initial(), executionSnapshotVersion: 1 }, expected)).toThrow()
    expect(() => parseExecutionSnapshotV2({
      version: 1, state: state(), nodeId: 'a', seq: 1, timestamp: 0,
    }, expected)).toThrow()
  })

  it('rejects unknown recovery codes and outcome-time producer retry', () => {
    const unknown = {
      ...graph,
      recoveryTargets: [{ code: 'OTHER', target: 'recover' }],
    }
    expect(() => parseExecutionSnapshotV2({ ...initial(), graph: unknown }, { ...expected, graph: unknown })).toThrow()
    // Recovery may declare a normal node, but not the node that just failed.
    const self = {
      ...failedExpected(),
      graph: { ...graph, recoveryTargets: [{ code: 'NOT_FOUND', target: 'a' }] },
    }
    expect(() => parseExecutionSnapshotV2(self, { ...expected, graph: self.graph })).toThrow()
  })

  it('requires failed-node membership and recoverable recovery path', () => {
    expect(() => parseExecutionSnapshotV2({ ...failedExpected(), failedNodes: [] }, expected)).toThrow()
    expect(() => parseExecutionSnapshotV2({ ...failedExpected(), failedNodes: ['recover'] }, expected)).toThrow()
    const noRecovery = {
      ...graph,
      recoveryTargets: [{ code: 'NOT_FOUND', target: null }],
    }
    expect(() => parseExecutionSnapshotV2({
      ...failedExpected(), graph: noRecovery, status: 'recoverable',
    }, { ...expected, graph: noRecovery })).toThrow()
    expect(parseExecutionSnapshotV2({
      ...failedExpected(), graph: noRecovery, status: 'terminal',
    }, { ...expected, graph: noRecovery }).status).toBe('terminal')
  })

  it('rejects recovery back into already failed nodes at snapshot level', () => {
    const value = {
      ...failedExpected(),
      graph: {
        ...graph,
        recoveryTargets: [{ code: 'NOT_FOUND', target: 'b' }],
      },
      failedNodes: ['a', 'b'],
      visits: [{ nodeId: 'a', count: 1 }, { nodeId: 'b', count: 1 }, { nodeId: 'recover', count: 0 }],
      revision: 4, expectedFailureSeq: 2,
      latestOutcome: {
        kind: 'failure', invocation: { attempt: 2, nodeId: 'b' },
        failure: { code: 'NOT_FOUND', message: 'missing' },
      },
    }
    // Recovery target b is already failed: recoverable is illegal.
    expect(() => parseExecutionSnapshotV2(value, {
      ...expected,
      graph: value.graph,
    })).toThrow()
  })

  it('tracks success after prior expected failure without equating successSeq to attempt id', () => {
    const result = parseExecutionSnapshotV2(recovered(), expected)
    expect(result.successSeq).toBe(1)
    expect(result.expectedFailureSeq).toBe(1)
    expect(result.lastGood.completed?.attempt).toBe(2)
    expect(result.latestOutcome?.kind).toBe('success')
  })

  it('rejects arithmetic and status disguises', () => {
    expect(() => parseExecutionSnapshotV2({
      ...failedExpected(), status: 'ready',
    }, expected)).toThrow()
    expect(() => parseExecutionSnapshotV2({
      ...failedExpected(), expectedFailureSeq: 0,
    }, expected)).toThrow()
    // Fatal halt without settling the reservation (revision still 1) is invalid.
    expect(() => parseExecutionSnapshotV2({
      ...reserved(), status: 'halted', haltReason: 'failed', pending: null,
    }, expected)).toThrow()
    expect(() => parseExecutionSnapshotV2({
      ...failedExpected(), latestOutcome: {
        kind: 'failure', invocation: { attempt: 1, nodeId: 'a' },
        failure: { code: 'OTHER', message: 'missing' },
      },
    }, expected)).toThrow()
  })

  it('accepts interrupted reservations and fatal halted failures', () => {
    expect(parseExecutionSnapshotV2({
      ...reserved(), status: 'halted', haltReason: 'interrupted',
    }, expected).haltReason).toBe('interrupted')
    expect(parseExecutionSnapshotV2({
      ...reserved(), revision: 2, pending: null, status: 'halted', haltReason: 'failed',
      latestOutcome: null, expectedFailureSeq: 0,
    }, expected).haltReason).toBe('failed')
  })
})
