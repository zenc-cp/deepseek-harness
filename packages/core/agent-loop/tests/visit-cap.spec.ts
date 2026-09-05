import { describe, expect, it } from 'vitest'
import {
  VisitCapError,
  createVisitCap,
  checkVisit,
  resetVisitCap,
} from '../src/visit-cap.ts'

describe('visit cap', () => {
  it('creates a cap with default budget 3 for step-retry node', () => {
    const cap = createVisitCap('step-retry')
    expect(cap.nodeId).toBe('step-retry')
    expect(cap.budget).toBe(3)
    expect(cap.count).toBe(0)
    expect(Object.isFrozen(cap)).toBe(true)
  })

  it('allows visits up to budget and throws on the next', () => {
    let cap = createVisitCap('step-retry', 2)
    cap = checkVisit(cap)
    expect(cap.count).toBe(1)
    cap = checkVisit(cap)
    expect(cap.count).toBe(2)
    expect(() => checkVisit(cap)).toThrow(VisitCapError)
    try {
      checkVisit(cap)
    } catch (error) {
      expect(error).toBeInstanceOf(VisitCapError)
      expect((error as VisitCapError).nodeId).toBe('step-retry')
      expect((error as VisitCapError).budget).toBe(2)
      expect((error as VisitCapError).count).toBe(2)
    }
  })

  it('different nodes have independent counters', () => {
    let a = createVisitCap('node-a', 1)
    let b = createVisitCap('node-b', 1)
    a = checkVisit(a)
    expect(() => checkVisit(a)).toThrow(VisitCapError)
    b = checkVisit(b)
    expect(b.count).toBe(1)
  })

  it('reset clears the counter for a fresh turn', () => {
    let cap = createVisitCap('step-retry', 1)
    cap = checkVisit(cap)
    expect(cap.count).toBe(1)
    const fresh = resetVisitCap(cap)
    expect(fresh.count).toBe(0)
    expect(fresh.nodeId).toBe(cap.nodeId)
    expect(fresh.budget).toBe(cap.budget)
  })
})
