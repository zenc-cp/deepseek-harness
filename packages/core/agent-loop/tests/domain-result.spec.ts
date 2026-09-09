import { describe, expect, it } from 'vitest'
import { parseDomainResult } from '../src/domain-result.ts'
import { createGraphState } from '../src/state.ts'

const state = () => createGraphState({
  sessionId: 's', phase: { kind: 'idle', lastTurn: 0 }, inbox: { nextTurnCount: 0, nextStepCount: 0 },
})
const failure = () => ({ kind: 'failure', failure: { code: 'NOT_FOUND', message: 'Item unavailable' } })

describe('domain result parser', () => {
  it('validates and deeply freezes detached success State', () => {
    const input = { kind: 'success', state: structuredClone(state()) }
    const result = parseDomainResult(input, [])
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') throw new Error('expected success')
    input.state.inbox.nextTurnCount = 9
    expect(result.state.inbox.nextTurnCount).toBe(0)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.state.inbox)).toBe(true)
  })

  it('validates detached frozen expected failures', () => {
    const input = failure()
    const result = parseDomainResult(input, ['NOT_FOUND'])
    input.failure.message = 'changed'
    expect(result).toEqual(failure())
    expect(Object.isFrozen(result)).toBe(true)
    if (result.kind !== 'failure') throw new Error('expected failure')
    expect(Object.isFrozen(result.failure)).toBe(true)
  })

  it.each([
    null, {}, { kind: 'unknown' }, { kind: 'success', state: null },
    { ...failure(), extra: true },
    { kind: 'failure', failure: { code: 'NOT_FOUND', message: 'x', details: {} } },
    { kind: 'failure', failure: { code: 1, message: 'x' } },
    { kind: 'failure', failure: { code: 'NOT_FOUND', message: '' } },
    { kind: 'failure', failure: { code: 'NOT_FOUND', message: '   ' } },
    { kind: 'failure', failure: { code: 'NOT_FOUND', message: 'x'.repeat(1025) } },
    { kind: 'failure', failure: new Error('private exception') },
  ])('rejects invalid result %j', (value) => {
    expect(() => parseDomainResult(value, ['NOT_FOUND'])).toThrow()
  })

  it('rejects undeclared codes, legacy bare State and incompatible State version', () => {
    expect(() => parseDomainResult(failure(), [])).toThrow()
    expect(() => parseDomainResult(state(), [])).toThrow()
    expect(() => parseDomainResult({ kind: 'success', state: { ...state(), version: 99 } }, [])).toThrow()
    expect(() => parseDomainResult({ kind: 'success', state: state(), failure: failure().failure }, [])).toThrow()
  })

  it.each([[''], [' '], ['x'.repeat(65)], ['A', 'A']])('rejects malformed declared codes %j', (...codes) => {
    expect(() => parseDomainResult({ kind: 'success', state: state() }, codes)).toThrow()
  })

  it('accepts boundary lengths without trimming payloads', () => {
    const code = 'x'.repeat(64)
    const value = { kind: 'failure', failure: { code, message: 'x'.repeat(1024) } }
    expect(parseDomainResult(value, [code])).toEqual(value)
  })
})
