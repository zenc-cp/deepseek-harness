/**
 * Experimental single-owner pure-node runner on execution-snapshot v2.
 * Expected domain failures are recoverable via declared targets.
 * Unexpected throws remain fail-closed. No durable store or anti-replay proof.
 */
import { parseDomainResult, type DomainResult } from './domain-result.ts'
import {
  parseExecutionSnapshotV2,
  type ExecutionExpectationV2,
  type ExecutionSnapshotV2,
} from './execution-snapshot-v2.ts'
import type { GraphState } from './state.ts'
import { VisitCapError } from './visit-cap.ts'

export interface ResumableNodeRunV2 {
  readonly snapshot: ExecutionSnapshotV2
  step(): GraphState
}

type NodeBody = (state: GraphState) => DomainResult

function recoveryTarget(snapshot: ExecutionSnapshotV2, code: string): string | null {
  const entry = snapshot.graph.recoveryTargets.find(item => item.code === code)
  if (!entry) throw new TypeError(`undeclared recovery code "${code}"`)
  return entry.target
}

/** Null success routing is terminal; recovery uses declared failure targets only. */
export function createResumableNodeRunV2(
  candidate: unknown,
  expectation: ExecutionExpectationV2,
  registry: Readonly<Record<string, NodeBody>>,
  route: (state: GraphState, completedNodeId: string) => string | null,
): ResumableNodeRunV2 {
  const expected = structuredClone(expectation)
  let snapshot = parseExecutionSnapshotV2(candidate, expected)
  const nodes = new Map(Object.entries(registry))
  const definitions = new Map(snapshot.graph.nodes.map(node => [node.nodeId, node]))
  if (nodes.size !== definitions.size || [...definitions.keys()].some(id => typeof nodes.get(id) !== 'function')) {
    throw new TypeError('node registry must exactly match graph declarations')
  }
  if (snapshot.pending) {
    snapshot = parseExecutionSnapshotV2({
      ...snapshot,
      status: 'halted',
      haltReason: 'interrupted',
    }, expected)
  }
  let active = false
  return Object.freeze({
    get snapshot(): ExecutionSnapshotV2 { return snapshot },
    step(): GraphState {
      if (active) throw new Error('reentrant execution is not supported')
      if (snapshot.status === 'halted') throw new Error('run is halted; automatic retry is not supported')
      if (snapshot.status === 'terminal') return snapshot.lastGood.state
      active = true
      let reserved = false
      let preBodyReason: 'control' | 'cap-exhausted' = 'control'
      try {
        let target: string | null
        if (snapshot.status === 'recoverable') {
          if (snapshot.latestOutcome?.kind !== 'failure') {
            throw new TypeError('recoverable snapshot missing failure outcome')
          }
          target = recoveryTarget(snapshot, snapshot.latestOutcome.failure.code)
          if (target === null || snapshot.failedNodes.includes(target)) {
            snapshot = parseExecutionSnapshotV2({ ...snapshot, status: 'terminal' }, expected)
            return snapshot.lastGood.state
          }
          if (target === snapshot.latestOutcome.invocation.nodeId) {
            snapshot = parseExecutionSnapshotV2({ ...snapshot, status: 'terminal' }, expected)
            return snapshot.lastGood.state
          }
        } else {
          const completed = snapshot.lastGood.completed
          target = completed ? route(snapshot.lastGood.state, completed.nodeId) : snapshot.graph.entry
          if (target === null) {
            snapshot = parseExecutionSnapshotV2({ ...snapshot, status: 'terminal' }, expected)
            return snapshot.lastGood.state
          }
          if (completed && !definitions.get(completed.nodeId)?.targets.includes(target)) {
            throw new TypeError(`undeclared routing target "${target}"`)
          }
          if (snapshot.failedNodes.includes(target)) {
            throw new TypeError(`cannot route to failed node "${target}"`)
          }
        }

        const definition = definitions.get(target)
        const body = nodes.get(target)
        if (!definition || !body) throw new TypeError(`undeclared node "${target}"`)
        const count = snapshot.visits.find(visit => visit.nodeId === target)?.count ?? 0
        if (count >= definition.budget) {
          // Classify by execution stage, not error class: a router can throw VisitCapError too.
          preBodyReason = 'cap-exhausted'
          throw new VisitCapError(target, definition.budget, count)
        }
        if (!Number.isSafeInteger(snapshot.revision + 2)) throw new RangeError('snapshot revision exhausted')

        const attempt = snapshot.visits.reduce((total, visit) => total + visit.count, 0) + 1
        const pending = { attempt, nodeId: target }
        snapshot = parseExecutionSnapshotV2({
          ...snapshot,
          revision: snapshot.revision + 1,
          pending,
          status: 'ready',
          visits: snapshot.visits.map(visit => (
            visit.nodeId === target ? { ...visit, count: count + 1 } : visit
          )),
        }, expected)
        reserved = true

        try {
          const raw = body(snapshot.lastGood.state)
          const result = parseDomainResult(raw, snapshot.graph.failureCodes)
          if (result.kind === 'success') {
            if (result.state.sessionId !== snapshot.sessionId) {
              throw new TypeError('node output session mismatch')
            }
            snapshot = parseExecutionSnapshotV2({
              ...snapshot,
              revision: snapshot.revision + 1,
              successSeq: snapshot.successSeq + 1,
              pending: null,
              status: 'ready',
              haltReason: null,
              lastGood: { state: result.state, completed: pending },
              latestOutcome: { kind: 'success', invocation: pending },
            }, expected)
            return snapshot.lastGood.state
          }

          const failedNodes = snapshot.failedNodes.includes(pending.nodeId)
            ? [...snapshot.failedNodes]
            : [...snapshot.failedNodes, pending.nodeId]
          const recovery = recoveryTarget(snapshot, result.failure.code)
          const terminal = recovery === null
            || recovery === pending.nodeId
            || failedNodes.includes(recovery)
          snapshot = parseExecutionSnapshotV2({
            ...snapshot,
            revision: snapshot.revision + 1,
            expectedFailureSeq: snapshot.expectedFailureSeq + 1,
            pending: null,
            failedNodes,
            latestOutcome: {
              kind: 'failure',
              invocation: pending,
              failure: result.failure,
            },
            status: terminal ? 'terminal' : 'recoverable',
            haltReason: null,
          }, expected)
          return snapshot.lastGood.state
        } catch (error) {
          snapshot = parseExecutionSnapshotV2({
            ...snapshot,
            revision: snapshot.revision + 1,
            pending: null,
            status: 'halted',
            haltReason: 'failed',
            latestOutcome: null,
          }, expected)
          throw error
        }
      } catch (error) {
        if (!reserved) {
          // No new invocation occurred. Revision counts reservations/settlements, not status writes.
          snapshot = parseExecutionSnapshotV2({
            ...snapshot, status: 'halted', haltReason: preBodyReason,
          }, expected)
        }
        throw error
      } finally {
        active = false
      }
    },
  })
}
