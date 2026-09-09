/**
 * Static graph validation for the declared DSH agent graph.
 * Does not execute any nodes or touch the live driver.
 * @module @deepseek-ai/dsh-agent-loop/validate-graph
 */

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphValidationError'
  }
}

export interface GraphSpec {
  entry: string
  nodes: readonly string[]
  routers: Readonly<Record<string, readonly string[]>>
  visitCaps: readonly string[]
}

/** Validate a static graph description. Returns an array of errors (empty = valid). */
export function validateGraph(spec: GraphSpec): GraphValidationError[] {
  const errors: GraphValidationError[] = []
  const nodeSet = new Set(spec.nodes)

  const edges = new Map(Object.entries(spec.routers))
  const caps = new Set(spec.visitCaps)
  if (!spec.entry || (!nodeSet.has(spec.entry) && !edges.has(spec.entry))) {
    errors.push(new GraphValidationError(`Unknown entry "${spec.entry}"`))
  }
  if (nodeSet.size !== spec.nodes.length || spec.nodes.some(node => !node)) {
    errors.push(new GraphValidationError('Node identifiers must be nonempty and unique'))
  }
  if (caps.size !== spec.visitCaps.length) {
    errors.push(new GraphValidationError('Visit cap identifiers must be unique'))
  }
  for (const cap of caps) {
    if (!nodeSet.has(cap)) errors.push(new GraphValidationError(`Visit cap targets unknown node "${cap}"`))
  }
  for (const router of edges.keys()) {
    if (!router) errors.push(new GraphValidationError('Router identifiers must be nonempty'))
  }

  // All router targets must exist
  for (const [routerName, targets] of Object.entries(spec.routers)) {
    for (const target of targets) {
      if (!nodeSet.has(target)) {
        errors.push(new GraphValidationError(
          `Router "${routerName}" targets unknown node "${target}"`,
        ))
      }
    }
  }

  // A node is cyclic exactly when a nonempty path returns to that node.
  // Iterative traversal avoids recursive-stack limits. O(V * (V + E)).
  for (const node of nodeSet) {
    if (!caps.has(node) && walk(edges, edges.get(node) ?? []).has(node)) {
      errors.push(new GraphValidationError(`Cyclic node "${node}" requires a visit cap`))
    }
  }

  // Check both executable nodes and separately declared router entry points.
  const reachable = walk(edges, [spec.entry])
  for (const node of spec.nodes) {
    if (!reachable.has(node)) {
      errors.push(new GraphValidationError(`Node "${node}" is unreachable from entry "${spec.entry}"`))
    }
  }

  for (const router of edges.keys()) {
    if (!nodeSet.has(router) && !reachable.has(router)) {
      errors.push(new GraphValidationError(`Router "${router}" is unreachable from entry "${spec.entry}"`))
    }
  }
  return errors
}

function walk(edges: ReadonlyMap<string, readonly string[]>, starts: readonly string[]): Set<string> {
  const reachable = new Set<string>()
  const queue = [...starts]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    if (current === undefined || reachable.has(current)) continue
    reachable.add(current)
    for (const target of edges.get(current) ?? []) {
      if (!reachable.has(target)) queue.push(target)
    }
  }
  return reachable
}
