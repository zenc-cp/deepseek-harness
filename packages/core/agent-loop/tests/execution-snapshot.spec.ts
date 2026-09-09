import { describe, expect, it } from 'vitest'
import { parseExecutionSnapshot } from '../src/execution-snapshot.ts'
import { createGraphState } from '../src/state.ts'

const graph = {
  graphId: 'wake', graphRevision: '1', routingRevision: '1', entry: 'a',
  nodes: [{ nodeId: 'a', budget: 3, targets: ['a', 'b'] }, { nodeId: 'b', budget: 1, targets: [] }],
}
const expected = { runId: 'run', sessionId: 'session', graph }
const initial = () => ({
  executionSnapshotVersion: 1, runId: 'run', sessionId: 'session', graph: structuredClone(graph),
  revision: 0, successSeq: 0,
  lastGood: {
    state: createGraphState({ sessionId: 'session', phase: { kind: 'idle', lastTurn: 0 }, inbox: { nextTurnCount: 1, nextStepCount: 0 } }),
    completed: null,
  },
  visits: [{ nodeId: 'a', count: 0 }, { nodeId: 'b', count: 0 }],
  pending: null, status: 'ready', haltReason: null,
})
const pending = () => ({ ...initial(), revision: 1, visits: [{ nodeId: 'a', count: 1 }, { nodeId: 'b', count: 0 }], pending: { attempt: 1, nodeId: 'a' } })
const completed = () => ({ ...pending(), revision: 2, successSeq: 1, pending: null, lastGood: { ...initial().lastGood, completed: { attempt: 1, nodeId: 'a' } } })

