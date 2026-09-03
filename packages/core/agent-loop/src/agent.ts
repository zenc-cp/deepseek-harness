/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'
import {
  TURN_STEP_STATE_VERSION,
  applyPreStepDecision,
  applyRequestError,
  applyStepOutcome,
  applyTurnStepFailure,
  checkpointAfterNode,
  evolveTurnStepState,
  freezeTurnStepState,
  recordNodeVisit,
  resumeTurnStep,
  routeClaimed,
  routeFailure,
  routeRequestError,
  traceAfterNode,
  validateTurnStepGraph,
  type TurnStepCheckpoint,
  type TurnStepState,
  type TurnStepTraceEntry,
} from './turn-step-state.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
  }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Surface generation of the preceding built request. */
  private requestSurfaceGeneration: number | undefined
  private readonly runtimeContext: RuntimeContextProjection
  /** In-memory last-good graph checkpoint. Not session-checkpoint-policy. */
  private heldNodeCheckpoint: TurnStepCheckpoint | null = null
  /** In-memory completed declared-node path for this kick. */
  private heldNodeTrace: TurnStepTraceEntry[] = []

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Last-good node checkpoint for this driver, or null before the first node. */
  get lastNodeCheckpoint(): TurnStepCheckpoint | null {
    return this.heldNodeCheckpoint
  }

  /** Frozen completed declared-node path for the current kick. */
  get nodeTrace(): readonly TurnStepTraceEntry[] {
    return Object.freeze([...this.heldNodeTrace])
  }

  /** Publish last-good checkpoint and its matching path entry together. */
  private publishNode(checkpoint: TurnStepCheckpoint, startedAt: number, finishedAt: number): void {
    const entry = traceAfterNode(checkpoint, startedAt, finishedAt)
    this.heldNodeCheckpoint = checkpoint
    this.heldNodeTrace.push(entry)
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      validateTurnStepGraph()
      this.heldNodeCheckpoint = null
      this.heldNodeTrace = []
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /**
   * Frozen turn/step snapshot after inbox claim, before the pre-step decision
   * is written. Live AbortController and PromptAssembly stay off State.
   */
  private captureTurnStepState(turn: number, step: number, claimTarget: InboxTarget): TurnStepState {
    /* v8 ignore next -- turn() establishes the running phase before capture */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": turn/step State capture outside running phase`)
    const phase = this.phase
    return freezeTurnStepState({
      schemaVersion: TURN_STEP_STATE_VERSION,
      sessionId: this.session.id,
      turn,
      step,
      phaseKind: 'running',
      wakeRequested: phase.wakeRequested,
      abortCause: null,
      claimTarget,
      inbox: {
        nextTurn: [...this.inbox.nextTurn],
        nextStep: [...this.inbox.nextStep],
      },
      claimed: [],
      preStep: 'pending',
      startsRequestSeries: false,
      requestError: 'none',
      stepEnd: null,
      turnEnd: null,
      route: {
        provider: this.options.provider ?? '',
        model: this.options.model ?? '',
      },
      surfaceGeneration: this.requestSurfaceGeneration ?? null,
      requestHeaderLogged: this.requestHeaderLogged,
      failure: null,
      visits: { 'apply-pre-step': 0, 'apply-step-outcome': 0 },
    })
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    let priorVisits: TurnStepState['visits'] = { 'apply-pre-step': 0, 'apply-step-outcome': 0 }
    try {
      stepLoop: while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        const startedAt = Date.now()
        const counted = recordNodeVisit(
          evolveTurnStepState(this.captureTurnStepState(turn, step, target), {
            visits: priorVisits,
            turnEnd: turnEnds,
          }),
          'apply-pre-step',
        )
        const state = applyPreStepDecision(counted, decision)
        const checkpoint = checkpointAfterNode(state, 'apply-pre-step')
        this.publishNode(checkpoint, startedAt, Date.now())
        priorVisits = state.visits
        const resumed = resumeTurnStep(checkpoint)
        switch (resumed.route) {
          case 'block-turn':
            turnEnds = { kind: 'blocked' }
            return false
          case 'enter-step':
            break
          /* v8 ignore next -- closed-union exhaustiveness guard */
          default:
            assertNever(resumed.route, 'pre-step router')
        }
        /* v8 ignore next -- applyPreStepDecision copies decision.kind onto preStep */
        if (decision.kind === 'reject') this.throwError(new Error(`agent "${this.id}": pre-step State diverged from decision`))
        switch (routeClaimed(state)) {
          case 'enter-step':
            break
          case 'complete-turn':
            turnEnds = { kind: 'completed' }
            return false
          case 'preserve-turn-end':
            break stepLoop
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        let stepEnd: StepEndReason | null
        try {
          for (const message of state.claimed) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          stepEnd = await this.step(decision.assembly, state.startsRequestSeries)
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        const snapshotInbox = (): TurnStepState['inbox'] => ({
          nextTurn: [...this.inbox.nextTurn],
          nextStep: [...this.inbox.nextStep],
        })
        let inbox = snapshotInbox()
        if (applyStepOutcome(state, stepEnd, inbox).turnEnd && inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
          inbox = snapshotInbox()
        }
        const outcomeStartedAt = Date.now()
        const projected = applyStepOutcome(state, stepEnd, inbox)
        const outcomeState = recordNodeVisit(
          evolveTurnStepState(projected, { visits: priorVisits }),
          'apply-step-outcome',
        )
        const outcomeCheckpoint = checkpointAfterNode(outcomeState, 'apply-step-outcome')
        this.publishNode(outcomeCheckpoint, outcomeStartedAt, Date.now())
        priorVisits = outcomeState.visits
        const outcomeResume = resumeTurnStep(outcomeCheckpoint)
        switch (outcomeResume.route) {
          case 'finish-turn':
            turnEnds = outcomeState.turnEnd
            break stepLoop
          case 'next-pre-step':
            turnEnds = outcomeState.turnEnd
            target = 'next-step'
            break
          /* v8 ignore next -- checkpoint node selects the step-outcome router */
          default:
            assertNever(outcomeResume.route, 'step-outcome router')
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      const structured = error instanceof LlmError
        ? error.failure
        : { message: errorChain(error), code: 'UNKNOWN' }
      turnEnds = { kind: 'error', error: structured }
      if (this.heldNodeCheckpoint) {
        const failed = applyTurnStepFailure(this.heldNodeCheckpoint.state, {
          message: structured.message,
          code: structured.code,
        })
        switch (routeFailure(failed)) {
          case 'stop-turn':
            this.throwError(error)
          case 'continue':
            /* v8 ignore next -- catch writes non-null failure */
            this.throwError(new Error(`agent "${this.id}": failure router continued after a catch`))
        }
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly, startsRequestSeries: boolean): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      const surfaceGeneration = this.session.surface.replaceGeneration
      const { request, preparedCall } = await this.buildRequest(
        turn,
        step,
        assembly.tools,
        system,
        this.session.deriveMessages(),
        startsRequestSeries,
        surfaceGeneration,
        signal,
      )
      startsRequestSeries = false
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        for await (const chunk of stream) {
          signal.throwIfAborted()
          chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model },
              }),
              interrupted: true,
              ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
          }
        }
        throw error
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const action = await this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        const kind = action?.kind === 'retry' ? 'retry' : 'throw'
        if (this.heldNodeCheckpoint) {
          const recovered = applyRequestError(this.heldNodeCheckpoint.state, kind)
          switch (routeRequestError(recovered)) {
            case 'retry':
              continue
            case 'throw':
              throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
        }
        /* v8 ignore start -- enter-step always checkpoints before step() */
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
        /* v8 ignore stop */
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded, failure } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      if (failure != null) {
        const structured = failure instanceof LlmError
          ? failure.failure
          : { message: errorChain(failure), code: 'UNKNOWN' }
        if (this.heldNodeCheckpoint) {
          const failed = applyTurnStepFailure(this.heldNodeCheckpoint.state, {
            message: structured.message,
            code: structured.code,
          })
          switch (routeFailure(failed)) {
            case 'stop-turn':
              throw failure
            case 'continue':
              /* v8 ignore next -- scheduler failure writes non-null facts */
              this.throwError(new Error(`agent "${this.id}": failure router continued after a scheduler failure`))
          }
        }
        /* v8 ignore next -- enter-step always checkpoints before step() */
        throw failure
      }
      return concluded ? { kind: 'completed' } : null
    }
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    boundaryMessages: Message[],
    startsRequestSeries: boolean,
    surfaceGeneration: number,
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const persistedReasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      })
    } else if (startsSeries) {
      this.session.append('request/header', { header, reason: 'series' })
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: boundaryMessages,
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
