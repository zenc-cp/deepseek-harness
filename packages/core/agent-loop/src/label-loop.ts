/**
 * Opt-in experimental label-loop adapter.
 *
 * Intercepts `llm/stream` to classify the first line of every model response
 * against a caller-declared label vocabulary. A stream whose label is missing or
 * wrong finishes with a synthetic `INVALID_LABEL` error, which the companion
 * `agent/request-error` waterfall detects and repairs by feeding the model its
 * draft back with a correction prompt.
 *
 * The default agent loop does NOT ship with this plugin — it is an opt-in
 * evaluation adapter for models with unreliable native tool-call blocks.
 *
 * @module dsh-agent-loop/label-loop
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { accumulateLabelProbe, classifyStreamingLabel } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Fires once during `agent/request` when a label-loop caller declares its
     * protocol vocabulary for the coming call. Label-loop `agent/request-error`
     * handlers read this to prepare the repair prompt.
     */
    'label-loop/declare'(vocabulary: LabelVocabulary): void
  }
}

/** One label vocabulary for an agent-loop turn. */
export interface LabelVocabulary {
  /** Case-sensitive labels the model may emit on the first line. */
  readonly allowedLabels: readonly string[]
  /** Labels that end the turn when detected. */
  readonly terminalLabels: readonly string[]
}

/** Label-loop plugin configuration. */
export interface LabelLoopOptions {
  /**
   * Maximum characters to probe for a label before declaring the stream
   * unlabeled (default 96 — generous enough for a provider thinking prelude).
   */
  probeMaxChars?: number

  /**
   * Default vocabulary for all model calls. Callers may override per-call by
   * emitting `label-loop/declare` during `agent/request`.
   */
  defaultVocabulary?: LabelVocabulary

  /**
   * When true, a label violation aborts the turn instead of retrying.
   * Use for strict evaluation suites that must not self-repair.
   */
  failFast?: boolean
}

/** Extended failure facts for label-protocol violations. */
export interface LabelProtocolFailure {
  readonly message: string
  readonly code: 'INVALID_LABEL'
  /** The raw accumulated text from the model draft. */
  readonly draftText?: string
  /** Human-readable explanation of the violation. */
  readonly violation?: string
}

/** Create and install the label-loop plugin. */
export function installLabelLoop(ctx: Context, options: LabelLoopOptions = {}): () => void {
  const probeMaxChars = options.probeMaxChars ?? 96
  const defaultVocabulary = options.defaultVocabulary
  const failFast = options.failFast ?? false

  let declaredVocabulary: LabelVocabulary | undefined = defaultVocabulary

  ctx.on('label-loop/declare', (vocabulary) => {
    declaredVocabulary = vocabulary
  })

  ctx.on('agent/request-error', ({ failure }) => {
    if (failure.code !== 'INVALID_LABEL') return undefined
    if (failFast) return undefined
    return { kind: 'retry' as const }
  })

  // Wrap llm/stream to classify labels. We replace the outer stream with a
  // buffering transform so the final finish chunk is rewritten when the label
  // check fails.
  ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const vocab = declaredVocabulary ?? defaultVocabulary
    if (!vocab || vocab.allowedLabels.length === 0) return next()

    const resolvedVocab = vocab

    async function* transform(): AsyncIterable<StreamChunk> {
      // Buffer all chunks from the downstream stream.
      const chunks: StreamChunk[] = []
      let labelBuf: string | null = ''

      for await (const chunk of next()) {
        labelBuf = accumulateLabelProbe(labelBuf, chunk)
        chunks.push(chunk)
      }

      // No chunks means downstream errored or aborted before yielding — pass
      // through whatever we got (nothing).
      if (chunks.length === 0) return

      // Find the last finish chunk.
      const finishIdx = chunks.findLastIndex(c => c.type === 'finish')
      if (finishIdx < 0) {
        // Stream ended without a finish — pass everything through and let the
        // assembler default to `{ kind: 'stop' }`.
        yield * chunks
        return
      }

      // Classify the accumulated text.
      const detected = labelBuf !== null
        ? classifyStreamingLabel(labelBuf, resolvedVocab.allowedLabels, true, probeMaxChars)
        : null

      if (detected !== null && detected !== undefined) {
        // Valid label — pass all chunks through unchanged.
        yield * chunks
        return
      }

      // Label missing or unknown — rewrite the finish to an error.
      const draftText = labelBuf ?? ''
      const violation = detected === null
        ? `no recognized label found among ${resolvedVocab.allowedLabels.join(', ')}`
        : 'label not detected'

      const failure: LabelProtocolFailure = {
        message: 'label-loop: model response did not begin with a required label',
        code: 'INVALID_LABEL',
        draftText,
        violation,
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] ?? { type: 'block-start' as const, index: 0, blockType: 'text' as const }
        if (chunk.type === 'finish') {
          yield {
            type: 'finish' as const,
            reason: { kind: 'error' as const, failure },
          }
        } else {
          yield chunk
        }
      }
    }

    return transform()
  })

  return () => {
    declaredVocabulary = undefined
  }
}