describe('execution snapshot parser', () => {
  it('rejects status changes that disguise failed or interrupted attempts', () => {
    const failed = { ...pending(), revision: 2, pending: null }
    expect(() => parseExecutionSnapshot(failed, expected)).toThrow()
    expect(() => parseExecutionSnapshot({ ...failed, status: 'terminal' }, expected)).toThrow()
    expect(() => parseExecutionSnapshot({ ...pending(), status: 'halted', haltReason: 'failed' }, expected)).toThrow()
    expect(() => parseExecutionSnapshot({ ...completed(), status: 'halted', haltReason: 'interrupted' }, expected)).toThrow()
    expect(() => parseExecutionSnapshot({ ...completed(), status: 'halted', haltReason: 'failed' }, expected)).toThrow()
  })

  it('requires the completed marker to identify the latest successful attempt', () => {
    const value = { ...completed(), revision: 4, successSeq: 2, visits: [{ nodeId: 'a', count: 2 }, { nodeId: 'b', count: 0 }] }
    expect(() => parseExecutionSnapshot(value, expected)).toThrow()
  })

  it('parses initial, reserved, completed and halted snapshots without execution', () => {
    for (const value of [initial(), pending(), completed(), { ...pending(), revision: 2, pending: null, status: 'halted', haltReason: 'failed' }]) {
      expect(parseExecutionSnapshot(value, expected).runId).toBe('run')
    }
  })

  it('detaches and deeply freezes the validated snapshot', () => {
    const value = initial()
    const result = parseExecutionSnapshot(value, expected)
    value.graph.nodes[0]!.budget = 99
    value.visits[0]!.count = 99
    expect(result.graph.nodes[0]?.budget).toBe(3)
    expect(result.visits[0]?.count).toBe(0)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.graph.nodes[0]?.targets)).toBe(true)
    expect(Object.isFrozen(result.lastGood.state.phase)).toBe(true)
  })

  it.each([
    { executionSnapshotVersion: 0 }, { runId: 'other' }, { sessionId: 'other' },
    { revision: -1 }, { revision: Infinity }, { successSeq: 1 }, { extra: true },
    { visits: [{ nodeId: 'a', count: 0 }] },
    { visits: [{ nodeId: 'a', count: 0 }, { nodeId: 'a', count: 0 }] },
    { visits: [{ nodeId: 'a', count: -1 }, { nodeId: 'b', count: 0 }] },
    { visits: [{ nodeId: 'a', count: 4 }, { nodeId: 'b', count: 0 }] },
    { visits: [{ nodeId: 'a', count: 0.5 }, { nodeId: 'b', count: 0 }] },
    { visits: [{ nodeId: 'a', count: 0 }, { nodeId: 'ghost', count: 0 }] },
    { status: 'halted' }, { haltReason: 'failed' },
  ])('rejects malformed or inconsistent initial snapshot %j', (patch) => {
    expect(() => parseExecutionSnapshot({ ...initial(), ...patch }, expected)).toThrow()
  })

  it('rejects legacy checkpoints and malformed or mismatched nested State', () => {
    expect(() => parseExecutionSnapshot({ version: 1, state: initial().lastGood.state, nodeId: 'a', seq: 1, timestamp: 0 }, expected)).toThrow()
    for (const state of [null, { ...initial().lastGood.state, version: 99 }, { ...initial().lastGood.state, sessionId: 'other' }]) {
      expect(() => parseExecutionSnapshot({ ...initial(), lastGood: { state, completed: null } }, expected)).toThrow()
    }
  })

  it('rejects incompatible graph declarations', () => {
    for (const changed of [
      { ...graph, graphRevision: '2' }, { ...graph, routingRevision: '2' },
      { ...graph, nodes: [{ ...graph.nodes[0]!, budget: 4 }, graph.nodes[1]!] },
      { ...graph, nodes: [{ ...graph.nodes[0]!, targets: ['b'] }, graph.nodes[1]!] },
    ]) expect(() => parseExecutionSnapshot({ ...initial(), graph: changed }, expected)).toThrow()
  })

  it('rejects invalid manifests even when expected matches them', () => {
    for (const bad of [
      { ...graph, entry: 'ghost' },
      { ...graph, nodes: [graph.nodes[0]!, graph.nodes[0]!] },
      { ...graph, nodes: [{ ...graph.nodes[0]!, budget: 0 }, graph.nodes[1]!] },
      { ...graph, nodes: [{ ...graph.nodes[0]!, targets: ['ghost'] }, graph.nodes[1]!] },
    ]) expect(() => parseExecutionSnapshot({ ...initial(), graph: bad }, { ...expected, graph: bad })).toThrow()
  })

  it('accepts equivalent declaration ordering and terminal snapshots', () => {
    const reordered = { ...graph, nodes: [...graph.nodes].reverse().map(node => ({ ...node, targets: [...node.targets].reverse() })) }
    expect(parseExecutionSnapshot({ ...completed(), graph: reordered, status: 'terminal' }, expected).status).toBe('terminal')
  })

  it('accepts interrupted reservations while preserving their consumed count', () => {
    const result = parseExecutionSnapshot({ ...pending(), status: 'halted', haltReason: 'interrupted' }, expected)
    expect(result.pending?.attempt).toBe(1)
    expect(result.visits[0]?.count).toBe(1)
  })

  it('rejects unsafe counts and duplicate targets', () => {
    expect(() => parseExecutionSnapshot({ ...initial(), visits: [{ nodeId: 'a', count: Number.MAX_SAFE_INTEGER + 1 }] }, expected)).toThrow()
    const bad = { ...graph, nodes: [{ ...graph.nodes[0]!, targets: ['a', 'a'] }, graph.nodes[1]!] }
    expect(() => parseExecutionSnapshot({ ...initial(), graph: bad }, { ...expected, graph: bad })).toThrow()
  })

  it('rejects inconsistent pending and completed invocation identities', () => {
    for (const value of [
      { ...initial(), pending: { attempt: 1, nodeId: 'a' } },
      { ...pending(), pending: { attempt: 2, nodeId: 'a' } },
      { ...pending(), pending: { attempt: 1, nodeId: 'b' } },
      { ...pending(), status: 'terminal' },
      { ...pending(), revision: 2 },
      { ...completed(), lastGood: { ...initial().lastGood, completed: { attempt: 2, nodeId: 'a' } } },
      { ...completed(), lastGood: { ...initial().lastGood, completed: null } },
    ]) expect(() => parseExecutionSnapshot(value, expected)).toThrow()
  })
})
