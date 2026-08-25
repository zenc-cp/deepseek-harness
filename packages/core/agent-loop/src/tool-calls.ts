/**
 * Schedules one assistant step's tool calls. Exclusive calls form barriers;
 * parallel calls use a bounded rolling pool and are reclassified before start.
 * Dispatch may overlap, while policy, results, and result context remain
 * model-ordered. Abort or an internal scheduler failure stops replenishment
 * and drains started calls.
 *
 * Abort records synthetic error results for skipped calls so replay stays
 * valid. A terminal scheduler failure preserves already-recorded `tool/call`
 * events without fabricating results.
 * @module dsh-agent-loop/tool-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever, createToolResultMessage, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_RUNTIME_SCHEDULER, type ToolExecutionInput, type ToolExecutionMode, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'

/** One tool call after argument parsing, ready to schedule. */
interface PlannedCall {
  block: ToolCallBlock
  exec: ToolExecutionInput
  /** Pre-recorded in model order when scheduling must dispatch out of order. */
  callSeq?: number
}

/** Settled dispatch awaiting model-order finalization. */
interface Slot {
  exec: ToolRunContext
  result: ToolExecutionResult
  needsPost: boolean
}

/** Finalized result waiting for durable model-order publication. */
interface PendingCommit {
  call: PlannedCall
  result: ToolExecutionResult
  callSeq: number
}

/** One scheduler group outcome, including a drained cancellation. */
interface GroupOutcome {
  consumed: number
  aborted: boolean
  /** Whether any committed result carried {@link ToolExecutionResult.concludesTurn}. */
  concluded: boolean
}

/**
 * Schedule one assistant step's tool calls by their live concurrency mode.
 * Ordinary completion and abort commit started-call results in order. Abort
 * drains them, records synthetic results for unstarted calls, and returns with
 * the signal still aborted after accepting started-call context through the
 * caller-supplied acceptor (the machine stages it in its next-step inbox for the
 * step boundary). An internal scheduler failure stops new dispatches, drains
 * already-started dispatches, and rejects with the first failure without
 * fabricating tool results.
 * The committed step's AgentLoop driver boundary supplies the initiating Agent
 * that becomes each explicit {@link ToolExecutionInput.agent}.
 *
 * @param ctx - loop context that owns the tool registry and carries the initiating Agent.
 * @param turn - current turn number.
 * @param step - current step number.
 * @param toolCalls - assistant calls in model order.
 * @param signal - abort signal shared by the step.
 * @param acceptContext - accepts committed result context for the next step boundary.
 */
export async function executeToolCalls(
  ctx: Context,
  turn: number,
  step: number,
  toolCalls: ToolCallBlock[],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const { session } = agent

  // Inputs are distinct because tools/execute wrappers may replace `exec.signal`.
  const planned: PlannedCall[] = toolCalls.map(block => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      agent,
      signal,
    },
  }))
  const ordered = orderScheduledCalls(ctx, planned)
  const reordered = ordered.some((call, index) => call !== planned[index])
  if (reordered) {
    // Dispatch order may differ, but the durable call projection preserves the
    // model's tool-call order so reconstructed requests remain protocol-valid.
    for (const call of planned) call.callSeq = appendToolCall(session, turn, step, call.block)
  }
  const pendingCommits = reordered ? new Map<PlannedCall, PendingCommit>() : undefined

  let next = 0
  let concluded = false
  while (next < ordered.length) {
    // Commit before classifying again so registry changes affect unstarted calls.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const first = ordered[next]!
    const firstMode = ctx.tools.executionMode(first.exec)
    const mode = firstMode.kind
    const tail = ordered.slice(next)
    const boundary = mode === 'parallel'
      ? tail.findIndex(call => ctx.tools.executionMode(call.exec).schedule !== firstMode.schedule)
      : 1
    const group = mode === 'parallel' && boundary < 0 ? tail : tail.slice(0, boundary)
    const outcome = await runGroup(
      ctx, turn, step, group, mode, signal, acceptContext, pendingCommits,
    )
    next += outcome.consumed
    concluded ||= outcome.concluded
    if (outcome.aborted) {
      for (const call of ordered.slice(next)) recordSkippedToolCall(session, turn, step, call, pendingCommits)
      concluded ||= publishPendingCommits(session, turn, step, planned, pendingCommits, acceptContext)
      return { concluded }
    }
  }
  concluded ||= publishPendingCommits(session, turn, step, planned, pendingCommits, acceptContext)
  return { concluded }
}

