/** Standalone expected-domain-result contract. No exception conversion or routing. */
import { z as zod } from 'zod'
import { parseGraphState, type GraphState } from './state.ts'

const codeSchema = zod.string().min(1).max(64).refine(value => value.trim().length > 0)
const messageSchema = zod.string().min(1).max(1024).refine(value => value.trim().length > 0)
const resultSchema = zod.discriminatedUnion('kind', [
  zod.object({ kind: zod.literal('success'), state: zod.unknown() }).strict(),
  zod.object({
    kind: zod.literal('failure'),
    failure: zod.object({ code: codeSchema, message: messageSchema }).strict(),
  }).strict(),
])

export type DomainResult =
  | { readonly kind: 'success'; readonly state: GraphState }
  | { readonly kind: 'failure'; readonly failure: { readonly code: string; readonly message: string } }

/**
 * Validate and detach a result. Messages are bounded, NOT sanitized: use safe fixed templates.
 * Legacy bare State and arbitrary Error/details payloads are deliberately not accepted.
 */
export function parseDomainResult(value: unknown, declaredCodes: readonly string[]): DomainResult {
  const codes = zod.array(codeSchema).parse(declaredCodes)
  const allowed = new Set(codes)
  if (allowed.size !== codes.length) throw new TypeError('declared failure codes must be unique')
  const result = resultSchema.parse(value)
  if (result.kind === 'success') {
    return Object.freeze({ kind: 'success', state: parseGraphState(result.state) })
  }
  if (!allowed.has(result.failure.code)) throw new TypeError('undeclared domain failure code')
  return Object.freeze({ kind: 'failure', failure: Object.freeze({ ...result.failure }) })
}
