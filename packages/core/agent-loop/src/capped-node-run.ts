/**
 * Experimental synchronous node boundary. Not wired into the live driver.
 * Each constructed run owns its counters; no reset or persistence is exposed.
 */
import type { GraphState } from './state.ts'
import { checkVisit, createVisitCap, type VisitCap } from './visit-cap.ts'

export interface CappedNode {
  readonly nodeId: string
  readonly budget: number
  readonly node: (state: GraphState) => GraphState
}

export interface CappedNodeRun {
  invoke(nodeId: string, state: GraphState): GraphState
}

/** Trusted GraphState in/out. Attempts count even if a node throws. */
export function createCappedNodeRun(declarations: readonly CappedNode[]): CappedNodeRun {
  const entries = new Map<string, { node: CappedNode['node']; cap: VisitCap }>()
  for (const { nodeId, budget, node } of declarations) {
    if (!nodeId || entries.has(nodeId)) {
      throw new TypeError('node identifiers must be nonempty and unique')
    }
    entries.set(nodeId, { node, cap: createVisitCap(nodeId, budget) })
  }
  return Object.freeze({
    invoke(nodeId: string, state: GraphState): GraphState {
      const entry = entries.get(nodeId)
      if (!entry) throw new TypeError(`unknown node "${nodeId}"`)
      // Reserve before invocation, including reentrant calls and thrown bodies.
      entry.cap = checkVisit(entry.cap)
      return entry.node(state)
    },
  })
}
