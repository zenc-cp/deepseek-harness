import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import {
  TURN_STEP_STATE_VERSION,
  TurnStepStateInvalidError,
  TurnStepStateVersionError,
  applyPreStepDecision,
  checkpointAfterNode,
  freezeTurnStepState,
  resumeTurnStep,
} from '../src/turn-step-state.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const persistence = {
    prepare(id: SessionId) {
      const meta: SessionHeader = {
        version: SESSION_FORMAT_VERSION,
        id,
        createdAt: 1,
      }
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      return Promise.resolve(SessionPreparation.create(ctx.sessions.prepare(id, {
        seed,
        meta,
        seedSource: 'persistence',
      })))
    },
  }
  ctx.provide('sessionPersistence', persistence)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function graphCheckpointJson(sessionId: SessionId) {
  return JSON.parse(JSON.stringify(checkpointAfterNode(freezeTurnStepState({
    schemaVersion: TURN_STEP_STATE_VERSION,
    sessionId,
    turn: 1,
    step: 1,
    phaseKind: 'idle',
    wakeRequested: false,
    abortCause: null,
    claimTarget: 'next-turn',
    inbox: { nextTurn: [], nextStep: [] },
    claimed: [],
    preStep: 'enter',
    startsRequestSeries: true,
    requestError: 'none',
    stepEnd: { kind: 'completed' },
    stepOutcome: null,
    turnEnd: { kind: 'completed' },
    route: { provider: 'mock', model: 'mock' },
    surfaceGeneration: 0,
    requestHeaderLogged: true,
    failure: null,
    visits: { 'apply-pre-step': 1, step: 0, 'apply-step-outcome': 0 },
  }), 'apply-pre-step')))
}

/** An apply-pre-step checkpoint from inside a running turn, at turn 1 step 1. */
function inFlightEnterStepSeed(sessionId: SessionId) {
  const state = applyPreStepDecision(freezeTurnStepState({
    schemaVersion: TURN_STEP_STATE_VERSION,
    sessionId,
    turn: 1,
    step: 1,
    phaseKind: 'running',
    wakeRequested: false,
    abortCause: null,
    claimTarget: 'next-turn',
    inbox: { nextTurn: [], nextStep: [] },
    claimed: [],
    preStep: 'pending',
    startsRequestSeries: true,
    requestError: 'none',
    stepEnd: null,
    stepOutcome: null,
    turnEnd: null,
    route: { provider: 'mock', model: 'mock' },
    surfaceGeneration: 0,
    requestHeaderLogged: true,
    failure: null,
    visits: { 'apply-pre-step': 1, step: 0, 'apply-step-outcome': 0 },
  }), { kind: 'enter', messages: [] })
  return JSON.parse(JSON.stringify(checkpointAfterNode(state, 'apply-pre-step')))
}

