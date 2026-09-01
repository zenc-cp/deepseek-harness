import { describe, expect, it } from 'vitest'
import {
  auditSkillAuthoring,
  draftComplexSkillTemplate,
} from '@deepseek-ai/dsh-skill'

const SIMPLE = `---
name: lookup-term
description: Look up one glossary term. Use when the user names a term. Do not use for multi-step ops.
---

Return the matching glossary row. Do not invent a definition.
`

const COMPLEX = `---
name: staged-deploy
description: Use when shipping a staged deploy across two hosts. Do not use for local-only edits.
---

## Phase 1: Build

Input: Tagged source revision from the user.
Actions:
1. Run the package test command.
2. Write the artifact digest.
Output: Artifact digest file.
Verify: Test command exits 0 and the digest file exists.
On failure: Stop and report the failing test. Do not upload.

## Phase 2: Upload

Input: Artifact digest file from Phase 1.
Actions:
1. Upload only after explicit user approval.
Output: Remote object URL.
Verify: HEAD of the URL returns 200.
On failure: Leave the remote prefix unchanged and report the URL that failed.

## Completion

Done when the remote object URL is verified and no unsigned host was contacted.
`

describe('skill authoring SOP audit', () => {
  it('keeps a simple skill concise without requiring phases', () => {
    const audit = auditSkillAuthoring(SIMPLE)
    expect(audit).toMatchObject({
      kind: 'simple',
      ok: true,
      writesSkill: false,
      installsSkill: false,
    })
    expect(audit.phases).toEqual([])
    expect(audit.reasons).toEqual([])
  })

  it('accepts a complex skill whose phases name input, output, verify, and recovery', () => {
    const audit = auditSkillAuthoring(COMPLEX)
    expect(audit.kind).toBe('complex')
    expect(audit.ok).toBe(true)
    expect(audit.writesSkill).toBe(false)
    expect(audit.installsSkill).toBe(false)
    expect(audit.phases.map(phase => phase.name)).toEqual(['Build', 'Upload'])
    expect(audit.phases.every(phase => phase.missing.length === 0)).toBe(true)
    expect(audit.missingCompletion).toBe(false)
  })

  it('fails closed when a Phase heading is missing required fields', () => {
    const audit = auditSkillAuthoring(`## Phase 1: Vague

Do the thing somehow.
`)
    expect(audit.kind).toBe('complex')
    expect(audit.ok).toBe(false)
    expect(audit.phases[0]?.missing).toEqual([
      'Input',
      'Actions',
      'Output',
      'Verify',
      'On failure',
    ])
    expect(audit.missingCompletion).toBe(true)
    expect(audit.writesSkill).toBe(false)
    expect(audit.installsSkill).toBe(false)
  })

  it('drafts a complex template that the auditor accepts and never writes a file', () => {
    const drafted = draftComplexSkillTemplate('staged-deploy', ['Build', 'Upload'])
    const audit = auditSkillAuthoring(drafted)
    expect(audit.ok).toBe(true)
    expect(audit.kind).toBe('complex')
    expect(audit.writesSkill).toBe(false)
    expect(drafted).toContain('Read `references/')
  })

  it('fails closed when a Phase heading cannot be parsed as Phase N: Name', () => {
    const audit = auditSkillAuthoring('## Phase\n\nNo fields.\n')
    expect(audit.kind).toBe('complex')
    expect(audit.ok).toBe(false)
    expect(audit.phases).toEqual([])
    expect(audit.reasons[0]).toContain('no parseable')
  })

  it('drafts a default first phase when no titles are supplied', () => {
    const drafted = draftComplexSkillTemplate('ops-flow', [])
    const audit = auditSkillAuthoring(drafted)
    expect(audit.ok).toBe(true)
    expect(audit.phases[0]?.name).toBe('First')
  })

  it('numbers an unnumbered Phase: Name heading from document order', () => {
    const audit = auditSkillAuthoring(`## Phase: Inspect

Input: Named path.
Actions: Read the file.
Output: Digest.
Verify: Digest is 16 hex chars.
On failure: Stop.

## Completion
Done when the digest is recorded.
`)
    expect(audit.ok).toBe(true)
    expect(audit.phases[0]).toMatchObject({ index: 1, name: 'Inspect', missing: [] })
  })

  it('names an empty Phase heading from its position and accepts field aliases', () => {
    const audit = auditSkillAuthoring(`## Phase 1:

Input: Named path.
Action: Read the file.
Output: Digest.
Verification: Digest is 16 hex chars.
Failure recovery: Stop.

## Completion
Done when the digest is recorded.
`)
    expect(audit.ok).toBe(true)
    expect(audit.phases[0]?.name).toBe('Phase 1')
  })
})
