/**
 * Filesystem-neutral skill-authoring SOP audit.
 *
 * Steal of HKUDS/CLI-Anything's program-in-prose harness: explicit phases with
 * deliverables and checks, plus progressive disclosure of bulky detail.
 * This module never writes SKILL.md, installs a skill, or mutates a catalog.
 */

/** Required labeled fields inside a complex-skill phase. */
export const COMPLEX_SKILL_PHASE_FIELDS = [
  'Input',
  'Actions',
  'Output',
  'Verify',
  'On failure',
] as const

export type ComplexSkillPhaseField = (typeof COMPLEX_SKILL_PHASE_FIELDS)[number]

/** One phase after the SOP audit. */
export interface SkillAuthoringPhaseAudit {
  readonly index: number
  readonly name: string
  readonly missing: readonly ComplexSkillPhaseField[]
}

/** Result of inspecting a skill body. Never performs a write or install. */
export interface SkillAuthoringAudit {
  readonly kind: 'simple' | 'complex'
  readonly ok: boolean
  readonly phases: readonly SkillAuthoringPhaseAudit[]
  readonly missingCompletion: boolean
  readonly writesSkill: false
  readonly installsSkill: false
  readonly reasons: readonly string[]
}

const PHASE_HEADING = /^(#{2,6})[ \t]+Phase(?:[ \t]+(\d+))?[ \t]*:[ \t]*(.*?)[ \t]*$/gim
const ANY_PHASE_HEADING = /^#{2,6}[ \t]+Phase\b/im
const COMPLETION = /^(?:#{2,6}\s+)?(?:Completion|Terminal success|Done when|Success condition)\b/im
const FIELD_ALIASES: Record<ComplexSkillPhaseField, readonly string[]> = {
  Input: ['input'],
  Actions: ['actions', 'action'],
  Output: ['output'],
  Verify: ['verify', 'verification'],
  'On failure': ['on failure', 'failure recovery', 'failure'],
}

/**
 * Classify a skill body as simple or complex and fail closed on incomplete
 * phases. Simple skills (no Phase heading) stay concise.
 * @param markdown - SKILL.md text, with or without frontmatter.
 * @returns an audit that never writes or installs.
 */
export function auditSkillAuthoring(markdown: string): SkillAuthoringAudit {
  const body = stripFrontmatter(markdown)
  if (!ANY_PHASE_HEADING.test(body)) {
    return {
      kind: 'simple',
      ok: true,
      phases: [],
      missingCompletion: false,
      writesSkill: false,
      installsSkill: false,
      reasons: [],
    }
  }

  const phases = parsePhases(body)
  const missingCompletion = !COMPLETION.test(body)
  const reasons: string[] = []
  if (phases.length === 0) reasons.push('complex skill has a Phase heading but no parseable Phase N: Name sections')
  for (const phase of phases) {
    if (phase.missing.length > 0) {
      reasons.push(`Phase ${phase.index} (${phase.name}) missing ${phase.missing.join(', ')}`)
    }
  }
  if (missingCompletion) reasons.push('complex skill missing a terminal completion condition')

  return {
    kind: 'complex',
    ok: reasons.length === 0,
    phases,
    missingCompletion,
    writesSkill: false,
    installsSkill: false,
    reasons,
  }
}

/**
 * Draft a complex operational skill body that satisfies {@link auditSkillAuthoring}.
 * Callers own staging and installation; this function only returns text.
 * @param name - kebab-case skill name for frontmatter.
 * @param phaseNames - ordered phase titles.
 * @returns SKILL.md text that never touches the filesystem.
 */
export function draftComplexSkillTemplate(name: string, phaseNames: readonly string[]): string {
  const titles = phaseNames.length > 0 ? phaseNames : ['First']
  const phases = titles.map((title, index) => {
    const n = index + 1
    const prior = index === 0
      ? 'Verified intent and named inputs from the user.'
      : `Named output of Phase ${index}.`
    return [
      `## Phase ${n}: ${title}`,
      '',
      `Input: ${prior}`,
      'Actions:',
      '1. Use a documented helper or available tool.',
      '2. Record the phase output.',
      `Output: ${title} artifact.`,
      `Verify: The ${title} artifact exists and matches the stated invariant.`,
      'On failure: Stop and report the unresolved condition. Do not continue.',
    ].join('\n')
  })
  return [
    '---',
    `name: ${name}`,
    `description: Use when running the ${name} operational workflow. Do not use for one-shot lookups.`,
    '---',
    '',
    'Read `references/ops.md` only when constructing the request.',
    '',
    ...phases,
    '',
    '## Completion',
    '',
    'Done when every phase output is verified and no irreversible action ran without approval.',
    '',
  ].join('\n')
}

/** Drop YAML frontmatter so phase headings in the body are the only structure. */
function stripFrontmatter(markdown: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(markdown)
  return match === null ? markdown : markdown.slice(match[0].length)
}

/** Split the body on Phase headings and record missing SOP fields. */
function parsePhases(body: string): SkillAuthoringPhaseAudit[] {
  const matches = [...body.matchAll(PHASE_HEADING)]
  return matches.map((match, index) => {
    const headingIndex = match.index
    const next = matches[index + 1]
    const section = body.slice(headingIndex, next === undefined ? body.length : next.index)
    const capturedName = (match[3] ?? '').trim()
    const name = capturedName === '' ? `Phase ${index + 1}` : capturedName
    const parsedIndex = match[2] === undefined ? index + 1 : Number(match[2])
    return {
      index: parsedIndex,
      name,
      missing: COMPLEX_SKILL_PHASE_FIELDS.filter(field => !hasField(section, field)),
    }
  })
}

/** Whether a phase section contains a non-empty labeled field. */
function hasField(section: string, field: ComplexSkillPhaseField): boolean {
  const aliases = FIELD_ALIASES[field]
  for (const alias of aliases) {
    const pattern = new RegExp(`^${escapeRegExp(alias)}\\s*:\\s*(?:\\S|\\r?\\n\\s*\\S)`, 'im')
    if (pattern.test(section)) return true
  }
  return false
}

/** Escape a literal so it is safe inside a constructed regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
