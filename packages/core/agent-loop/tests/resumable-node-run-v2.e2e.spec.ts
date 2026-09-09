import { describe, expect, it, vi } from 'vitest'
import { createResumableNodeRunV2 } from '../src/resumable-node-run-v2.ts'
import { createGraphState, type GraphState } from '../src/state.ts'
import type { DomainResult } from '../src/domain-result.ts'

/**
 * End-to-end pure fixture:
 * prepare (success) -> fetch (expected failure) -> recover (success) -> terminal
 * Budgets and lastGood must survive the full path and a mid-run restore.
 */
const state = (turn = 0) => createGraphState({
  sessionId: 'e2e',
  phase: { kind: 'idle', lastTurn: turn },
  inbox: { nextTurnCount: 0, nextStepCount: 0 },
})
const ok = (turn: number): DomainResult => ({ kind: 'success', state: state(turn) })
const missing = (): DomainResult => ({
  kind: 'failure', failure: { code: 'NOT_FOUND', message: 'record missing' },
})

const graph = {
  graphId: 'fixture', graphRevision: '1', routingRevision: '1', resultContractRevision: '1',
  entry: 'prepare',
  nodes: [
    { nodeId: 'prepare', budget: 1, targets: ['fetch'] },
    { nodeId: 'fetch', budget: 1, targets: ['done'] },
    { nodeId: 'recover', budget: 1, targets: ['done'] },
    { nodeId: 'done', budget: 1, targets: [] },
  ],
  failureCodes: ['NOT_FOUND'],
  recoveryTargets: [{ code: 'NOT_FOUND', target: 'recover' }],
}
const expected = { runId: 'e2e-run', sessionId: 'e2e', graph }
const initial = () => ({
  executionSnapshotVersion: 2 as const,
  ...structuredClone(expected),
  revision: 0, successSeq: 0, expectedFailureSeq: 0,
  lastGood: { state: state(0), completed: null },
  visits: [
    { nodeId: 'prepare', count: 0 },
    { nodeId: 'fetch', count: 0 },
    { nodeId: 'recover', count: 0 },
    { nodeId: 'done', count: 0 },
  ],
  pending: null, failedNodes: [] as string[], latestOutcome: null,
  status: 'ready' as const, haltReason: null,
})

const route = (_state: GraphState, completed: string): string | null => {
  if (completed === 'prepare') return 'fetch'
  if (completed === 'recover') return 'done'
  if (completed === 'done') return null
  return null
}

describe('resumable v2 end-to-end pure fixture', () => {
  it('walks success → expected failure → recovery → terminal with preserved budgets', () => {
    const prepare = vi.fn((_value: GraphState) => ok(1))
    const fetch = vi.fn((_value: GraphState) => missing())
    const recover = vi.fn((_value: GraphState) => ok(2))
    const done = vi.fn((_value: GraphState) => ok(3))
    const nodes = { prepare, fetch, recover, done }

    const run = createResumableNodeRunV2(initial(), expected, nodes, route)

    // 1. prepare succeeds
    expect(run.step()).toEqual(state(1))
    expect(run.snapshot.status).toBe('ready')
    expect(run.snapshot.successSeq).toBe(1)
    expect(run.snapshot.lastGood.completed).toEqual({ attempt: 1, nodeId: 'prepare' })

    // 2. fetch returns expected failure; lastGood stays prepare
    expect(run.step()).toEqual(state(1))
    expect(run.snapshot.status).toBe('recoverable')
    expect(run.snapshot.expectedFailureSeq).toBe(1)
    expect(run.snapshot.failedNodes).toEqual(['fetch'])
    expect(run.snapshot.lastGood.completed).toEqual({ attempt: 1, nodeId: 'prepare' })

    // Mid-run restore must not replay prepare/fetch bodies.
    const restored = createResumableNodeRunV2(run.snapshot, expected, nodes, route)
    expect(restored.snapshot.status).toBe('recoverable')

    // 3. recovery succeeds
    expect(restored.step()).toEqual(state(2))
    expect(restored.snapshot.status).toBe('ready')
    expect(restored.snapshot.successSeq).toBe(2)
    expect(restored.snapshot.lastGood.completed).toEqual({ attempt: 3, nodeId: 'recover' })

    // 4. done succeeds then terminal
    expect(restored.step()).toEqual(state(3))
    expect(restored.snapshot.lastGood.completed).toEqual({ attempt: 4, nodeId: 'done' })
    expect(restored.step()).toEqual(state(3))
    expect(restored.snapshot.status).toBe('terminal')

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(done).toHaveBeenCalledTimes(1)
    expect(restored.snapshot.visits).toEqual([
      { nodeId: 'prepare', count: 1 },
      { nodeId: 'fetch', count: 1 },
      { nodeId: 'recover', count: 1 },
      { nodeId: 'done', count: 1 },
    ])
    expect(restored.snapshot.expectedFailureSeq).toBe(1)
    expect(restored.snapshot.successSeq).toBe(3)
    expect(restored.snapshot.failedNodes).toEqual(['fetch'])
  })
})
