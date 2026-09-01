/**
 * agent-presets domain zod schemas (names derived from map keys:
 * agentPresetListRequestSchema / agentPresetListValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'
import type { PresetManifest, PresetManifestChange, PresetManifestDiff } from '@deepseek-ai/dsh-agent-presets'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { AgentPresetEntry } from './agent-presets.ts'

/** AgentPresetEntry row of agentPreset.list. */
export const agentPresetEntrySchema = z.object({
  id: z.string().min(1),
  trust: z.union([z.literal('system'), z.literal('user')]),
  isDefault: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  broken: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<AgentPresetEntry>>

/** agentPreset.list request payload. */
export const agentPresetListRequestSchema = z.object({
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.list'>>>

/** agentPreset.list response value. */
export const agentPresetListValueSchema = z.object({
  presets: z.array(agentPresetEntrySchema),
  authorable: z.boolean(),
  hasDocument: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.list'>>>

/** agentPreset.select request payload. */
export const agentPresetSelectRequestSchema = z.object({
  sessionId: sessionIdSchema,
  agentPreset: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.select'>>>

/** agentPreset.select response value. */
export const agentPresetSelectValueSchema = z.object({
  agentPreset: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.select'>>>

/** agentPreset.read request payload. */
export const agentPresetReadRequestSchema = z.object({
  agentPreset: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.read'>>>

/** agentPreset.read response value. */
export const agentPresetReadValueSchema = z.object({
  agentPreset: z.string(),
  trust: z.union([z.literal('system'), z.literal('user')]),
  content: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.read'>>>

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]))
const presetManifestSchema = z.object({
  version: z.literal(1),
  preset: z.object({ id: z.string(), trust: z.union([z.literal('system'), z.literal('user')]) }),
  rows: z.array(z.object({ id: z.string(), module: z.string(), enabled: z.boolean(), config: jsonValueSchema })),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  promptSections: z.array(z.object({ name: z.string() })),
  services: z.array(z.string()),
}) satisfies z.ZodType<Wire<PresetManifest>>
const presetManifestChangeSchema = z.object({
  path: z.string(), before: jsonValueSchema.optional(), after: jsonValueSchema.optional(),
}) satisfies z.ZodType<Wire<PresetManifestChange>>
const presetManifestDiffSchema = z.object({
  version: z.literal(1), changes: z.array(presetManifestChangeSchema),
}) satisfies z.ZodType<Wire<PresetManifestDiff>>

export const agentPresetInspectRequestSchema = z.object({ agentPreset: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.inspect'>>>
export const agentPresetInspectValueSchema = z.object({ manifest: presetManifestSchema }) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.inspect'>>>
export const agentPresetDiffRequestSchema = z.object({ before: z.string().min(1), after: z.string().min(1) }) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.diff'>>>
export const agentPresetDiffValueSchema = z.object({
  before: z.string(), after: z.string(), diff: presetManifestDiffSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.diff'>>>

/** agentPreset.copy request payload. */
export const agentPresetCopyRequestSchema = z.object({
  from: z.string().min(1),
  agentPreset: z.string().min(1),
  name: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.copy'>>>

/** agentPreset.copy response value. */
export const agentPresetCopyValueSchema = z.object({
  agentPreset: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.copy'>>>

/** agentPreset.openDocument request payload. */
export const agentPresetOpenDocumentRequestSchema = z.object({
  agentPreset: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.openDocument'>>>

/** agentPreset.openDocument response value. */
export const agentPresetOpenDocumentValueSchema = z.union([
  z.object({ opened: z.literal(true) }),
  z.object({ opened: z.literal(false), path: z.string() }),
]) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.openDocument'>>>

/** agentPreset.remove request payload. */
export const agentPresetRemoveRequestSchema = z.object({
  agentPreset: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'agentPreset.remove'>>>

/** agentPreset.remove response value. */
export const agentPresetRemoveValueSchema = z.object({
}) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.remove'>>>
