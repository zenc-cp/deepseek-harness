import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_CALL_JOIN_POLICY } from '../src/tool-calls.ts'
import {
  TURN_STEP_STATE_VERSION,
  TurnStepStateInvalidError,
  TurnStepStateVersionError,
  CLAIMED_ROUTER_TARGETS,
  FAILURE_ROUTER_TARGETS,
  PRE_STEP_ROUTER_TARGETS,
  REQUEST_ERROR_ROUTER_TARGETS,
  STEP_OUTCOME_ROUTER_TARGETS,
  TURN_STEP_GRAPH,
  TURN_STEP_NODES,
  TURN_STEP_VISIT_CAPS,
  TurnStepGraphInvalidError,
  TurnStepTraceInvalidError,
  TurnStepVisitCapError,
  applyPreStepDecision,
  applyRequestError,
  applyStepOutcome,
  applyTurnStepFailure,
  checkpointAfterNode,
  evolveTurnStepState,
  freezeTurnStepState,
  parseTurnStepCheckpoint,
  parseTurnStepState,
  recordNodeVisit,
  resumeTurnStep,
  routeClaimed,
  routeFailure,
  routePreStep,
  routeRequestError,
  routeStepOutcome,
  traceAfterNode,
  validateTurnStepGraph,
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
    visits: { 'apply-pre-step': 0, 'apply-step-outcome': 0 },
    ...overrides,
  } as TurnStepState
}

function jsonOf(state: TurnStepState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>
}

