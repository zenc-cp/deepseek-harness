/**
 * Visit cap for graph nodes. Different nodes can have different budgets.
 * Hitting the cap throws a loud error instead of looping forever.
 * @module @deepseek-ai/dsh-agent-loop/visit-cap
 */

export class VisitCapError extends Error {
  readonly nodeId: string
  readonly budget: number
  readonly count: number

  constructor(nodeId: string, budget: number, count: number) {
    super(`visit cap exceeded for node "${nodeId}": ${count}/${budget}`)
    this.name = 'VisitCapError'
    this.nodeId = nodeId
    this.budget = budget
    this.count = count
  }
}

export interface VisitCap {
  readonly nodeId: string
  readonly budget: number
  readonly count: number
}

/** Create a fresh visit cap for a node. Default budget 3 (step retry). */
export function createVisitCap(nodeId: string, budget = 3): VisitCap {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new TypeError('visit cap budget must be a positive integer')
  }
  return Object.freeze({ nodeId, budget, count: 0 })
}

/** Record one visit. Returns a new frozen cap. Throws when budget is exceeded. */
export function checkVisit(cap: VisitCap): VisitCap {
  const next = cap.count + 1
  if (next > cap.budget) {
    throw new VisitCapError(cap.nodeId, cap.budget, cap.count)
  }
  return Object.freeze({ ...cap, count: next })
}

/** Reset counter for a new turn while keeping nodeId and budget. */
export function resetVisitCap(cap: VisitCap): VisitCap {
  return Object.freeze({ ...cap, count: 0 })
}
