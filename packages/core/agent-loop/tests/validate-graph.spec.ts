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

  it('accepts an acyclic chain of routers without caps', () => {
    expect(validateGraph({ entry: 'a', nodes: ['a', 'b', 'c'], routers: { a: ['b'], b: ['c'] }, visitCaps: [] })).toEqual([])
  })

  it('requires a cap on each cyclic node, not an unrelated node', () => {
    const spec = { entry: 'a', nodes: ['a', 'b', 'exit'], routers: { a: ['b', 'exit'], b: ['a'] }, visitCaps: ['exit'] }
    const messages = validateGraph(spec).map(e => e.message)
    expect(messages).toContain('Cyclic node "a" requires a visit cap')
    expect(messages).toContain('Cyclic node "b" requires a visit cap')
    expect(validateGraph({ ...spec, visitCaps: ['a', 'b'] })).toEqual([])
    expect(validateGraph({ ...spec, visitCaps: ['a'] }).map(e => e.message)).toEqual(['Cyclic node "b" requires a visit cap'])
  })

  it('detects self loops and does not cap acyclic tails', () => {
    const spec = { entry: 'a', nodes: ['a', 'tail'], routers: { a: ['a', 'tail'] }, visitCaps: [] }
    expect(validateGraph(spec).map(e => e.message)).toEqual(['Cyclic node "a" requires a visit cap'])
    expect(validateGraph({ ...spec, visitCaps: ['a'] })).toEqual([])
  })

  it('rejects undeclared entry and cap identities', () => {
    expect(validateGraph({ entry: 'ghost', nodes: [], routers: {}, visitCaps: [] }).map(e => e.message)).toContain('Unknown entry "ghost"')
    expect(validateGraph({ ...baseSpec, visitCaps: ['ghost'] }).map(e => e.message)).toContain('Visit cap targets unknown node "ghost"')
  })

  it('rejects duplicate or empty declaration identifiers', () => {
    expect(validateGraph({ ...baseSpec, nodes: [...baseSpec.nodes, 'noop'] }).length).toBeGreaterThan(0)
    expect(validateGraph({ entry: '', nodes: [''], routers: {}, visitCaps: [] }).length).toBeGreaterThan(0)
    expect(validateGraph({ ...baseSpec, visitCaps: ['noop', 'noop'] }).length).toBeGreaterThan(0)
  })

  it('does not read inherited router properties', () => {
    expect(validateGraph({ entry: 'toString', nodes: ['toString'], routers: {}, visitCaps: [] })).toEqual([])
  })

  it('validates disconnected cycles and orphan router declarations', () => {
    const errors = validateGraph({ entry: 'start', nodes: ['start', 'a', 'b'], routers: { a: ['b'], b: ['a'], orphan: [] }, visitCaps: [] }).map(e => e.message)
    expect(errors).toContain('Cyclic node "a" requires a visit cap')
    expect(errors).toContain('Cyclic node "b" requires a visit cap')
    expect(errors).toContain('Router "orphan" is unreachable from entry "start"')
  })

  it('accepts a converging acyclic diamond without caps', () => {
    expect(validateGraph({ entry: 'a', nodes: ['a', 'b', 'c', 'd'], routers: { a: ['b', 'c'], b: ['d'], c: ['d'] }, visitCaps: [] })).toEqual([])
  })

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