describe('turn/step State schema', () => {
  it('freezes a v2 snapshot so nested inbox messages cannot be mutated', () => {
    const frozen = freezeTurnStepState(sampleState())
    expect(frozen.schemaVersion).toBe(2)
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

  it('parses a v2 golden fixture after JSON roundtrip', () => {
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

  it('throws TurnStepStateVersionError for missing version, 0, 1, or a non-object', () => {
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
    expect(missingError).toMatchObject({ expected: 2, found: undefined })

    const zero = parseThrow({ ...golden, schemaVersion: 0 })
    expect(zero).toBeInstanceOf(TurnStepStateVersionError)
    expect(zero).toMatchObject({ expected: 2, found: 0 })

    const one = parseThrow({ ...golden, schemaVersion: 1 })
    expect(one).toBeInstanceOf(TurnStepStateVersionError)
    expect(one).toMatchObject({ expected: 2, found: 1 })

    const none = parseThrow(null)
    expect(none).toBeInstanceOf(TurnStepStateVersionError)
    expect(none).toMatchObject({ expected: 2, found: null })

    expect(parseThrow([])).toMatchObject({ expected: 2, found: [] })
    expect(parseThrow(0)).toMatchObject({ expected: 2, found: 0 })
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
      { ...golden, visits: { 'apply-pre-step': 0, 'apply-step-outcome': 0, extra: 1 } },
      { ...golden, visits: { 'apply-pre-step': -1, 'apply-step-outcome': 0 } },
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

  it('accepts each core turnEnd kind and remaining v2 enums', () => {
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
    expect(TURN_STEP_VISIT_CAPS).toEqual({ 'apply-pre-step': 256, 'apply-step-outcome': 256 })

    const zero = freezeTurnStepState(sampleState({
      visits: { 'apply-pre-step': 0, 'apply-step-outcome': 0 },
    }))
    const one = recordNodeVisit(zero, 'apply-pre-step')
    expect(one.visits['apply-pre-step']).toBe(1)
    expect(one).not.toBe(zero)
    expect(zero.visits['apply-pre-step']).toBe(0)

    const two = recordNodeVisit(one, 'apply-pre-step')
    expect(two.visits['apply-pre-step']).toBe(2)

    const fresh = freezeTurnStepState(sampleState({
      visits: { 'apply-pre-step': 0, 'apply-step-outcome': 0 },
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
      visits: { 'apply-pre-step': 256, 'apply-step-outcome': 0 },
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

  it('declares the immutable all join used by the tool-call effect edge', () => {
    expect(TOOL_CALL_JOIN_POLICY).toEqual({
      kind: 'all',
      commitOrder: 'model-order',
      conclusion: 'any-concludes-turn',
      abort: 'drain-started-synthesize-unstarted',
      schedulerFailure: 'drain-started-failure-first',
    })
    expect(Object.isFrozen(TOOL_CALL_JOIN_POLICY)).toBe(true)
    expect(() => {
      (TOOL_CALL_JOIN_POLICY as { kind: string }).kind = 'first'
    }).toThrow(TypeError)
  })

  it('validateTurnStepGraph accepts the canonical graph and rejects drifted shapes', () => {
    expect(() => validateTurnStepGraph()).not.toThrow()
    expect(TURN_STEP_GRAPH.joins).toEqual({
      'tool-calls': {
        onEdge: { from: 'route-claimed', on: 'enter-step', to: 'apply-step-outcome' },
        policy: TOOL_CALL_JOIN_POLICY,
      },
    })
    expect(TURN_STEP_GRAPH.entry).toBe('apply-pre-step')
    expect(TURN_STEP_GRAPH.nodes).toEqual([...TURN_STEP_NODES])
    expect(TURN_STEP_GRAPH.routers['route-pre-step'].targets).toEqual([...PRE_STEP_ROUTER_TARGETS])
    expect(TURN_STEP_GRAPH.caps).toEqual(TURN_STEP_VISIT_CAPS)

    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(TURN_STEP_GRAPH)) as Record<string, unknown>
    const expectInvalid = (graph: unknown) => {
      expect(() => validateTurnStepGraph(graph)).toThrow(TurnStepGraphInvalidError)
    }

    expectInvalid(null)
    expectInvalid({ ...clone(), extra: true })
    const missingJoins = clone()
    delete missingJoins.joins
    expectInvalid(missingJoins)
    expectInvalid({ ...clone(), joins: {} })
    expectInvalid({ ...clone(), joins: { 'tool-calls': null } })
    expectInvalid({ ...clone(), joins: { 'tool-calls': { onEdge: {}, policy: TOOL_CALL_JOIN_POLICY } } })
    expectInvalid({ ...clone(), joins: { 'tool-calls': { onEdge: { from: 'x', on: 'y', to: 'z' }, policy: null } } })
    expectInvalid({
      ...clone(),
      joins: {
        'tool-calls': {
          onEdge: { from: 'route-claimed', on: 'enter-step', to: 'ghost' },
          policy: TOOL_CALL_JOIN_POLICY,
        },
      },
    })
    for (const [key, value] of [
      ['kind', 'first'],
      ['commitOrder', 'settlement-order'],
      ['conclusion', 'all-conclude-turn'],
      ['abort', 'cancel-all'],
      ['schedulerFailure', 'throw-immediately'],
      ['schedulerFailure', 'drain-started-throw-first'],
    ] as const) {
      expectInvalid({
        ...clone(),
        joins: {
          'tool-calls': {
            onEdge: { from: 'route-claimed', on: 'enter-step', to: 'apply-step-outcome' },
            policy: { ...TOOL_CALL_JOIN_POLICY, [key]: value },
          },
        },
      })
    }
    expectInvalid({ ...clone(), entry: 'ghost' })
    expectInvalid({ ...clone(), nodes: 'apply-pre-step' })
    expectInvalid({ ...clone(), routers: {} })
    expectInvalid({ ...clone(), routers: { 'route-pre-step': { after: 'apply-pre-step', targets: [...PRE_STEP_ROUTER_TARGETS] } } })
    const driftClaimed = clone()
    ;(driftClaimed.routers as Record<string, unknown>)['route-claimed'] = {
      after: 'apply-pre-step',
      targets: ['enter-step'],
    }
    expectInvalid(driftClaimed)
    const driftOutcome = clone()
    ;(driftOutcome.routers as Record<string, unknown>)['route-step-outcome'] = {
      after: 'apply-step-outcome',
      targets: ['finish-turn'],
    }
    expectInvalid(driftOutcome)
    const dropTarget = clone()
    ;(dropTarget.routers as Record<string, unknown>)['route-pre-step'] = {
      after: 'apply-pre-step',
      targets: ['block-turn'],
    }
    expectInvalid(dropTarget)
    const unreachable = clone()
    unreachable.nodes = [...TURN_STEP_NODES, 'orphan']
    unreachable.caps = { ...TURN_STEP_VISIT_CAPS, orphan: 1 }
    expectInvalid(unreachable)
    expectInvalid({ ...clone(), caps: {} })
    expectInvalid({ ...clone(), caps: { 'apply-pre-step': 256, ghost: 1 } })
    expectInvalid({ ...clone(), caps: { 'apply-pre-step': 0 } })
    expectInvalid({ ...clone(), nodes: ['apply-pre-step', 'ghost'], caps: { 'apply-pre-step': 256, ghost: 1 } })
    expectInvalid({ ...clone(), edges: 'nope' })
    expectInvalid({
      ...clone(),
      edges: [{ from: 'apply-pre-step', to: 'missing-router' }],
    })
    const invalidRouterTarget = clone()
    invalidRouterTarget.edges = [
      ...(invalidRouterTarget.edges as Record<string, unknown>[]),
      { from: 'route-pre-step', on: 'bogus', to: 'terminal' },
    ]
    expectInvalid(invalidRouterTarget)
    const dropBlockedEdge = clone()
    dropBlockedEdge.edges = (dropBlockedEdge.edges as Record<string, unknown>[])
      .filter(edge => !(edge.from === 'route-pre-step' && edge.on === 'block-turn'))
    expectInvalid(dropBlockedEdge)
    const dropEnterEdge = clone()
    dropEnterEdge.edges = [
      { from: 'apply-pre-step', to: 'route-pre-step' },
      { from: 'route-pre-step', on: 'block-turn', to: 'terminal' },
    ]
    expectInvalid(dropEnterEdge)
    expectInvalid({
      entry: 'ghost',
      nodes: ['ghost'],
      routers: { 'route-pre-step': { after: 'ghost', targets: ['loop'] } },
      terminals: [],
      edges: [
        { from: 'ghost', to: 'route-pre-step' },
        { from: 'route-pre-step', on: 'loop', to: 'ghost' },
      ],
      caps: {},
    })
    expectInvalid({
      ...clone(),
      routers: { 'route-pre-step': { after: 'ghost', targets: [...PRE_STEP_ROUTER_TARGETS] } },
    })
    expectInvalid({
      ...clone(),
      terminals: ['missing-exit'],
    })
    const undeclaredTerminal = clone()
    undeclaredTerminal.terminals = ['block-turn', 'complete-turn', 'preserve-turn-end']
    expectInvalid(undeclaredTerminal)
    expectInvalid({
      ...clone(),
      terminals: [...TURN_STEP_GRAPH.terminals, 'orphan-target'],
    })
    expectInvalid({
      ...clone(),
      edges: [
        { from: 'apply-pre-step', to: 'route-pre-step' },
        { from: 'route-pre-step', on: 'block-turn', to: 'nowhere' },
        { from: 'route-pre-step', on: 'enter-step', to: 'apply-pre-step' },
      ],
    })
    expectInvalid({
      ...clone(),
      edges: [{ from: 1, to: 'route-pre-step' }],
    })
    expectInvalid({
      ...clone(),
      edges: [
        { from: 'apply-pre-step', to: 'route-pre-step' },
        { from: 'apply-pre-step', on: 'block-turn', to: 'terminal' },
        { from: 'route-pre-step', on: 'enter-step', to: 'apply-pre-step' },
      ],
    })
    expectInvalid({
      ...clone(),
      edges: [{ from: 'route-pre-step', to: 'apply-pre-step' }],
    })
    expectInvalid({
      ...clone(),
      terminals: ['block-turn', 'extra'],
    })
    expectInvalid({
      entry: 'ghost',
      nodes: ['ghost'],
      routers: { 'route-pre-step': { after: 'ghost', targets: ['block-turn'] } },
      terminals: ['block-turn'],
      edges: [
        { from: 'ghost', to: 'route-pre-step' },
        { from: 'route-pre-step', on: 'enter-step', to: 'ghost' },
      ],
      caps: { ghost: 1 },
    })
    expect(() => validateTurnStepGraph({
      entry: 'a',
      nodes: ['a', 'b'],
      routers: { 'route-pre-step': { after: 'a', targets: ['to-b', 'also-b'] } },
      terminals: [],
      edges: [
        { from: 'a', to: 'route-pre-step' },
        { from: 'route-pre-step', on: 'to-b', to: 'b' },
        { from: 'route-pre-step', on: 'also-b', to: 'b' },
        { from: 'b', to: 'route-pre-step' },
      ],
      caps: { a: 1, b: 1 },
      joins: {
        'tool-calls': {
          onEdge: { from: 'route-pre-step', on: 'to-b', to: 'b' },
          policy: TOOL_CALL_JOIN_POLICY,
        },
      },
    })).not.toThrow()
    expectInvalid({
      entry: 'a',
      nodes: ['a'],
      routers: { r: { after: 'a', targets: ['loop'] } },
      terminals: [],
      edges: [
        { from: 'a', to: 'r' },
        { from: 'r', on: 'loop', to: 'r' },
      ],
      caps: { a: 1 },
      joins: {
        'tool-calls': {
          onEdge: { from: 'r', on: 'loop', to: 'r' },
          policy: TOOL_CALL_JOIN_POLICY,
        },
      },
    })
    expect(() => validateTurnStepGraph({
      entry: 'solo',
      nodes: ['solo'],
      routers: { 'route-pre-step': { after: 'solo', targets: ['end'] } },
      terminals: ['end'],
      edges: [
        { from: 'route-pre-step', on: 'end', to: 'terminal' },
      ],
      caps: { solo: 1 },
      joins: {
        'tool-calls': {
          onEdge: { from: 'route-pre-step', on: 'end', to: 'terminal' },
          policy: TOOL_CALL_JOIN_POLICY,
        },
      },
    })).not.toThrow()
  })

  it('checkpointAfterNode freezes last-good State and roundtrips as JSON', () => {
    const state = freezeTurnStepState(sampleState({
      preStep: 'enter',
      visits: { 'apply-pre-step': 1, 'apply-step-outcome': 0 },
    }))
    const before = JSON.stringify(state)
    const checkpoint = checkpointAfterNode(state, 'apply-pre-step')
    expect(checkpoint.schemaVersion).toBe(2)
    expect(checkpoint.node).toBe('apply-pre-step')
    expect(checkpoint.state).toEqual(state)
    expect(JSON.stringify(state)).toBe(before)
    expect(() => {
      (checkpoint as { node: string }).node = 'ghost'
    }).toThrow(TypeError)

    const parsed = parseTurnStepCheckpoint(JSON.parse(JSON.stringify(checkpoint)))
    expect(parsed).toEqual(checkpoint)
    expect(parsed).not.toBe(checkpoint)

    const evolved = evolveTurnStepState(state, { step: 9 })
    expect(evolved.step).toBe(9)
    expect(JSON.stringify(checkpoint.state)).toBe(before)
  })

  it('parseTurnStepCheckpoint rejects version mismatch, unknown node, and extra keys', () => {
    const state = freezeTurnStepState(sampleState())
    const golden = JSON.parse(JSON.stringify(checkpointAfterNode(state, 'apply-pre-step'))) as Record<string, unknown>

    expect(() => checkpointAfterNode(state, 'ghost' as typeof TURN_STEP_NODES[number]))
      .toThrow(TurnStepStateInvalidError)

    const versionError = parseCheckpointThrow({ ...golden, schemaVersion: 1 })
    expect(versionError).toBeInstanceOf(TurnStepStateVersionError)
    expect(versionError).toMatchObject({ expected: 2, found: 1 })
    expect(parseCheckpointThrow(null)).toBeInstanceOf(TurnStepStateVersionError)
    expect(parseCheckpointThrow({ schemaVersion: 2, node: 'ghost', state: golden.state }))
      .toBeInstanceOf(TurnStepStateInvalidError)
    expect(parseCheckpointThrow({ ...golden, extra: true }))
      .toBeInstanceOf(TurnStepStateInvalidError)
    expect(parseCheckpointThrow({ schemaVersion: 2, node: 'apply-pre-step' }))
      .toBeInstanceOf(TurnStepStateInvalidError)
    expect(parseCheckpointThrow({
      schemaVersion: 2,
      node: 'apply-pre-step',
      state: () => 'nope',
    })).toBeInstanceOf(TurnStepStateInvalidError)
  })

  it('resumeTurnStep loads a checkpoint, re-routes, and skips the node body', () => {
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
    const enterCheckpoint = checkpointAfterNode(entered, 'apply-pre-step')
    const beforeEnter = JSON.stringify(enterCheckpoint.state)
    const resumedEnter = resumeTurnStep(enterCheckpoint)
    expect(resumedEnter.route).toBe('enter-step')
    expect(resumedEnter.state.preStep).toBe('enter')
    expect(resumedEnter.state.claimed).toEqual(entered.claimed)
    expect(JSON.stringify(enterCheckpoint.state)).toBe(beforeEnter)
    expect(JSON.stringify(resumedEnter.state)).toBe(beforeEnter)

    const rejected = applyPreStepDecision(pending, { kind: 'reject' })
    const resumedReject = resumeTurnStep(checkpointAfterNode(rejected, 'apply-pre-step'))
    expect(resumedReject.route).toBe('block-turn')
    expect(resumedReject.state.preStep).toBe('reject')
    expect(resumedReject.state.claimed).toEqual([])

    const jsonResume = resumeTurnStep(JSON.parse(JSON.stringify(enterCheckpoint)))
    expect(jsonResume.route).toBe('enter-step')
    expect(jsonResume.state).toEqual(entered)

    const outcome = applyStepOutcome(entered, { kind: 'completed' }, entered.inbox)
    const resumedOutcome = resumeTurnStep(checkpointAfterNode(outcome, 'apply-step-outcome'))
    expect(resumedOutcome.route).toBe('finish-turn')
    expect(resumedOutcome.state.stepEnd).toEqual({ kind: 'completed' })

    expect(() => resumeTurnStep(checkpointAfterNode(pending, 'apply-pre-step')))
      .toThrow(TurnStepStateInvalidError)
    const versionError = (() => {
      try {
        resumeTurnStep({ ...JSON.parse(JSON.stringify(enterCheckpoint)), schemaVersion: 1 })
      } catch (error) {
        return error
      }
    })()
    expect(versionError).toBeInstanceOf(TurnStepStateVersionError)
    expect(versionError).toMatchObject({ expected: 2, found: 1 })
  })

  it('applyTurnStepFailure writes routable facts and routeFailure switches on them', () => {
    expect(FAILURE_ROUTER_TARGETS).toEqual(['continue', 'stop-turn'])

    const clean = freezeTurnStepState(sampleState({ failure: null }))
    const before = JSON.stringify(clean)
    expect(routeFailure(clean)).toBe('continue')

    const failed = applyTurnStepFailure(clean, { message: 'boom', code: 'UNKNOWN' })
    expect(failed.failure).toEqual({ message: 'boom', code: 'UNKNOWN' })
    expect(routeFailure(failed)).toBe('stop-turn')
    expect(JSON.stringify(clean)).toBe(before)
    expect(clean.failure).toBeNull()

    const cleared = applyTurnStepFailure(failed, null)
    expect(cleared.failure).toBeNull()
    expect(routeFailure(cleared)).toBe('continue')
    expect(failed.failure).toEqual({ message: 'boom', code: 'UNKNOWN' })

    expect(() => applyTurnStepFailure(clean, { message: '', code: 'UNKNOWN' }))
      .toThrow(TurnStepStateInvalidError)
    expect(() => applyTurnStepFailure(clean, { message: 'boom', code: 'UNKNOWN', extra: true } as { message: string; code: string }))
      .toThrow(TurnStepStateInvalidError)
  })

  it('applyRequestError writes retry|throw and routeRequestError switches on them', () => {
    expect(REQUEST_ERROR_ROUTER_TARGETS).toEqual(['retry', 'throw'])

    const pending = freezeTurnStepState(sampleState({
      requestError: 'none',
      failure: { message: 'keep', code: 'STAY' },
    }))
    const before = JSON.stringify(pending)
    expect(() => routeRequestError(pending)).toThrow(TurnStepStateInvalidError)
    expect(() => routeRequestError(pending)).toThrow(/requestError is none/)

    const retried = applyRequestError(pending, 'retry')
    expect(retried.requestError).toBe('retry')
    expect(retried.failure).toEqual({ message: 'keep', code: 'STAY' })
    expect(routeRequestError(retried)).toBe('retry')
    expect(JSON.stringify(pending)).toBe(before)

    const thrown = applyRequestError(retried, 'throw')
    expect(thrown.requestError).toBe('throw')
    expect(thrown.failure).toEqual({ message: 'keep', code: 'STAY' })
    expect(routeRequestError(thrown)).toBe('throw')
    expect(retried.requestError).toBe('retry')
  })

  it('applyStepOutcome is a pure v2 node with sticky outcome and declared routing', () => {
    expect(TURN_STEP_STATE_VERSION).toBe(2)
    expect(TURN_STEP_NODES).toEqual(['apply-pre-step', 'apply-step-outcome'])
    expect(TURN_STEP_VISIT_CAPS).toEqual({
      'apply-pre-step': 256,
      'apply-step-outcome': 256,
    })
    expect(STEP_OUTCOME_ROUTER_TARGETS).toEqual(['finish-turn', 'next-pre-step'])

    const base = freezeTurnStepState(sampleState({
      schemaVersion: 2,
      stepEnd: null,
      turnEnd: null,
      inbox: { nextTurn: [], nextStep: [] },
      visits: { 'apply-pre-step': 1, 'apply-step-outcome': 0 },
    }))
    const before = JSON.stringify(base)
    const completed = applyStepOutcome(base, { kind: 'completed' }, base.inbox)
    expect(completed.stepEnd).toEqual({ kind: 'completed' })
    expect(completed.turnEnd).toEqual({ kind: 'completed' })
    expect(routeStepOutcome(completed)).toBe('finish-turn')
    expect(JSON.stringify(base)).toBe(before)

    const pending = applyStepOutcome(base, null, {
      nextTurn: [],
      nextStep: [createUserMessage({
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'user' },
      })],
    })
    expect(pending.stepEnd).toBeNull()
    expect(pending.turnEnd).toBeNull()
    expect(routeStepOutcome(pending)).toBe('next-pre-step')

    const stickyBase = evolveTurnStepState(base, { turnEnd: { kind: 'max-tokens' } })
    const sticky = applyStepOutcome(stickyBase, { kind: 'completed' }, stickyBase.inbox)
    expect(sticky.stepEnd).toEqual({ kind: 'completed' })
    expect(sticky.turnEnd).toEqual({ kind: 'max-tokens' })
    expect(routeStepOutcome(sticky)).toBe('finish-turn')

    const maxed = applyStepOutcome(base, { kind: 'max-tokens' }, base.inbox)
    expect(maxed.turnEnd).toEqual({ kind: 'max-tokens' })

    const cleared = applyStepOutcome(
      evolveTurnStepState(base, { turnEnd: { kind: 'completed' } }),
      null,
      pending.inbox,
    )
    expect(cleared.turnEnd).toBeNull()
    expect(routeStepOutcome(cleared)).toBe('next-pre-step')
  })

  it('traceAfterNode freezes a completed node path entry from a checkpoint', () => {
    const state = freezeTurnStepState(sampleState({
      turn: 3,
      step: 2,
      visits: { 'apply-pre-step': 2, 'apply-step-outcome': 1 },
    }))
    const checkpoint = checkpointAfterNode(state, 'apply-step-outcome')
    const before = JSON.stringify(checkpoint)
    const entry = traceAfterNode(checkpoint, 1_000, 1_007)
    expect(entry).toEqual({
      node: 'apply-step-outcome',
      turn: 3,
      step: 2,
      startedAt: 1_000,
      durationMs: 7,
      state,
    })
    expect(entry.state).toBe(checkpoint.state)
    expect(Object.isFrozen(entry)).toBe(true)
    expect(JSON.stringify(checkpoint)).toBe(before)
    expect(() => {
      (entry as { durationMs: number }).durationMs = 0
    }).toThrow(TypeError)

    const fromJson = traceAfterNode(JSON.parse(JSON.stringify(checkpoint)), 1_000, 1_007)
    expect(fromJson).toEqual(entry)
    expect(fromJson.state).not.toBe(checkpoint.state)

    const pre = checkpointAfterNode(state, 'apply-pre-step')
    expect(traceAfterNode(pre, 5, 5).durationMs).toBe(0)
    expect(traceAfterNode(pre, 5, 5).node).toBe('apply-pre-step')

    const invalid: unknown[] = [
      [Number.NaN, 2],
      [1, Number.POSITIVE_INFINITY],
      [-1, 2],
      [1, 0],
      [1.5, 3],
      [1, 2.5],
    ]
    for (const [startedAt, finishedAt] of invalid) {
      expect(() => traceAfterNode(checkpoint, startedAt as number, finishedAt as number))
        .toThrow(TurnStepTraceInvalidError)
    }
  })

  it('routeClaimed declares initial-empty, preserved-outcome, and enter-step targets', () => {
    expect(CLAIMED_ROUTER_TARGETS).toEqual([
      'enter-step',
      'complete-turn',
      'preserve-turn-end',
    ])

    const nonEmpty = freezeTurnStepState(sampleState({
      claimed: [createUserMessage({
        content: [{ type: 'text', text: 'go' }],
        source: { kind: 'user' },
      })],
      claimTarget: 'next-turn',
      turnEnd: { kind: 'completed' },
    }))
    const before = JSON.stringify(nonEmpty)
    expect(routeClaimed(nonEmpty)).toBe('enter-step')
    expect(JSON.stringify(nonEmpty)).toBe(before)

    const preserved = freezeTurnStepState(sampleState({
      claimed: [],
      claimTarget: 'next-step',
      turnEnd: { kind: 'max-tokens' },
    }))
    expect(routeClaimed(preserved)).toBe('preserve-turn-end')

    const initialEmpty = freezeTurnStepState(sampleState({
      claimed: [],
      claimTarget: 'next-turn',
      turnEnd: null,
    }))
    expect(routeClaimed(initialEmpty)).toBe('complete-turn')

    const continuationEmpty = freezeTurnStepState(sampleState({
      claimed: [],
      claimTarget: 'next-step',
      turnEnd: null,
    }))
    expect(routeClaimed(continuationEmpty)).toBe('enter-step')
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

function parseCheckpointThrow(value: unknown): unknown {
  try {
    parseTurnStepCheckpoint(value)
    return undefined
  } catch (error) {
    return error
  }
}
