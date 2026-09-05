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

  // 1. All router targets must exist
  for (const [routerName, targets] of Object.entries(spec.routers)) {
    for (const target of targets) {
      if (!nodeSet.has(target)) {
        errors.push(new GraphValidationError(
          `Router "${routerName}" targets unknown node "${target}"`,
        ))
      }
    }
  }

  // 2. Nodes that appear in cycles should have visit caps (simple check)
  const hasCycle = detectSimpleCycle(spec)
  if (hasCycle && spec.visitCaps.length === 0) {
    errors.push(new GraphValidationError(
      'Graph contains a cycle but no visit caps are declared',
    ))
  }

  // 3. All nodes should be reachable from entry (basic reachability)
  const reachable = computeReachable(spec)
  for (const node of spec.nodes) {
    if (!reachable.has(node)) {
      errors.push(new GraphValidationError(`Node "${node}" is unreachable from entry "${spec.entry}"`))
    }
  }

  return errors
}

function detectSimpleCycle(spec: GraphSpec): boolean {
  for (const targets of Object.values(spec.routers)) {
    for (const t of targets) {
      // very naive: if any router can point back, treat as possible cycle
      if (spec.routers[t]) {
        return true
      }
    }
  }
  return false
}

function computeReachable(spec: GraphSpec): Set<string> {
  const reachable = new Set<string>()
  const queue: string[] = [spec.entry]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (reachable.has(current)) continue
    reachable.add(current)
    const targets = spec.routers[current] ?? []
    for (const t of targets) {
      if (!reachable.has(t)) queue.push(t)
    }
  }
  return reachable
}
