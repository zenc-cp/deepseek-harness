/**
 * Streaming label classifier for text-first model responses.
 *
 * Steal of HKUDS/DeepTutor's label protocol: the first non-whitespace line of a
 * model reply must be a backtick-wrapped `` `LABEL` `` token so a weak
 * function-calling model can still self-classify its output before emitting tool
 * calls. This module is a pure streaming detector with no loop integration.
 *
 * It is opt-in experimental: no tool in DSH requires labels, and the default
 * agent loop never reads them.
 */
import type { StreamChunk } from './types.ts'

/** Returned once the label is resolved; undefined while buffering, null if the buffer already exceeds the probe ceiling. */
export type LabelDetectionResult = LabelDetection | undefined | null

/** Resolved label and the offset into the first block where the body begins. */
export interface LabelDetection {
  readonly label: string
  /** Character offset from the start of the first text block. */
  readonly bodyOffset: number
}

/** Backtick-wrapped preferred, bare fallback, plus trailing separator tolerance. */
const LABEL_SEPARATORS = '\n\r \t:：-–—'

/**
 * Probe a streaming buffer for a leading backtick-wrapped or bare label.
 * Returns the resolved label and post-label offset, or `undefined` while
 * the buffer is still ambiguous, or `null` when the buffer exceeds
 * `probeMaxChars` without finding a known label.
 *
 * @param buffer - raw accumulated text from text-delta chunks.
 * @param allowedLabels - case-sensitive labels this caller accepts.
 * @param final - true when the stream has ended (no more chunks will arrive).
 * @param probeMaxChars - ceiling on the probe window before giving up.
 */
export function classifyStreamingLabel(
  buffer: string,
  allowedLabels: readonly string[],
  final: boolean,
  probeMaxChars: number,
): LabelDetectionResult {
  const stripped = stripLabelProbePrefix(buffer)
  if (stripped.length > probeMaxChars && !final) return null

  for (const label of allowedLabels) {
    // Backtick-wrapped: `` `LABEL` ``, tolerating 1-3 ticks.
    let tickCount = 0
    while (tickCount < stripped.length && stripped[tickCount] === '`') tickCount++
    if (tickCount >= 1 && tickCount <= 3) {
      const wrapped = new RegExp(
        `^\`{${tickCount}}\\s*${escapeRegExp(label)}\\s*\`{${tickCount}}(.*)$`,
        's',
      )
      const match = wrapped.exec(stripped)
      if (match?.[1] !== undefined) {
        const after = match[1]
        if (after.length > 0 && after[0] === '`') continue
        const bodyOffset = buffer.indexOf(label)
        return { label, bodyOffset: bodyOffset >= 0 ? bodyOffset + label.length : buffer.length }
      }
      // Partial match against the wrapped form (e.g. `` `FI``) — keep buffering.
      if (isPartialWrappedPrefix(stripped, label, tickCount)) return undefined
    }

    // Bare-label fallback: must be followed by a separator.
    if (stripped.startsWith(label)) {
      const tail = stripped.slice(label.length)
      if (tail.length > 0 && LABEL_SEPARATORS.includes(tail[0] ?? '')) {
        const bodyOffset = buffer.indexOf(label)
        return { label, bodyOffset: bodyOffset >= 0 ? bodyOffset + label.length : buffer.length }
      }
      if (final && tail.length === 0) {
        const bodyOffset = buffer.indexOf(label)
        return { label, bodyOffset: bodyOffset >= 0 ? bodyOffset + label.length : buffer.length }
      }
      // Bare label matched but tail doesn't start with a separator — could be
      // a longer token like FINISHED. If no other label matches, that's a dead
      // end (null), but a partial wrapped prefix on a different label could
      // still resolve, so only return undefined when the tail is empty AND we
      // aren't final (might still get a separator in the next chunk).
      if (tail.length === 0 && !final) return undefined
    }
  }

  return null
}

/**
 * Accumulate a single chunk into a label-probe buffer, returning the updated
 * buffer. Callers should pass `null` when the buffer already exceeded the probe
 * ceiling.
 */
export function accumulateLabelProbe(
  buffer: string | null,
  chunk: StreamChunk,
): string | null {
  if (buffer === null) return null
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return buffer
  return buffer + chunk.text
}

/**
 * Build a repair prompt for a violated label protocol. Feed the model's draft
 * text back with the allowed labels so a retry can self-correct.
 * @param draft - the raw text the model emitted.
 * @param allowedLabels - case-sensitive labels the protocol accepts.
 * @param violation - human-readable explanation of what was wrong.
 * @returns one-shot text the caller prepends before retrying.
 */
export function labelProtocolRepairPrompt(
  draft: string,
  allowedLabels: readonly string[],
  violation: string,
): string {
  if (allowedLabels.length === 0) return ''

  const prefix = allowedLabels.length === 1
    ? `Your reply must begin with \`\`${allowedLabels[0]}\`\` on its own line, then the content.`
    : `Your reply must begin with one of ${allowedLabels.map(l => `\`\`${l}\`\``).join(', ')} on its own line, then the content.`

  const preview = draft.length > 200 ? `${draft.slice(0, 200)}…` : draft
  return [
    `${prefix}\n\n`,
    `Your last reply violated this protocol: ${violation}\n\n`,
    `Your draft was:\n\n\`\`\`\n${preview}\n\`\`\`\n\n`,
    'Please restate your reply beginning with the required label.',
  ].join('')
}

/** Strip leading whitespace and zero-width characters. */
function stripLabelProbePrefix(buffer: string): string {
  let previous: string
  let stripped = buffer || ''
  do {
    previous = stripped
    stripped = stripped.replace(/^[\s\uFEFF\u200B\u200C\u200D]+/g, '')
  } while (stripped !== previous)
  return stripped
}

/** Check whether `stripped` is a partial prefix of a backtick-wrapped label. */
function isPartialWrappedPrefix(
  stripped: string,
  label: string,
  tickCount: number,
): boolean {
  const openTicks = '`'.repeat(tickCount)
  if (!stripped.startsWith(openTicks)) return false
  const rest = stripped.slice(tickCount).replace(/^\s+/g, '')
  // If the rest is empty or a prefix of the label, keep buffering.
  if (rest.length === 0) return true
  if (label.startsWith(rest)) return true
  // If the rest contains the full label but hasn't closed the ticks yet,
  // it's still partial.
  if (rest.startsWith(label)) {
    const afterLabel = rest.slice(label.length)
    if (afterLabel.length === 0) return true
    // Closing ticks haven't appeared yet — still partial.
    if (!afterLabel.startsWith('`')) return true
    // Some closing ticks — count them; if fewer than tickCount, partial.
    let closeTicks = 0
    while (closeTicks < afterLabel.length && afterLabel[closeTicks] === '`') closeTicks++
    if (closeTicks < tickCount) return true
  }
  return false
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
