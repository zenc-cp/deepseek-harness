import { describe, expect, it } from 'vitest'
import {
  GraphValidationError,
  validateGraph,
  type GraphSpec,
} from '../src/validate-graph.ts'

describe('graph validation', () => {
  const baseSpec: GraphSpec = {
    entry: 'wake',
    nodes: ['enterRunning', 'latchWake', 'noop'],
    routers: {
      wake: ['enterRunning', 'latchWake', 'noop'],
    },
    visitCaps: ['enterRunning'],
  }

  it('accepts a well-formed graph', () => {
    const errors = validateGraph(baseSpec)
    expect(errors).toHaveLength(0)
  })

  it('reports router targets that do not exist', () => {
    const bad: GraphSpec = {
      ...baseSpec,
      routers: {
        wake: ['enterRunning', 'ghostNode'],
      },
    }
    const errors = validateGraph(bad)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toBeInstanceOf(GraphValidationError)
    expect(errors[0]?.message).toMatch(/ghostNode/)
  })

  it('requires visit caps on nodes that participate in cycles', () => {
    const noCap: GraphSpec = {
      entry: 'a',
      nodes: ['a', 'b'],
      routers: {
        a: ['b'],
        b: ['a'],
      },
      visitCaps: [], // cycle with no cap
    }
    const errors = validateGraph(noCap)
    expect(errors.some(e => e.message.includes('visit cap'))).toBe(true)
  })

  it('detects unreachable nodes from the entry point', () => {
    const unreachable: GraphSpec = {
      entry: 'start',
      nodes: ['start', 'orphan'],
      routers: {
        start: [],
      },
      visitCaps: [],
    }
    const errors = validateGraph(unreachable)
    expect(errors.some(e => e.message.includes('orphan'))).toBe(true)
  })
})
