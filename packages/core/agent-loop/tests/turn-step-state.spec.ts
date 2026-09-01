import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  TURN_STEP_STATE_VERSION,
  TurnStepStateInvalidError,
  TurnStepStateVersionError,
  PRE_STEP_ROUTER_TARGETS,
  TURN_STEP_VISIT_CAPS,
  TurnStepVisitCapError,
  applyPreStepDecision,
  evolveTurnStepState,
  freezeTurnStepState,
  parseTurnStepState,
  recordNodeVisit,
  routePreStep,
  type TurnStepState,
} from '../src/turn-step-state.ts'

function sampleState(overrides: Record<string, unknown> = {}): TurnStepState {
  return {
    schemaVersion: TURN_STEP_STATE_VERSION,
    sessionId: SessionId('turn-step-state-test'),
    turn: 1,
    step: 1,
    phaseKind: 'running',
    wakeRequested: false,
    abortCause: null,
    claimTarget: 'next-turn',
    inbox: {
      nextTurn: [createUserMessage({
        content: [{ type: 'text', text: 'pending' }],
        source: { kind: 'user' },
      })],
      nextStep: [],
    },
    claimed: [createUserMessage({
      content: [{ type: 'text', text: 'claimed' }],
      source: { kind: 'user' },
    })],
    preStep: 'enter',
    startsRequestSeries: false,
    requestError: 'none',
    stepEnd: null,
    turnEnd: null,
    route: { provider: 'mock', model: 'm' },
    surfaceGeneration: 0,
    requestHeaderLogged: true,
    failure: null,
    visits: { 'apply-pre-step': 0 },
    ...overrides,
  } as TurnStepState
}

function jsonOf(state: TurnStepState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>
}