describe('agents.resume graph-checkpoint seed', () => {
  it('rejects a version-mismatched turnStepCheckpoint before publishing', async () => {
    const sessionId = SessionId('graph-seed-version')
    const ctx = await harness(new MockAdapter([]))
    const published: string[] = []
    ctx.on('agent/created', () => void published.push('agent/created'))
    const seed = graphCheckpointJson(sessionId)
    seed.schemaVersion = 1

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      turnStepCheckpoint: seed,
    })).rejects.toBeInstanceOf(TurnStepStateVersionError)
    expect(published).toEqual([])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('rejects an invalid turnStepCheckpoint before publishing', async () => {
    const sessionId = SessionId('graph-seed-invalid')
    const ctx = await harness(new MockAdapter([]))
    const published: string[] = []
    ctx.on('agent/created', () => void published.push('agent/created'))

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      turnStepCheckpoint: { ...graphCheckpointJson(sessionId), extra: true },
    })).rejects.toBeInstanceOf(TurnStepStateInvalidError)
    expect(published).toEqual([])

    await expect(ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      turnStepCheckpoint: { ...graphCheckpointJson(sessionId), node: 'nope' },
    })).rejects.toBeInstanceOf(TurnStepStateInvalidError)
    expect(published).toEqual([])
    await ctx.fiber.dispose()
  })

  it('holds a valid remount seed until the next node publishes, without skipping preStep', async () => {
    const sessionId = SessionId('graph-seed-hold')
    const ctx = await harness(new MockAdapter([textResponse('next')]))
    const seed = graphCheckpointJson(sessionId)
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      turnStepCheckpoint: seed,
    })
    const loop = handle.agent as ReactLoopAgent
    expect(loop.lastNodeCheckpoint?.node).toBe('apply-pre-step')
    expect(JSON.parse(JSON.stringify(loop.lastNodeCheckpoint))).toEqual(seed)
    expect(loop.nodeTrace).toEqual([])

    const atPreStep: Array<ReactLoopAgent['lastNodeCheckpoint']> = []
    ctx.on('agent/pre-step', async (_payload, next) => {
      atPreStep.push(loop.lastNodeCheckpoint)
      return next()
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'new question' }],
      source: { kind: 'user' },
    }))
    await waitForIdle(ctx, handle.agent)
    expect(atPreStep[0]?.node).toBe('apply-pre-step')
    expect(JSON.parse(JSON.stringify(atPreStep[0]))).toEqual(seed)
    expect(loop.lastNodeCheckpoint).not.toEqual(seed)
    expect(loop.lastNodeCheckpoint?.node).toBe('apply-step-outcome')
    expect(handle.agent.session.deriveMessages().some(message =>
      message.role === 'user' && JSON.stringify(message.content).includes('new question'),
    )).toBe(true)
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  describe('in-flight remount skip', () => {
    it('fails closed with a structured turn end when the restored route requires unfinished step effects', async () => {
      const sessionId = SessionId('flight-unfinished-effects')
      const adapter = new MockAdapter([textResponse('must not run')])
      const ctx = await harness(adapter)
      const seed = inFlightEnterStepSeed(sessionId)
      seed.state.claimTarget = 'next-step'
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        turnStepCheckpoint: seed,
      })
      const turnEnds: unknown[] = []
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/end') turnEnds.push(event.data.reason)
      })
      try {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' },
        }))
        await waitForIdle(ctx, handle.agent)
        expect(turnEnds).toEqual([{
          kind: 'error',
          error: {
            code: 'CHECKPOINT_RESUME_UNSUPPORTED',
            message: 'Cannot resume unfinished step effects from an apply-pre-step checkpoint',
          },
        }])
      } finally {
        await handle.dispose()
        await ctx.fiber.dispose()
      }
    })

    it('remounts a running enter-step seed, skips preStep, and enters the turn at the seed turn number', async () => {
      const sessionId = SessionId('flight-enter-step')
      const ctx = await harness(new MockAdapter([textResponse('next')]))
      const seed = inFlightEnterStepSeed(sessionId)
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        turnStepCheckpoint: seed,
      })
      const preStepFired: boolean[] = []
      ctx.on('agent/pre-step', async (_payload, next) => {
        preStepFired.push(true)
        return next()
      })
      const turnStarts: number[] = []
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/start') turnStarts.push(event.data.turn)
      })

      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue where we left off' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, handle.agent)

      // Turn continues at the in-flight turn number, not a new one.
      expect(turnStarts[0]).toBe(1)
      // preStep is skipped.
      expect(preStepFired).toEqual([])
      // The seed was consumed during the skip; the enter-step route exits early.
      // lastNodeCheckpoint is still the apply-pre-step seed since no step-outcome ran.
      const loop = handle.agent as ReactLoopAgent
      expect(loop.lastNodeCheckpoint?.node).toBe('apply-pre-step')
      expect(loop.lastNodeCheckpoint?.state.turn).toBe(1)
      await handle.dispose()
      await ctx.fiber.dispose()
    })

    it('does not skip preStep when the seed is idle (not running)', async () => {
      const sessionId = SessionId('flight-idle')
      const ctx = await harness(new MockAdapter([textResponse('next')]))
      const seed = graphCheckpointJson(sessionId) // phaseKind: 'idle'
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        turnStepCheckpoint: seed,
      })
      const preStepFired: boolean[] = []
      ctx.on('agent/pre-step', async (_payload, next) => {
        preStepFired.push(true)
        return next()
      })
      const turnStarts: number[] = []
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/start') turnStarts.push(event.data.turn)
      })

      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'fresh question' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, handle.agent)

      expect(preStepFired.length).toBeGreaterThanOrEqual(1)
      // An idle seed means the prior turn completed; the new turn is 2.
      expect(turnStarts[0]).toBe(2)
      await handle.dispose()
      await ctx.fiber.dispose()
    })

    it('stops the turn immediately on a block-turn enter-step seed', async () => {
      const sessionId = SessionId('flight-block')
      const ctx = await harness(new MockAdapter([textResponse('next')]))
      const state = applyPreStepDecision(freezeTurnStepState({
        schemaVersion: TURN_STEP_STATE_VERSION,
        sessionId,
        turn: 3,
        step: 2,
        phaseKind: 'running',
        wakeRequested: false,
        abortCause: null,
        claimTarget: 'next-turn',
        inbox: { nextTurn: [], nextStep: [] },
        claimed: [],
        preStep: 'pending',
        startsRequestSeries: true,
        requestError: 'none',
        stepEnd: null,
        stepOutcome: null,
        turnEnd: null,
        route: { provider: 'mock', model: 'mock' },
        surfaceGeneration: 0,
        requestHeaderLogged: true,
        failure: null,
        visits: { 'apply-pre-step': 1, step: 0, 'apply-step-outcome': 0 },
      }), { kind: 'reject' })
      const seed = JSON.parse(JSON.stringify(checkpointAfterNode(state, 'apply-pre-step')))
      // verify the router says block-turn
      expect(resumeTurnStep(seed).route).toBe('block-turn')

      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        turnStepCheckpoint: seed,
      })
      const preStepFired: boolean[] = []
      ctx.on('agent/pre-step', async (_payload, next) => {
        preStepFired.push(true)
        return next()
      })
      const turnEnds: unknown[] = []
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/end') turnEnds.push(event.data.reason)
      })

      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, handle.agent)

      expect(preStepFired).toEqual([])
      expect(turnEnds).toEqual([{ kind: 'blocked' }])
      await handle.dispose()
      await ctx.fiber.dispose()
    })

    it('does not skip when the seed sessionId does not match the live agent', async () => {
      const sessionId = SessionId('flight-mismatch-session')
      const ctx = await harness(new MockAdapter([textResponse('next')]))
      // Build an in-flight seed for a different session id.
      const seed = inFlightEnterStepSeed(SessionId('other-session'))
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
        turnStepCheckpoint: seed,
      })
      const preStepFired: boolean[] = []
      ctx.on('agent/pre-step', async (_payload, next) => {
        preStepFired.push(true)
        return next()
      })
      const turnStarts: number[] = []
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'turn/start') turnStarts.push(event.data.turn)
      })

      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'question' }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, handle.agent)

      expect(preStepFired.length).toBeGreaterThanOrEqual(1)
      // Session id mismatch: normal path, new turn.
      expect(turnStarts[0]).toBe(2)
      await handle.dispose()
      await ctx.fiber.dispose()
    })

    describe('durable checkpoint', () => {
      it('appends a session/checkpoint-node event at every declared node during a normal turn', async () => {
        const sessionId = SessionId('durable-ckpt')
        const ctx = await harness(new MockAdapter([textResponse('next')]))
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        const checkpoints: Array<{ type: string; data: unknown; ignorable?: true }> = []
        const requiredEvents: SessionEvent[] = []
        ctx.on('session/event', (_session, event) => {
          if (event.type === 'session/checkpoint-node') {
            checkpoints.push(event)
          } else if (event.type !== 'session/trace-node') {
            requiredEvents.push(event)
          }
        })

        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'step' }],
          source: { kind: 'user' },
        }))
        await waitForIdle(ctx, handle.agent)

        // One apply-pre-step checkpoint, one apply-step-outcome checkpoint.
        const nodes = checkpoints.map(c => (c.data as Record<string, unknown>).node)
        expect(nodes).toContain('apply-pre-step')
        expect(nodes).toContain('apply-step-outcome')
        expect(requiredEvents.map(event => event.type)).toEqual(expect.arrayContaining([
          'turn/start', 'turn/end', 'user/message', 'assistant/message',
        ]))
        for (const event of requiredEvents) expect(event).not.toHaveProperty('ignorable')
        // Each carries frozen State.
        for (const c of checkpoints) {
          expect(c.ignorable).toBe(true)
          expect((c.data as Record<string, unknown>).schemaVersion).toBe(TURN_STEP_STATE_VERSION)
        }
        await handle.dispose()
        await ctx.fiber.dispose()
      })

      it('appends a session/trace-node event carrying trace metadata at every declared node', async () => {
        const sessionId = SessionId('durable-trace')
        const ctx = await harness(new MockAdapter([textResponse('next')]))
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        const traces: Array<{ type: string; data: unknown; ignorable?: true }> = []
        ctx.on('session/event', (_session, event) => {
          if (event.type === 'session/trace-node') {
            traces.push(event)
          }
        })

        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'step' }],
          source: { kind: 'user' },
        }))
        await waitForIdle(ctx, handle.agent)

        // Two traces: apply-pre-step and apply-step-outcome.
        const nodes = traces.map(t => (t.data as Record<string, unknown>).node)
        expect(nodes).toContain('apply-pre-step')
        expect(nodes).toContain('apply-step-outcome')
        // Each carries timing and trace metadata.
        for (const t of traces) {
          expect(t.ignorable).toBe(true)
          const d = t.data as Record<string, unknown>
          expect(d.node).toBeTruthy()
          expect(typeof d.startedAt).toBe('number')
          expect(typeof d.durationMs).toBe('number')
          expect(d.durationMs as number).toBeGreaterThanOrEqual(0)
          expect((d.state as Record<string, unknown>).schemaVersion).toBe(TURN_STEP_STATE_VERSION)
        }
        await handle.dispose()
        await ctx.fiber.dispose()
      })
    })
  })
})