/** Stable partition: ordinary calls first, then tools explicitly deferred to the batch tail. */
function orderScheduledCalls(ctx: Context, planned: PlannedCall[]): PlannedCall[] {
  const ordinary: PlannedCall[] = []
  const afterBatch: PlannedCall[] = []
  for (const call of planned) {
    const target = ctx.tools.executionMode(call.exec).schedule === 'after-batch' ? afterBatch : ordinary
    target.push(call)
  }
  return [...ordinary, ...afterBatch]
}

/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}

/**
 * Run one exclusive barrier or parallel pool. Later calls are reclassified
 * before start; an exclusive reclassification waits for the current pool to
 * drain and remains for the caller's next barrier. Results and contexts commit
 * in model order. Abort stops starts, drains and commits started calls, accepts
 * their contexts into the owning batch, records results for skipped calls, and
 * returns an aborted outcome. Scheduler failure drains dispatches without
 * committing synthetic recovery results.
 */
async function runGroup(
  ctx: Context,
  turn: number,
  step: number,
  group: PlannedCall[],
  mode: ToolExecutionMode['kind'],
  signal: AbortSignal,
  acceptContext: (context: UserMessage) => void,
  pendingCommits?: Map<PlannedCall, PendingCommit>,
): Promise<GroupOutcome> {
  const { session } = ctx.agents.requireInitiator()
  const { maxParallelToolCalls } = ctx.agentLoop.config
  const slots: (Slot | undefined)[] = group.map(() => undefined)
  // Started slots retain their `tool/call` seq so the result can cite it.
  const callSeqs: number[] = group.map(() => -1)
  let nextToStart = 0
  let committed = 0
  let started = 0
  let aborted: boolean = signal.aborted
  let concluded = false
  let schedulerFailure: { error: unknown } | undefined
  const throwSchedulerFailure = (): void => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error
  }

  // `committed` advances only across contiguous model-order slots.
  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = group[committed]
      const result = slot.needsPost
        ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
        : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
      const pending = { call: call!, result, callSeq: callSeqs[committed]! }
      if (pendingCommits === undefined) {
        publishToolResult(session, turn, step, pending, acceptContext)
        concluded ||= result.concludesTurn === true
      } else {
        pendingCommits.set(pending.call, pending)
      }
      committed++
    }
  }

  const inFlight = new Map<number, Promise<number>>()

  const startCall = async (index: number): Promise<void> => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded index
    const call = group[index]!
    callSeqs[index] = call.callSeq ?? appendToolCall(session, turn, step, call.block)
    started++
    const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
    throwSchedulerFailure()
    switch (prepared.kind) {
      case 'dispatch': {
        const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then(
          (outcome) => {
            slots[index] = { exec: prepared.exec, result: outcome.result, needsPost: outcome.kind === 'post-result' }
            return index
          },
          (error: unknown) => {
            schedulerFailure ??= { error }
            return index
          },
        )
        inFlight.set(index, promise)
        break
      }
      case 'post-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: true }
        break
      case 'final-result':
        slots[index] = { exec: prepared.exec, result: prepared.result, needsPost: false }
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(prepared, 'tool-call scheduler prepare result')
    }
  }

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      // Re-read later modes after ordered commits so registry changes can create a barrier.
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const nextCall = group[nextToStart]!
      if (nextToStart > 0 && mode === 'parallel'
        && ctx.tools.executionMode(nextCall.exec).kind !== 'parallel') break
      await startCall(nextToStart)
      nextToStart++
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // Abort may arrive while pre-execute awaits.
      if (signal.aborted) aborted = true
    }
  }

  // Ordered pre-execute may await; only dispatch/body overlaps. A scheduler
  // failure stops new dispatches and reaches the turn boundary after every
  // already-started dispatch settles.
  try {
    await fillPool()
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      throwSchedulerFailure()
      await commitReady()
      throwSchedulerFailure()
      // Abort may arrive while a tool or ordered commit awaits.

      if (signal.aborted) aborted = true
      await fillPool()
    }
  } catch (error: unknown) {
    schedulerFailure ??= { error }
    await Promise.allSettled(inFlight.values())
    throw schedulerFailure.error
  }

  if (aborted) {
    // Started calls and accepted context settle first; every remaining model
    // call then receives an ordered synthetic result before the turn aborts.
    for (const call of group.slice(started)) recordSkippedToolCall(session, turn, step, call, pendingCommits)
    return { consumed: group.length, aborted: true, concluded }
  }
  /* v8 ignore next -- unreachable: a non-aborted group commits every started call */
  if (committed !== started) throw new Error('tool-call scheduler: uncommitted settled calls')
  return { consumed: started, aborted: false, concluded }
}

