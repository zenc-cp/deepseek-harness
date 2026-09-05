/**
 * Failure as a routable value.
 * Failures are data, not exceptions, so routers can decide what to do next.
 * @module @deepseek-ai/dsh-agent-loop/failure-as-routable
 */

export interface Failure {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export function createFailure(code: string, message: string, details?: unknown): Failure {
  return Object.freeze({ code, message, details })
}

export function isFailure(value: unknown): value is Failure {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.isFrozen(value) &&
    'code' in value &&
    'message' in value
  )
}
