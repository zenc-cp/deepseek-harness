/**
 * Filesystem-neutral correction-to-skill proposals.
 *
 * Steal of haddock-development/claude-reflect-system: HIGH/MEDIUM/LOW
 * confidence, a 5-message window, a fingerprint ledger, and backup/YAML/lock
 * gates. This module never writes SKILL.md, installs a skill, or commits.
 */
import { createHash } from 'node:crypto'

/** Same kebab-case grammar as the registry `isSkillName` helper. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Inclusive transcript window around a signal, including the matching turn. */
export const REFLECT_CONTEXT_WINDOW = 5

/** Distinct scopes required before a fingerprint is eligible for promotion. */
export const REFLECT_PROMOTION_THRESHOLD = 2

/** Correction strength copied from the source skill's confidence bands. */
export type ReflectConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Skill section that a confidence band may propose, never auto-apply. */
export type ReflectSection = 'Critical Corrections' | 'Best Practices' | 'Considerations'

/** Detector class for a user turn. */
export type ReflectSignalType = 'correction' | 'approval' | 'question'

/** One transcript turn used for signal detection. */
export interface ReflectTranscriptMessage {
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
}

/** One detected learning signal with bounded surrounding context. */
export interface ReflectSignal {
  readonly confidence: ReflectConfidence
  readonly type: ReflectSignalType
  readonly content: string
  readonly context: readonly ReflectTranscriptMessage[]
  readonly skills: readonly [string, ...string[]]
  readonly fingerprint: string
  readonly section: ReflectSection
}

/** Approval-required proposal that cannot mutate a skill file. */
export interface ReflectSkillProposal {
  readonly skill: string
  readonly signal: ReflectSignal
  readonly section: ReflectSection
  readonly approvalRequired: true
  readonly writesSkill: false
}

/** Fingerprinted learning counted across opaque scope ids. */
export interface ReflectLedgerEntry {
  readonly fingerprint: string
  readonly content: string
  readonly skill: string
  readonly scopeIds: readonly string[]
  readonly count: number
  readonly confidence: ReflectConfidence
}

/** Promotion gate over distinct ledger scopes. */
export interface ReflectPromotionEligibility {
  readonly fingerprint: string
  readonly eligible: boolean
  readonly scopeCount: number
  readonly reason: string
}

/** Preview or blocked apply plan. Never performs the write. */
export interface ReflectApplyPlan {
  readonly status: 'blocked' | 'preview'
  readonly reason: string
  readonly requiresBackup: boolean
  readonly requiresYamlValidation: boolean
  readonly requiresLock: boolean
  readonly writesSkill: false
}

const SECTION_BY_CONFIDENCE = {
  HIGH: 'Critical Corrections',
  MEDIUM: 'Best Practices',
  LOW: 'Considerations',
} as const satisfies Record<ReflectConfidence, ReflectSection>

const HIGH_PATTERNS = [
  /don't\s+(?:do|use)\s+\S+/i,
  /instead\s+of\s+\S+/i,
  /never\s+(?:do|use)\s+\S+/i,
  /always\s+(?:do|use|check for)\s+\S+/i,
]

const MEDIUM_PATTERNS = [
  /that's\s+(?:perfect|great|exactly|correct)/i,
  /works?\s+(?:perfectly|great|well)/i,
  /(?:good|nice)\s+(?:job|work)/i,
]

const LOW_PATTERNS = [
  /have\s+you\s+considered\s+\S+/i,
  /why\s+not\s+(?:try|use)\s+\S+/i,
  /what\s+about\s+\S+/i,
]

const APPLY_SAFETY = {
  requiresBackup: true,
  requiresYamlValidation: true,
  requiresLock: true,
  writesSkill: false,
} as const

/**
 * Map a confidence band onto the skill section it may propose.
 * @param confidence - HIGH, MEDIUM, or LOW detector band.
 * @returns the section name an owning workflow may edit after approval.
 */
export function mapReflectSection(confidence: ReflectConfidence): ReflectSection {
  return SECTION_BY_CONFIDENCE[confidence]
}

/**
 * Stable 16-hex fingerprint of normalized learning text.
 * @param content - raw user turn or learning body.
 * @returns lowercase sha256 prefix after whitespace folding.
 */
