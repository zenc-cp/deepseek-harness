import { describe, expect, it } from 'vitest'
import {
  createFailure,
  isFailure,
} from '../src/failure-as-routable.ts'

describe('failure as routable value', () => {
  it('creates a frozen Failure object', () => {
    const f = createFailure('REQUEST_ERROR', 'Model call failed', { retryable: true })
    expect(f.code).toBe('REQUEST_ERROR')
    expect(f.message).toBe('Model call failed')
    expect(f.details).toEqual({ retryable: true })
    expect(Object.isFrozen(f)).toBe(true)
  })

  it('isFailure correctly identifies Failure objects', () => {
    const f = createFailure('TIMEOUT', 'Operation timed out')
    expect(isFailure(f)).toBe(true)
    expect(isFailure({ code: 'X', message: 'y' })).toBe(false)
    expect(isFailure(null)).toBe(false)
  })
})
