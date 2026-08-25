/** Read-only, deterministic inspection records for resolved preset compositions. */

import type { Context } from '@deepseek-ai/cordis'
import type { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { AgentPreset } from './preset.ts'

/** Stable manifest format emitted by {@link buildPresetManifest}. */
export interface PresetManifest {
  readonly version: 1
  readonly preset: {
    readonly id: string
    readonly trust: AgentPreset['trust']
  }
  readonly rows: readonly PresetManifestRow[]
  readonly tools: readonly PresetManifestTool[]
  readonly promptSections: readonly PresetManifestPromptSection[]
  readonly services: readonly string[]
}

/** One resolved Loader row with secret-shaped configuration leaves redacted. */
export interface PresetManifestRow {
  readonly id: string
  readonly module: string
  readonly enabled: boolean
  readonly config?: JsonValue
}

/** One model-visible tool selected by the composition. */
export interface PresetManifestTool {
  readonly name: string
  readonly description: string
}

/** One resolved prompt section, without its potentially sensitive text. */
export interface PresetManifestPromptSection {
  readonly name: string
}

/** One path-addressed difference between two manifests. */
export interface PresetManifestChange {
  readonly path: string
  readonly before?: JsonValue
  readonly after?: JsonValue
}

/** Stable structured diff format. */
export interface PresetManifestDiff {
  readonly version: 1
  readonly changes: readonly PresetManifestChange[]
}

const SECRET_KEY = /(?:api[_-]?key|credential|password|secret|token)/i

/** Convert configuration to deterministic JSON while redacting credential-shaped leaves. */
function sanitize(value: unknown, key?: string): JsonValue {
  if (key !== undefined && SECRET_KEY.test(key)) return '[redacted]'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (Array.isArray(value)) return value.map(item => sanitize(item))
  if (typeof value !== 'object') return String(value)
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => [name, sanitize(item, name)]))
}

/** Services whose providers are owned by the mounted preset subtree. */
function serviceNames(ctx: Context, mountFiber: Context['fiber']): string[] {
  const names = new Set<string>()
  for (const key of Object.getOwnPropertySymbols(ctx.reflect.store)) {
    const implementation = ctx.reflect.store[key]
    if (implementation === undefined) continue
    let fiber = implementation.fiber
    while (true) {
      if (fiber === mountFiber) {
        names.add(implementation.name)
        break
      }
      const parent = fiber.parent.fiber
      if (parent === fiber) break
      fiber = parent
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

/**
 * Materialize a resolved composition without exposing prompt text, file paths,
 * or credential-shaped configuration values.
 */
export async function buildPresetManifest(
  ctx: Context,
  preset: AgentPreset,
  scope: ScopeKey,
  tree: EntryTree,
  mountFiber: Context['fiber'],
): Promise<PresetManifest> {
  const assembly = await ctx.systemPrompt.assemble({ scope })
  const rows = [...tree.entries()]
    .map((entry): PresetManifestRow => ({
      id: entry.options.id,
      module: entry.options.name,
      enabled: !entry.disabled,
      ...(entry.options.config === undefined ? {} : { config: sanitize(entry.options.config) }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    version: 1,
    preset: { id: preset.id, trust: preset.trust },
    rows,
    tools: assembly.tools
      .map(tool => ({ name: tool.name, description: tool.description }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    promptSections: assembly.sections
      .map(section => ({ name: section.name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    services: serviceNames(ctx, mountFiber),
  }
}

function indexed<T extends { readonly name?: string; readonly id?: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map(value => [value.name ?? value.id ?? '', value]))
}

function addNamedChanges<T extends { readonly name?: string; readonly id?: string }>(
  changes: PresetManifestChange[],
  path: string,
  before: readonly T[],
  after: readonly T[],
): void {
  const left = indexed(before)
  const right = indexed(after)
  const names = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    const oldValue = left.get(name)
    const newValue = right.get(name)
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue
    changes.push({
      path: `${path}.${name}`,
      ...(oldValue === undefined ? {} : { before: oldValue as unknown as JsonValue }),
      ...(newValue === undefined ? {} : { after: newValue as unknown as JsonValue }),
    })
  }
}

/** Compare two deterministic manifests without consulting live runtime state. */
export function diffPresetManifests(before: PresetManifest, after: PresetManifest): PresetManifestDiff {
  const changes: PresetManifestChange[] = []
  if (before.preset.id !== after.preset.id) {
    changes.push({ path: 'preset.id', before: before.preset.id, after: after.preset.id })
  }
  if (before.preset.trust !== after.preset.trust) {
    changes.push({ path: 'preset.trust', before: before.preset.trust, after: after.preset.trust })
  }
  addNamedChanges(changes, 'rows', before.rows, after.rows)
  addNamedChanges(changes, 'tools', before.tools, after.tools)
  addNamedChanges(changes, 'promptSections', before.promptSections, after.promptSections)
  const serviceRows = (values: readonly string[]) => values.map(name => ({ name }))
  addNamedChanges(changes, 'services', serviceRows(before.services), serviceRows(after.services))
  return { version: 1, changes }
}