/** Record or append the synthetic result for a model call skipped after cancellation. */
function recordSkippedToolCall(
  session: Session,
  turn: number,
  step: number,
  call: PlannedCall,
  pendingCommits?: Map<PlannedCall, PendingCommit>,
): void {
  const result: ToolExecutionResult = {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }
  const callSeq = call.callSeq ?? appendToolCall(session, turn, step, call.block)
  if (pendingCommits === undefined) {
    appendToolResult(session, turn, step, call.block, result, callSeq)
  } else {
    pendingCommits.set(call, { call, result, callSeq })
  }
}

/** Publish a reordered batch in original model order and report a terminal result. */
function publishPendingCommits(
  session: Session,
  turn: number,
  step: number,
  planned: PlannedCall[],
  pendingCommits: Map<PlannedCall, PendingCommit> | undefined,
  acceptContext: (context: UserMessage) => void,
): boolean {
  if (pendingCommits === undefined) return false
  let concluded = false
  for (const call of planned) {
    const pending = pendingCommits.get(call)
    /* v8 ignore next -- every reordered call is finalized or receives a synthetic abort result. */
    if (pending === undefined) throw new Error('tool-call scheduler: missing reordered result')
    publishToolResult(session, turn, step, pending, acceptContext)
    concluded ||= pending.result.concludesTurn === true
  }
  return concluded
}

/** Append a started call and return the event seq that its result must cite. */
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): number {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}

/** Publish one finalized result and its contexts at the durable model-order boundary. */
function publishToolResult(
  session: Session,
  turn: number,
  step: number,
  pending: PendingCommit,
  acceptContext: (context: UserMessage) => void,
): void {
  appendToolResult(session, turn, step, pending.call.block, pending.result, pending.callSeq)
  for (const context of pending.result.additionalContexts ?? []) acceptContext(context)
}

/** Append a model-ordered result linked to its call event. */
function appendToolResult(
  session: Session,
  turn: number,
  step: number,
  block: ToolCallBlock,
  result: ToolExecutionResult,
  callSeq: number,
): void {
  const message = createToolResultMessage({
    callId: block.id,
    content: result.content,
    isError: result.isError,
  })
  session.append('tool/result', {
    turn, step,
    message,
    ...result.error?.info ? { error: result.error.info } : {},
    // The tool's private presentation payload (e.g. a result-time diff),
    // persisted so a UI bridge reproduces the card on replay.
    ...result.meta !== undefined ? { meta: result.meta } : {},
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}
