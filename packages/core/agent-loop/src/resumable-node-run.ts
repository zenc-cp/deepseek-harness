/** Experimental single-owner pure-node runner. No durable storage or anti-replay guarantee. */
import { parseExecutionSnapshot, type ExecutionExpectation, type ExecutionSnapshot } from './execution-snapshot.ts'
import type { GraphState } from './state.ts'
import { VisitCapError } from './visit-cap.ts'

export interface ResumableNodeRun {
  readonly snapshot: ExecutionSnapshot
  step(): GraphState
}

/** Null routing is terminal; non-null targets must be declared on the completed node. */
export function createResumableNodeRun(
  candidate: unknown,
  expectation: ExecutionExpectation,
  registry: Readonly<Record<string, (state: GraphState) => GraphState>>,
  route: (state: GraphState, completedNodeId: string) => string | null,
): ResumableNodeRun {
  // Detach compatibility expectations from caller mutation.
  const expected = structuredClone(expectation)
  let snapshot = parseExecutionSnapshot(candidate, expected)
  const nodes = new Map(Object.entries(registry))
  const definitions = new Map(snapshot.graph.nodes.map(node => [node.nodeId, node]))
  if (nodes.size !== definitions.size || [...definitions.keys()].some(id => typeof nodes.get(id) !== 'function')) {
    throw new TypeError('node registry must exactly match graph declarations')
  }
  if (snapshot.pending) {
    snapshot = parseExecutionSnapshot({ ...snapshot, status: 'halted', haltReason: 'interrupted' }, expected)
  }
  let active = false
  return Object.freeze({
    get snapshot(): ExecutionSnapshot { return snapshot },
    step(): GraphState {
      if (active) throw new Error('reentrant execution is not supported')
      if (snapshot.status === 'halted') throw new Error('run is halted; automatic retry is not supported')
      if (snapshot.status === 'terminal') return snapshot.lastGood.state
      active = true
      try {
        const completed = snapshot.lastGood.completed
        const target = completed ? route(snapshot.lastGood.state, completed.nodeId) : snapshot.graph.entry
        if (target === null) {
          snapshot = parseExecutionSnapshot({ ...snapshot, status: 'terminal' }, expected)
          return snapshot.lastGood.state
        }
        if (completed && !definitions.get(completed.nodeId)?.targets.includes(target)) {
          throw new TypeError(`undeclared routing target "${target}"`)
        }
        const definition = definitions.get(target)
        const body = nodes.get(target)
        if (!definition || !body) throw new TypeError(`undeclared node "${target}"`)
        const count = snapshot.visits.find(visit => visit.nodeId === target)?.count ?? 0
        if (count >= definition.budget) throw new VisitCapError(target, definition.budget, count)
        // Ensure both reservation and settlement revisions fit before any body runs.
        if (!Number.isSafeInteger(snapshot.revision + 2)) throw new RangeError('snapshot revision exhausted')
        const attempt = snapshot.visits.reduce((total, visit) => total + visit.count, 0) + 1
        const pending = { attempt, nodeId: target }
        snapshot = parseExecutionSnapshot({
          ...snapshot, revision: snapshot.revision + 1, pending,
          visits: snapshot.visits.map(visit => visit.nodeId === target ? { ...visit, count: count + 1 } : visit),
        }, expected)
        try {
          const output = body(snapshot.lastGood.state)
          snapshot = parseExecutionSnapshot({
            ...snapshot, revision: snapshot.revision + 1, successSeq: snapshot.successSeq + 1,
            lastGood: { state: output, completed: pending }, pending: null,
          }, expected)
        } catch (error) {
          snapshot = parseExecutionSnapshot({
            ...snapshot, revision: snapshot.revision + 1, pending: null, status: 'halted', haltReason: 'failed',
          }, expected)
          throw error
        }
        return snapshot.lastGood.state
      } finally {
        active = false
      }
    },
  })
}