export function fingerprintLearning(content: string): string {
  const normalized = content.toLowerCase().split(/\s+/).filter(part => part.length > 0).join(' ')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Detect at most one signal per user turn, preferring the highest confidence.
 * Bare affirmations such as "yes" are not signals.
 * @param messages - ordered transcript turns.
 * @param skillsInvoked - kebab-case skills used in the conversation.
 * @returns filesystem-neutral signals with a bounded context window.
 */
export function extractReflectSignals(
  messages: readonly ReflectTranscriptMessage[],
  skillsInvoked: readonly string[],
): readonly ReflectSignal[] {
  const skills = resolveSkills(skillsInvoked)
  const signals: ReflectSignal[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue
    const detected = detectUserTurn(message.content)
    if (detected === undefined) continue
    const start = Math.max(0, index - (REFLECT_CONTEXT_WINDOW - 1))
    signals.push({
      confidence: detected.confidence,
      type: detected.type,
      content: message.content,
      context: messages.slice(start, index + 1),
      skills,
      fingerprint: fingerprintLearning(message.content),
      section: mapReflectSection(detected.confidence),
    })
  }
  return signals
}

/**
 * Build an approval-gated proposal that still cannot write a skill.
 * @param signal - detected learning signal.
 * @returns a proposal bound to the first resolved skill name.
 */
export function proposeReflectSkillUpdate(signal: ReflectSignal): ReflectSkillProposal {
  return {
    skill: signal.skills[0],
    signal,
    section: signal.section,
    approvalRequired: true,
    writesSkill: false,
  }
}

/**
 * Record a fingerprint against one opaque scope id.
 * @param ledger - existing immutable entries.
 * @param signal - detected learning signal.
 * @param scopeId - caller-supplied scope, typically a repo identity.
 * @returns a new ledger array; same-scope repeats increment count only.
 */
export function recordReflectLearning(
  ledger: readonly ReflectLedgerEntry[],
  signal: ReflectSignal,
  scopeId: string,
): readonly ReflectLedgerEntry[] {
  const existing = ledger.find(entry => entry.fingerprint === signal.fingerprint)
  if (existing === undefined) {
    return [...ledger, {
      fingerprint: signal.fingerprint,
      content: signal.content,
      skill: signal.skills[0],
      scopeIds: [scopeId],
      count: 1,
      confidence: signal.confidence,
    }]
  }
  const scopeIds = existing.scopeIds.includes(scopeId) ? existing.scopeIds : [...existing.scopeIds, scopeId]
  return ledger.map(entry => entry.fingerprint === signal.fingerprint
    ? { ...entry, scopeIds, count: entry.count + 1 }
    : entry)
}

/**
 * Decide whether a fingerprint has been seen in enough distinct scopes.
 * @param ledger - recorded learnings.
 * @param fingerprint - 16-hex learning fingerprint.
 * @param threshold - distinct-scope floor; defaults to {@link REFLECT_PROMOTION_THRESHOLD}.
 * @returns eligibility plus a machine-readable reason.
 */
export function checkReflectPromotion(
  ledger: readonly ReflectLedgerEntry[],
  fingerprint: string,
  threshold = REFLECT_PROMOTION_THRESHOLD,
): ReflectPromotionEligibility {
  const scopeCount = ledger.find(entry => entry.fingerprint === fingerprint)?.scopeIds.length ?? 0
  const eligible = scopeCount >= threshold
  return {
    fingerprint,
    eligible,
    scopeCount,
    reason: eligible
      ? `seen in ${scopeCount} scopes`
      : `seen in ${scopeCount} scope${scopeCount === 1 ? '' : 's'}; need ${threshold}`,
  }
}

/**
 * Plan a safe apply. Approval only unlocks a preview; this helper never writes.
 * @param proposal - non-writing approval-gated proposal.
 * @param approval - explicit grant from the owning workflow.
 * @returns blocked or preview plan with backup/YAML/lock requirements.
 */
export function planReflectApply(
  proposal: ReflectSkillProposal,
  approval: { readonly granted: boolean },
): ReflectApplyPlan {
  if (!approval.granted) {
    return {
      status: 'blocked',
      reason: 'explicit approval is required before applying a reflect update',
      ...APPLY_SAFETY,
      writesSkill: proposal.writesSkill,
    }
  }
  return {
    status: 'preview',
    reason: 'filesystem apply remains outside this helper',
    ...APPLY_SAFETY,
    writesSkill: proposal.writesSkill,
  }
}

function resolveSkills(skillsInvoked: readonly string[]): readonly [string, ...string[]] {
  const valid = skillsInvoked.filter(name => name === 'general' || SKILL_NAME.test(name))
  const first = valid[0]
  if (first === undefined) return ['general']
  return [first, ...valid.slice(1)]
}

function detectUserTurn(content: string): { confidence: ReflectConfidence; type: ReflectSignalType } | undefined {
  if (matchesAny(HIGH_PATTERNS, content)) return { confidence: 'HIGH', type: 'correction' }
  if (matchesAny(MEDIUM_PATTERNS, content)) return { confidence: 'MEDIUM', type: 'approval' }
  if (matchesAny(LOW_PATTERNS, content)) return { confidence: 'LOW', type: 'question' }
  return undefined
}

function matchesAny(patterns: readonly RegExp[], content: string): boolean {
  return patterns.some(pattern => pattern.test(content))
}
