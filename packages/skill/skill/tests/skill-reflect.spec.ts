import { describe, expect, it } from 'vitest'
import {
  checkReflectPromotion,
  extractReflectSignals,
  fingerprintLearning,
  mapReflectSection,
  planReflectApply,
  proposeReflectSkillUpdate,
  recordReflectLearning,
  REFLECT_CONTEXT_WINDOW,
  REFLECT_PROMOTION_THRESHOLD,
  type ReflectTranscriptMessage,
} from '@deepseek-ai/dsh-skill'

const invoked = ['systematic-debugging'] as const

function transcript(...messages: ReflectTranscriptMessage[]): readonly ReflectTranscriptMessage[] {
  return messages
}

describe('reflect correction signals', () => {
  it('maps confidence to skill sections', () => {
    expect(mapReflectSection('HIGH')).toBe('Critical Corrections')
    expect(mapReflectSection('MEDIUM')).toBe('Best Practices')
    expect(mapReflectSection('LOW')).toBe('Considerations')
  })

  it('extracts a HIGH correction with a 5-message window and invoked skills', () => {
    const messages = transcript(
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'assistant', content: 'I will use var.' },
      { role: 'user', content: 'try let first' },
      { role: 'assistant', content: 'Using var again.' },
      { role: 'user', content: 'check types' },
      { role: 'assistant', content: 'Still using var.' },
      { role: 'user', content: 'Don\'t do var, use const instead' },
    )

    const signals = extractReflectSignals(messages, invoked)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      confidence: 'HIGH',
      type: 'correction',
      skills: ['systematic-debugging'],
      section: 'Critical Corrections',
    })
    expect(signals[0]?.context).toHaveLength(REFLECT_CONTEXT_WINDOW)
    expect(signals[0]?.context.at(-1)?.content).toBe('Don\'t do var, use const instead')
    expect(signals[0]?.fingerprint).toBe(fingerprintLearning('Don\'t do var, use const instead'))
  })

  it('treats contextual approval as MEDIUM and ignores a bare yes', () => {
    const messages = transcript(
      { role: 'assistant', content: 'I used const and ran the tests.' },
      { role: 'user', content: 'yes' },
      { role: 'assistant', content: 'I also added a lockfile.' },
      { role: 'user', content: 'yes, that\'s exactly right' },
    )

    const signals = extractReflectSignals(messages, invoked)
    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      confidence: 'MEDIUM',
      type: 'approval',
      section: 'Best Practices',
    })
  })

  it('records LOW questions as considerations', () => {
    const signals = extractReflectSignals(transcript(
      { role: 'assistant', content: 'I used a mutex.' },
      { role: 'user', content: 'Have you considered a lockfile instead?' },
    ), invoked)
    expect(signals).toEqual([expect.objectContaining({
      confidence: 'LOW',
      type: 'question',
      section: 'Considerations',
    })])
  })

  it('prefers HIGH over MEDIUM on the same user turn', () => {
    const signals = extractReflectSignals(transcript(
      { role: 'user', content: 'Don\'t do var, use const instead. That\'s perfect.' },
    ), invoked)
    expect(signals.map(signal => signal.confidence)).toEqual(['HIGH'])
  })

  it('falls back to general when no valid skills were invoked', () => {
    const signals = extractReflectSignals(transcript(
      { role: 'user', content: 'Never use eval' },
    ), ['Not A Skill'])
    expect(signals[0]?.skills).toEqual(['general'])
  })
})

describe('reflect fingerprint ledger', () => {
  it('normalizes fingerprint text', () => {
    expect(fingerprintLearning('  Never   USE  eval  ')).toBe(fingerprintLearning('never use eval'))
    expect(fingerprintLearning('never use eval')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('promotes only after the same fingerprint appears in two scopes', () => {
    const signal = extractReflectSignals(transcript(
      { role: 'user', content: 'Always use const' },
    ), invoked)[0]
    if (signal === undefined) throw new Error('expected a signal')

    const once = recordReflectLearning([], signal, 'repo-a')
    expect(checkReflectPromotion(once, signal.fingerprint)).toEqual({
      fingerprint: signal.fingerprint,
      eligible: false,
      scopeCount: 1,
      reason: `seen in 1 scope; need ${REFLECT_PROMOTION_THRESHOLD}`,
    })

    const twiceSameScope = recordReflectLearning(once, signal, 'repo-a')
    expect(checkReflectPromotion(twiceSameScope, signal.fingerprint).eligible).toBe(false)

    const twice = recordReflectLearning(once, signal, 'repo-b')
    expect(checkReflectPromotion(twice, signal.fingerprint)).toMatchObject({
      eligible: true,
      scopeCount: 2,
      reason: 'seen in 2 scopes',
    })
    expect(checkReflectPromotion([], 'deadbeefdeadbeef')).toEqual({
      fingerprint: 'deadbeefdeadbeef',
      eligible: false,
      scopeCount: 0,
      reason: `seen in 0 scopes; need ${REFLECT_PROMOTION_THRESHOLD}`,
    })
  })
})

describe('reflect apply gate', () => {
  it('proposes a sectioned update that still cannot write a skill', () => {
    const signal = extractReflectSignals(transcript(
      { role: 'user', content: 'Instead of var, use const' },
    ), invoked)[0]
    if (signal === undefined) throw new Error('expected a signal')

    const proposal = proposeReflectSkillUpdate(signal)
    expect(proposal).toEqual({
      skill: 'systematic-debugging',
      signal,
      section: 'Critical Corrections',
      approvalRequired: true,
      writesSkill: false,
    })

    expect(planReflectApply(proposal, { granted: false })).toEqual({
      status: 'blocked',
      reason: 'explicit approval is required before applying a reflect update',
      requiresBackup: true,
      requiresYamlValidation: true,
      requiresLock: true,
      writesSkill: false,
    })
    expect(planReflectApply(proposal, { granted: true })).toEqual({
      status: 'preview',
      reason: 'filesystem apply remains outside this helper',
      requiresBackup: true,
      requiresYamlValidation: true,
      requiresLock: true,
      writesSkill: false,
    })
  })
})
