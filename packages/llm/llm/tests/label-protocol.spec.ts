/**
 * Covers the streaming label classifier and the repair-prompt builder.
 */
import { describe, expect, it } from 'vitest'
import {
  accumulateLabelProbe,
  classifyStreamingLabel,
  labelProtocolRepairPrompt,
} from '@deepseek-ai/dsh-llm'

describe('classifyStreamingLabel', () => {
  const allowed = ['FINISH', 'TOOL', 'THINK']

  it('detects a backtick-wrapped label and returns the body offset', () => {
    const result = classifyStreamingLabel('``FINISH`` Hello world', allowed, false, 64)
    expect(result).not.toBeNull()
    expect(result).not.toBeUndefined()
    if (result) {
      expect(result.label).toBe('FINISH')
      expect(result.bodyOffset).toBeGreaterThan(0)
    }
  })

  it('returns undefined while the buffer is still ambiguous', () => {
    const result = classifyStreamingLabel('``FI', allowed, false, 64)
    expect(result).toBeUndefined()
  })

  it('returns null when the buffer exceeds the probe ceiling without a match', () => {
    const longPrefix = 'x'.repeat(70)
    const result = classifyStreamingLabel(longPrefix, allowed, false, 64)
    expect(result).toBeNull()
  })

  it('accepts a single-backtick wrapping', () => {
    const result = classifyStreamingLabel('`THINK` ok', allowed, false, 64)
    expect(result).not.toBeNull()
    if (result) expect(result.label).toBe('THINK')
  })

  it('accepts a bare label with trailing whitespace', () => {
    const result = classifyStreamingLabel('FINISH\nbody', allowed, false, 64)
    expect(result).not.toBeNull()
    if (result) expect(result.label).toBe('FINISH')
  })

  it('accepts a bare label at stream end (final=true)', () => {
    const result = classifyStreamingLabel('TOOL', allowed, true, 64)
    expect(result).not.toBeNull()
    if (result) expect(result.label).toBe('TOOL')
  })

  it('does not false-positive on a label-like body token', () => {
    const result = classifyStreamingLabel('FINISHED that task', allowed, false, 64)
    expect(result).toBeNull()
  })

  it('ignores leading whitespace and zero-width chars', () => {
    const result = classifyStreamingLabel('   ``THINK`` next', allowed, false, 64)
    expect(result).not.toBeNull()
    if (result) expect(result.label).toBe('THINK')
  })

  it('returns null when no allowed label matches', () => {
    const result = classifyStreamingLabel('``OTHER`` hello', allowed, false, 64)
    expect(result).toBeNull()
  })
})

describe('accumulateLabelProbe', () => {
  it('accumulates text-delta and reasoning-delta only', () => {
    let buf: string | null = ''
    buf = accumulateLabelProbe(buf, { type: 'text-delta', index: 0, text: 'F' })
    buf = accumulateLabelProbe(buf, { type: 'reasoning-delta', index: 0, text: 'I' })
    buf = accumulateLabelProbe(buf, { type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(buf).toBe('FI')
  })

  it('stays null once null', () => {
    expect(accumulateLabelProbe(null, { type: 'text-delta', index: 0, text: 'x' })).toBeNull()
  })
})

describe('labelProtocolRepairPrompt', () => {
  it('names required labels and includes the model draft', () => {
    const prompt = labelProtocolRepairPrompt('bad output', ['FINISH', 'TOOL'], 'missing label')
    expect(prompt).toContain('``FINISH``')
    expect(prompt).toContain('``TOOL``')
    expect(prompt).toContain('bad output')
    expect(prompt).toContain('missing label')
  })

  it('returns empty string when allowed labels is empty', () => {
    expect(labelProtocolRepairPrompt('anything', [], 'violation')).toBe('')
  })
})