/** Experimental serialization contract only: no executor, storage or freshness proof. */
import { z as zod } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { parseGraphState } from './state.ts'

const counter = zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = zod.string().min(1)
const invocation = zod.object({ attempt: counter.min(1), nodeId: identifier }).strict()
const manifestSchema = zod.object({
  graphId: identifier,
  graphRevision: identifier,
  routingRevision: identifier,
  entry: identifier,
  nodes: zod.array(zod.object({
    nodeId: identifier, budget: counter.min(1), targets: zod.array(identifier),
  }).strict()).min(1),
}).strict()
const expectedSchema = zod.object({ runId: identifier, sessionId: identifier, graph: manifestSchema }).strict()
const snapshotSchema = zod.object({
  executionSnapshotVersion: zod.literal(1),
  runId: identifier,
  sessionId: identifier,
  graph: manifestSchema,
  revision: counter,
  successSeq: counter,
  lastGood: zod.object({ state: zod.unknown(), completed: invocation.nullable() }).strict(),
  visits: zod.array(zod.object({ nodeId: identifier, count: counter }).strict()),
  pending: invocation.nullable(),
  status: zod.enum(['ready', 'terminal', 'halted']),
  haltReason: zod.enum(['failed', 'interrupted']).nullable(),
}).strict()

export type ExecutionExpectation = zod.infer<typeof expectedSchema>
export type ExecutionSnapshot = ReturnType<typeof parseExecutionSnapshot>

function requireInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid execution snapshot: ${message}`)
}

/** Canonicalizes unordered declaration sets; revisions must cover semantic code changes. */
function canonicalManifest(value: zod.infer<typeof manifestSchema>): string {
  const ids = new Set(value.nodes.map(node => node.nodeId))
  requireInvariant(ids.size === value.nodes.length, 'duplicate node identity')
  requireInvariant(ids.has(value.entry), 'unknown graph entry')
  for (const node of value.nodes) {
    requireInvariant(new Set(node.targets).size === node.targets.length, 'duplicate target')
    requireInvariant(node.targets.every(target => ids.has(target)), 'unknown target')
  }
  const nodes = value.nodes.map(node => ({ ...node, targets: [...node.targets].sort() }))
  nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  return JSON.stringify({ ...value, nodes })
}

/**
 * Parse a trusted-origin candidate against caller-owned compatibility expectations.
 * Revision counts reservations and settlements: initial 0, +1 before and after each attempt.
 * This proves structural consistency, not actual execution history or latest-store ownership.
 */
export function parseExecutionSnapshot(value: unknown, expectation: ExecutionExpectation) {
  const expected = expectedSchema.parse(expectation)
  const cp = snapshotSchema.parse(value)
  requireInvariant(cp.runId === expected.runId && cp.sessionId === expected.sessionId, 'run/session mismatch')
  requireInvariant(canonicalManifest(cp.graph) === canonicalManifest(expected.graph), 'graph compatibility mismatch')
  const state = parseGraphState(cp.lastGood.state)
  requireInvariant(state.sessionId === cp.sessionId, 'nested session mismatch')
  const counts = new Map(cp.visits.map(visit => [visit.nodeId, visit.count]))
  requireInvariant(counts.size === cp.visits.length && counts.size === cp.graph.nodes.length, 'visit identities mismatch')
  let attempts = 0
  for (const node of cp.graph.nodes) {
    const count = counts.get(node.nodeId)
    requireInvariant(count !== undefined && count <= node.budget, 'missing or over-budget count')
    attempts += count
    requireInvariant(Number.isSafeInteger(attempts), 'unsafe total attempts')
  }
  const settled = attempts - (cp.pending ? 1 : 0)
  requireInvariant(settled >= 0 && cp.successSeq <= settled, 'success count exceeds settled attempts')
  requireInvariant(cp.revision === attempts + settled && Number.isSafeInteger(attempts + settled), 'reservation revision mismatch')
  requireInvariant((cp.status === 'halted') === (cp.haltReason !== null), 'halt status mismatch')
  requireInvariant(cp.status !== 'terminal' || cp.pending === null, 'terminal pending invocation')
  requireInvariant(cp.status !== 'halted' || attempts > 0, 'halt without attempt')
  // This protocol halts on the first failed/interrupted attempt; no retries exist.
  const failedAttempts = settled - cp.successSeq
  if (cp.haltReason === 'failed') {
    requireInvariant(cp.pending === null && failedAttempts === 1, 'failed halt requires one settled failure')
  } else {
    requireInvariant(failedAttempts === 0, 'non-failed snapshot contains failed attempts')
  }
  if (cp.haltReason === 'interrupted') {
    requireInvariant(cp.pending !== null, 'interrupted halt requires a reservation')
  }
  const completed = cp.lastGood.completed
  requireInvariant((cp.successSeq === 0) === (completed === null), 'completed marker mismatch')
  if (completed) {
    requireInvariant(completed.attempt === cp.successSeq, 'completed attempt mismatch')
    requireInvariant((counts.get(completed.nodeId) ?? 0) > 0, 'completed node has no visits')
  }
  if (cp.pending) {
    requireInvariant(cp.pending.attempt === attempts, 'pending must be latest attempt')
    requireInvariant((counts.get(cp.pending.nodeId) ?? 0) > 0, 'pending node has no visits')
    if (completed?.nodeId === cp.pending.nodeId) {
      requireInvariant((counts.get(completed.nodeId) ?? 0) >= 2, 'pending and completed require distinct visits')
    }
  }
  return deepFreeze({ ...cp, lastGood: { ...cp.lastGood, state } })
}
