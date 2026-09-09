/**
 * Experimental execution-snapshot v2 serialization contract.
 * Adds expected domain-failure outcomes and recovery declarations.
 * No executor, storage, freshness proof, or silent v1 upgrade.
 */
import { z as zod } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { parseDomainResult } from './domain-result.ts'
import { parseGraphState } from './state.ts'

const counter = zod.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = zod.string().min(1)
const codeSchema = zod.string().min(1).max(64).refine(value => value.trim().length > 0)
const invocation = zod.object({ attempt: counter.min(1), nodeId: identifier }).strict()

const manifestSchema = zod.object({
  graphId: identifier,
  graphRevision: identifier,
  routingRevision: identifier,
  resultContractRevision: identifier,
  entry: identifier,
  nodes: zod.array(zod.object({
    nodeId: identifier,
    budget: counter.min(1),
    targets: zod.array(identifier),
  }).strict()).min(1),
  failureCodes: zod.array(codeSchema),
  recoveryTargets: zod.array(zod.object({
    code: codeSchema,
    target: identifier.nullable(),
  }).strict()),
}).strict()

const expectedSchema = zod.object({
  runId: identifier,
  sessionId: identifier,
  graph: manifestSchema,
}).strict()

const latestOutcomeSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('success'), invocation }).strict(),
  zod.object({
    kind: zod.literal('failure'),
    invocation,
    failure: zod.object({ code: codeSchema, message: zod.string().min(1).max(1024) }).strict(),
  }).strict(),
])

const snapshotSchema = zod.object({
  executionSnapshotVersion: zod.literal(2),
  runId: identifier,
  sessionId: identifier,
  graph: manifestSchema,
  revision: counter,
  successSeq: counter,
  expectedFailureSeq: counter,
  lastGood: zod.object({ state: zod.unknown(), completed: invocation.nullable() }).strict(),
  visits: zod.array(zod.object({ nodeId: identifier, count: counter }).strict()),
  pending: invocation.nullable(),
  failedNodes: zod.array(identifier),
  latestOutcome: latestOutcomeSchema.nullable(),
  status: zod.enum(['ready', 'recoverable', 'terminal', 'halted']),
  haltReason: zod.enum(['failed', 'interrupted']).nullable(),
}).strict()

export type ExecutionExpectationV2 = zod.infer<typeof expectedSchema>
export type ExecutionSnapshotV2 = {
  readonly executionSnapshotVersion: 2
  readonly runId: string
  readonly sessionId: string
  readonly graph: zod.infer<typeof manifestSchema>
  readonly revision: number
  readonly successSeq: number
  readonly expectedFailureSeq: number
  readonly lastGood: {
    readonly state: ReturnType<typeof parseGraphState>
    readonly completed: zod.infer<typeof invocation> | null
  }
  readonly visits: ReadonlyArray<{ readonly nodeId: string; readonly count: number }>
  readonly pending: zod.infer<typeof invocation> | null
  readonly failedNodes: readonly string[]
  readonly latestOutcome:
    | { readonly kind: 'success'; readonly invocation: zod.infer<typeof invocation> }
    | {
      readonly kind: 'failure'
      readonly invocation: zod.infer<typeof invocation>
      readonly failure: { readonly code: string; readonly message: string }
    }
    | null
  readonly status: 'ready' | 'recoverable' | 'terminal' | 'halted'
  readonly haltReason: 'failed' | 'interrupted' | null
}

function requireInvariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid execution snapshot v2: ${message}`)
}

/** Canonicalizes unordered declaration sets; revisions must cover semantic changes. */
function canonicalManifest(value: zod.infer<typeof manifestSchema>): string {
  const ids = new Set(value.nodes.map(node => node.nodeId))
  requireInvariant(ids.size === value.nodes.length, 'duplicate node identity')
  requireInvariant(ids.has(value.entry), 'unknown graph entry')
  for (const node of value.nodes) {
    requireInvariant(new Set(node.targets).size === node.targets.length, 'duplicate target')
    requireInvariant(node.targets.every(target => ids.has(target)), 'unknown target')
  }
  const codes = new Set(value.failureCodes)
  requireInvariant(codes.size === value.failureCodes.length, 'duplicate failure code')
  const recoveryCodes = new Set(value.recoveryTargets.map(entry => entry.code))
  requireInvariant(recoveryCodes.size === value.recoveryTargets.length, 'duplicate recovery code')
  for (const entry of value.recoveryTargets) {
    requireInvariant(codes.has(entry.code), 'recovery uses undeclared failure code')
    if (entry.target !== null) {
      requireInvariant(ids.has(entry.target), 'unknown recovery target')
    }
  }
  const nodes = value.nodes.map(node => ({ ...node, targets: [...node.targets].sort() }))
  nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  const recoveryTargets = [...value.recoveryTargets]
    .map(entry => ({ ...entry }))
    .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  const failureCodes = [...value.failureCodes].sort()
  return JSON.stringify({ ...value, nodes, failureCodes, recoveryTargets })
}

function recoveryTargetFor(
  graph: zod.infer<typeof manifestSchema>,
  code: string,
): string | null | undefined {
  return graph.recoveryTargets.find(entry => entry.code === code)?.target
}

/**
 * Parse a trusted-origin v2 candidate against caller-owned compatibility expectations.
 * Proves structural consistency only: not execution authenticity or latest-store ownership.
 */
export function parseExecutionSnapshotV2(
  value: unknown,
  expectation: ExecutionExpectationV2,
): ExecutionSnapshotV2 {
  const expected = expectedSchema.parse(expectation)
  const cp = snapshotSchema.parse(value)
  requireInvariant(cp.runId === expected.runId && cp.sessionId === expected.sessionId, 'run/session mismatch')
  requireInvariant(canonicalManifest(cp.graph) === canonicalManifest(expected.graph), 'graph compatibility mismatch')

  // No-retry is enforced at outcome time: recovery target must differ from the failed
  // invocation node and must not already appear in failedNodes. Declaration only checks
  // code/target identity validity above.

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
  const pendingCount = cp.pending ? 1 : 0
  const settled = attempts - pendingCount
  requireInvariant(settled >= 0, 'pending exceeds reserved attempts')
  requireInvariant(cp.successSeq + cp.expectedFailureSeq <= settled, 'settled outcomes exceed attempts')
  // Fatal halted failure settles one attempt without expectedFailureSeq/successSeq.
  const accounted = cp.successSeq + cp.expectedFailureSeq + (cp.haltReason === 'failed' && !cp.pending ? 1 : 0)
  // Interrupted keeps pending, so settled accounts only successes/expected failures.
  if (cp.haltReason === 'interrupted') {
    requireInvariant(cp.successSeq + cp.expectedFailureSeq === settled, 'interrupted settlement mismatch')
  } else if (cp.haltReason === 'failed') {
    requireInvariant(accounted === settled && cp.pending === null, 'fatal failure settlement mismatch')
  } else {
    requireInvariant(cp.successSeq + cp.expectedFailureSeq === settled, 'ready settlement mismatch')
  }
  requireInvariant(cp.revision === attempts + settled && Number.isSafeInteger(attempts + settled), 'reservation revision mismatch')
  requireInvariant((cp.status === 'halted') === (cp.haltReason !== null), 'halt status mismatch')
  requireInvariant(cp.status !== 'terminal' || cp.pending === null, 'terminal pending invocation')
  requireInvariant(cp.status !== 'halted' || attempts > 0, 'halt without attempt')
  requireInvariant(cp.status !== 'recoverable' || cp.pending === null, 'recoverable pending invocation')

  const failedNodeSet = new Set(cp.failedNodes)
  requireInvariant(failedNodeSet.size === cp.failedNodes.length, 'duplicate failed node')
  for (const nodeId of cp.failedNodes) {
    requireInvariant(counts.has(nodeId), 'failed node not in graph')
    requireInvariant((counts.get(nodeId) ?? 0) > 0, 'failed node has no visits')
  }
  requireInvariant(failedNodeSet.size === cp.expectedFailureSeq, 'failed-node count mismatch')

  const completed = cp.lastGood.completed
  requireInvariant((cp.successSeq === 0) === (completed === null), 'completed marker mismatch')
  if (completed) {
    requireInvariant(completed.attempt >= 1 && completed.attempt <= attempts, 'completed attempt out of range')
    requireInvariant((counts.get(completed.nodeId) ?? 0) > 0, 'completed node has no visits')
    requireInvariant(!failedNodeSet.has(completed.nodeId) || (counts.get(completed.nodeId) ?? 0) >= 1, 'completed on failed node')
  }

  if (cp.pending) {
    requireInvariant(cp.pending.attempt === attempts, 'pending must be latest attempt')
    requireInvariant((counts.get(cp.pending.nodeId) ?? 0) > 0, 'pending node has no visits')
    requireInvariant(!failedNodeSet.has(cp.pending.nodeId) || (counts.get(cp.pending.nodeId) ?? 0) >= 2, 'pending retries failed node')
  }

  if (cp.latestOutcome) {
    const invocationAttempt = cp.latestOutcome.invocation.attempt
    // Pending may coexist with the previous settled outcome while the next attempt is reserved.
    if (cp.pending) {
      requireInvariant(invocationAttempt < cp.pending.attempt, 'pending outcome ordering')
    } else {
      requireInvariant(invocationAttempt >= 1 && invocationAttempt <= settled, 'outcome attempt out of range')
    }
    requireInvariant(invocationAttempt >= 1 && invocationAttempt <= attempts, 'outcome attempt bounds')
    requireInvariant((counts.get(cp.latestOutcome.invocation.nodeId) ?? 0) > 0, 'outcome node has no visits')
    if (cp.latestOutcome.kind === 'success') {
      requireInvariant(completed !== null, 'success outcome without completed marker')
      requireInvariant(completed.attempt === invocationAttempt, 'success outcome/completed mismatch')
      requireInvariant(completed.nodeId === cp.latestOutcome.invocation.nodeId, 'success node mismatch')
      requireInvariant(cp.status === 'ready' || cp.status === 'terminal', 'success status mismatch')
    } else {
      // Validate failure payload against declared codes via domain-result rules.
      parseDomainResult({ kind: 'failure', failure: cp.latestOutcome.failure }, cp.graph.failureCodes)
      requireInvariant(failedNodeSet.has(cp.latestOutcome.invocation.nodeId), 'failure missing failed node')
      if (!cp.pending) {
        requireInvariant(
          cp.latestOutcome.invocation.attempt === settled || cp.haltReason === 'failed',
          'failure outcome must be latest settled attempt',
        )
      }
      const target = recoveryTargetFor(cp.graph, cp.latestOutcome.failure.code)
      requireInvariant(target !== undefined, 'failure code missing recovery declaration')
      const retriesProducer = target === cp.latestOutcome.invocation.nodeId
      const targetAlreadyFailed = target !== null && failedNodeSet.has(target)
      if (cp.status === 'recoverable') {
        requireInvariant(target !== null, 'recoverable requires recovery target')
        requireInvariant(!retriesProducer, 'recovery retries failed producer')
        requireInvariant(!targetAlreadyFailed, 'recovery target already failed')
        requireInvariant(cp.haltReason === null, 'recoverable halt reason')
        requireInvariant(cp.pending === null, 'recoverable pending invocation')
      } else if (cp.status === 'terminal') {
        // Terminal when no recovery, recovery would retry producer, or target already failed.
        requireInvariant(
          target === null || retriesProducer || targetAlreadyFailed,
          'terminal expected-failure status',
        )
      } else if (cp.status === 'ready' && cp.pending) {
        // Recovery or later attempt reserved; previous failure outcome remains until settlement.
        requireInvariant(cp.haltReason === null, 'ready pending halt reason')
      } else {
        requireInvariant(cp.status === 'halted' && cp.haltReason === 'failed', 'unexpected failure status')
      }
    }
  } else {
    requireInvariant(cp.expectedFailureSeq === 0 || cp.haltReason === 'failed', 'missing failure outcome')
    if (cp.status === 'recoverable') {
      requireInvariant(false, 'recoverable requires failure outcome')
    }
  }

  if (cp.status === 'ready') {
    requireInvariant(cp.haltReason === null, 'ready with halt')
    // Pending may retain a prior failure outcome while recovery executes.
    if (!cp.pending) {
      requireInvariant(cp.latestOutcome === null || cp.latestOutcome.kind === 'success', 'ready with failure outcome')
    }
  }
  if (cp.status === 'recoverable') {
    requireInvariant(cp.latestOutcome?.kind === 'failure', 'recoverable without failure outcome')
  }
  if (cp.haltReason === 'interrupted') {
    requireInvariant(cp.pending !== null, 'interrupted halt requires reservation')
  }
  if (cp.haltReason === 'failed') {
    requireInvariant(cp.pending === null, 'fatal failed halt with pending')
    // Fatal failed may have null latestOutcome (unexpected throw) or failure outcome.
    if (cp.latestOutcome?.kind === 'failure') {
      requireInvariant(cp.expectedFailureSeq >= 1, 'fatal domain failure seq')
    } else {
      requireInvariant(cp.expectedFailureSeq === 0 && cp.latestOutcome === null, 'fatal throw shape')
    }
  }

  let latestOutcome: ExecutionSnapshotV2['latestOutcome'] = null
  if (cp.latestOutcome?.kind === 'success') {
    latestOutcome = Object.freeze({
      kind: 'success' as const,
      invocation: Object.freeze({ ...cp.latestOutcome.invocation }),
    })
  } else if (cp.latestOutcome?.kind === 'failure') {
    latestOutcome = Object.freeze({
      kind: 'failure' as const,
      invocation: Object.freeze({ ...cp.latestOutcome.invocation }),
      failure: Object.freeze({ ...cp.latestOutcome.failure }),
    })
  }

  return deepFreeze({
    ...cp,
    failedNodes: [...cp.failedNodes],
    lastGood: { ...cp.lastGood, state },
    latestOutcome,
  })
}