describe('turn/step State schema', () => {
  it('freezes a v1 snapshot so nested inbox messages cannot be mutated', () => {
    const frozen = freezeTurnStepState(sampleState())
    expect(frozen.schemaVersion).toBe(1)
    expect(() => {
      (frozen as { turn: number }).turn = 9
    }).toThrow(TypeError)
    expect(() => {
      (frozen.inbox.nextTurn as unknown[]).push({})
    }).toThrow(TypeError)
    expect(() => {
      (frozen.claimed[0] as { role: string }).role = 'assistant'
    }).toThrow(TypeError)
  })

  it('evolves a new frozen object and leaves the input JSON unchanged', () => {
    const frozen = freezeTurnStepState(sampleState())
    const before = JSON.stringify(frozen)
    const next = evolveTurnStepState(frozen, { step: 2, preStep: 'pending' })
    expect(next).not.toBe(frozen)
    expect(next.step).toBe(2)
    expect(next.preStep).toBe('pending')
    expect(frozen.step).toBe(1)
    expect(frozen.preStep).toBe('enter')
    expect(JSON.stringify(frozen)).toBe(before)
    expect(() => {
      (next as { turn: number }).turn = 3
    }).toThrow(TypeError)
  })

  it('parses a v1 golden fixture after JSON roundtrip', () => {
    const frozen = freezeTurnStepState(sampleState({
      abortCause: { kind: 'hook', reason: 'stop' },
      stepEnd: { kind: 'max-tokens' },
      turnEnd: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } },
      failure: { message: 'boom', code: 'UNKNOWN' },
      surfaceGeneration: null,
    }))
    const parsed = parseTurnStepState(jsonOf(frozen))
    expect(parsed).toEqual(frozen)
    expect(parsed).not.toBe(frozen)
  })

  it('throws TurnStepStateVersionError for missing version, 0, 2, or a non-object', () => {
    const golden = jsonOf(freezeTurnStepState(sampleState()))

    const missing = { ...golden }
    delete missing.schemaVersion
    const missingError = (() => {
      try {
        parseTurnStepState(missing)
      } catch (error) {
        return error
      }
    })()
    expect(missingError).toBeInstanceOf(TurnStepStateVersionError)
    expect(missingError).toMatchObject({ expected: 1, found: undefined })

    const zero = parseThrow({ ...golden, schemaVersion: 0 })
    expect(zero).toBeInstanceOf(TurnStepStateVersionError)
    expect(zero).toMatchObject({ expected: 1, found: 0 })

    const two = parseThrow({ ...golden, schemaVersion: 2 })
    expect(two).toBeInstanceOf(TurnStepStateVersionError)
    expect(two).toMatchObject({ expected: 1, found: 2 })

    const none = parseThrow(null)
    expect(none).toBeInstanceOf(TurnStepStateVersionError)
    expect(none).toMatchObject({ expected: 1, found: null })

    expect(parseThrow([])).toMatchObject({ expected: 1, found: [] })
    expect(parseThrow(0)).toMatchObject({ expected: 1, found: 0 })
  })

  it('rejects functions and AbortSignal before freeze', () => {
    expect(() => freezeTurnStepState(sampleState({ failure: () => 'nope' })))
      .toThrow(TurnStepStateInvalidError)
    expect(() => freezeTurnStepState(sampleState({ abortCause: AbortSignal.abort() })))
      .toThrow(TurnStepStateInvalidError)
  })

  it('rejects unknown keys, enum values, and turn-end kinds', () => {
    const golden = jsonOf(freezeTurnStepState(sampleState()))
    const invalid: unknown[] = [
      { ...golden, extra: true },
      { ...golden, visits: { 'apply-pre-step': 0, extra: 1 } },
      { ...golden, visits: { 'apply-pre-step': -1 } },
      { ...golden, visits: {} },
      { ...golden, visits: [] },
      { ...golden, phaseKind: 'sleeping' },
      { ...golden, turnEnd: { kind: 'plugin-custom' } },
      { ...golden, sessionId: '' },
      { ...golden, turn: -1 },
      { ...golden, wakeRequested: 'yes' },
      { ...golden, claimTarget: 'inbox' },
      { ...golden, preStep: 'skip' },
      { ...golden, requestError: 'ignore' },
      { ...golden, inbox: [] },
      { ...golden, claimed: { id: 'x' } },
      { ...golden, route: { provider: 1, model: 'm' } },
      { ...golden, surfaceGeneration: 1.5 },
      { ...golden, abortCause: { kind: 'other' } },
      { ...golden, abortCause: { kind: 'hook' } },
      { ...golden, stepEnd: { kind: 'blocked' } },
      { ...golden, turnEnd: { kind: 'aborted', reason: null } },
      { ...golden, turnEnd: { kind: 'error', error: { message: 'x' } } },
      { ...golden, turnEnd: { kind: 'error', error: { message: 'x', code: 'Y', extra: true } } },
      { ...golden, turnEnd: { kind: 'error', error: { message: 'x', code: 'Y', status: 1.5 } } },
      { ...golden, turnEnd: { kind: 'error', error: { message: 'x', code: 'Y', providerRetryAfterMs: 1.5 } } },
      { ...golden, turnEnd: { kind: 'error', error: { message: 'x', code: 'Y', requestId: '' } } },
      { ...golden, failure: { message: 'x', code: '' } },
      { ...golden, failure: 'nope' },
      { ...golden, requestHeaderLogged: 1 },
      {
        ...golden,
        claimed: [{ id: 'm1', role: 'user', content: [], source: [] }],
      },
      {
        ...golden,
        claimed: [{ id: 'm1', role: 'assistant', content: [], source: { kind: 'user' } }],
      },
      {
        ...golden,
        claimed: [{ id: 'm1', role: 'user', content: 'hi', source: { kind: 'user' } }],
      },
    ]
    for (const value of invalid) {
      expect(() => parseTurnStepState(value), JSON.stringify(value)).toThrow(TurnStepStateInvalidError)
    }
  })

  it('accepts each core turnEnd kind and remaining v1 enums', () => {
    const frozen = freezeTurnStepState(sampleState({
      phaseKind: 'idle',
      claimTarget: 'next-step',
      inbox: {
        nextTurn: [],
        nextStep: [createUserMessage({
          content: [{ type: 'text', text: 'steer' }],
          source: { kind: 'user' },
        })],
      },
      claimed: [],
      preStep: 'reject',
      requestError: 'retry',
      stepEnd: { kind: 'completed' },
      abortCause: { kind: 'user' },
    }))
    expect(frozen.phaseKind).toBe('idle')
    expect(frozen.preStep).toBe('reject')
    expect(frozen.stepEnd).toEqual({ kind: 'completed' })

    const kinds = [
      { kind: 'completed' },
      { kind: 'blocked' },
      { kind: 'max-tokens' },
      { kind: 'interrupted' },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'aborted', reason: { kind: 'parent' } },
      { kind: 'aborted', reason: { kind: 'disposed' } },
      { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } },
      { kind: 'error', error: { message: 'x', code: 'Y', status: 429 } },
      { kind: 'error', error: { message: 'x', code: 'Y', providerRetryAfterMs: 10 } },
      { kind: 'error', error: { message: 'x', code: 'Y', requestId: 'req-1' } },
    ]
    for (const turnEnd of kinds) {
      expect(evolveTurnStepState(frozen, { turnEnd }).turnEnd).toEqual(turnEnd)
    }

    expect(evolveTurnStepState(frozen, {
      phaseKind: 'maintenance',
      requestError: 'throw',
      abortCause: { kind: 'parent' },
    }).phaseKind).toBe('maintenance')
  })

  it('applyPreStepDecision writes enter/reject onto the same frozen State type', () => {
    const pending = freezeTurnStepState(sampleState({
      preStep: 'pending',
      claimed: [],
      startsRequestSeries: false,
    }))
    const entered = applyPreStepDecision(pending, {
      kind: 'enter',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user' },
      })],
      startsRequestSeries: true,
    })
    expect(entered.preStep).toBe('enter')
    expect(entered.startsRequestSeries).toBe(true)
    expect(entered.claimed).toHaveLength(1)
    expect(entered.claimed[0]?.content).toEqual([{ type: 'text', text: 'go' }])
    expect(pending.preStep).toBe('pending')
    expect(pending.claimed).toEqual([])

    const enteredPlain = applyPreStepDecision(pending, {
      kind: 'enter',
      messages: [],
    })
    expect(enteredPlain.startsRequestSeries).toBe(false)
    expect(enteredPlain.claimed).toEqual([])

    const rejected = applyPreStepDecision(entered, { kind: 'reject' })
    expect(rejected.preStep).toBe('reject')
    expect(rejected.claimed).toEqual([])
    expect(rejected.startsRequestSeries).toBe(false)
    expect(entered.preStep).toBe('enter')
  })

  it('routePreStep is a declared router with explicit targets, not a buried if', () => {
    expect(PRE_STEP_ROUTER_TARGETS).toEqual(['block-turn', 'enter-step'])

    const pending = freezeTurnStepState(sampleState({
      preStep: 'pending',
      claimed: [],
      startsRequestSeries: false,
    }))
    expect(() => routePreStep(pending)).toThrow(TurnStepStateInvalidError)
    expect(() => routePreStep(pending)).toThrow(/preStep is pending/)

    const rejected = applyPreStepDecision(pending, { kind: 'reject' })
    expect(routePreStep(rejected)).toBe('block-turn')

    const entered = applyPreStepDecision(pending, {
      kind: 'enter',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user' },
      })],
      startsRequestSeries: true,
    })
    expect(routePreStep(entered)).toBe('enter-step')
  })

  it('recordNodeVisit caps apply-pre-step and carries counts across a fresh snapshot', () => {
    expect(TURN_STEP_VISIT_CAPS).toEqual({ 'apply-pre-step': 256 })

    const zero = freezeTurnStepState(sampleState({
      visits: { 'apply-pre-step': 0 },
    }))
    const one = recordNodeVisit(zero, 'apply-pre-step')
    expect(one.visits['apply-pre-step']).toBe(1)
    expect(one).not.toBe(zero)
    expect(zero.visits['apply-pre-step']).toBe(0)

    const two = recordNodeVisit(one, 'apply-pre-step')
    expect(two.visits['apply-pre-step']).toBe(2)

    const fresh = freezeTurnStepState(sampleState({
      visits: { 'apply-pre-step': 0 },
      step: 2,
    }))
    const carried = recordNodeVisit(
      evolveTurnStepState(fresh, { visits: two.visits }),
      'apply-pre-step',
    )
    expect(carried.visits['apply-pre-step']).toBe(3)
    expect(carried.step).toBe(2)
    expect(fresh.visits['apply-pre-step']).toBe(0)

    const atCap = freezeTurnStepState(sampleState({
      visits: { 'apply-pre-step': 256 },
    }))
    const overflow = (() => {
      try {
        recordNodeVisit(atCap, 'apply-pre-step')
      } catch (error) {
        return error
      }
    })()
    expect(overflow).toBeInstanceOf(TurnStepVisitCapError)
    expect(overflow).toMatchObject({ node: 'apply-pre-step', cap: 256, found: 257 })
    expect(atCap.visits['apply-pre-step']).toBe(256)
  })
})

function parseThrow(value: unknown): unknown {
  try {
    parseTurnStepState(value)
    return undefined
  } catch (error) {
    return error
  }
}
