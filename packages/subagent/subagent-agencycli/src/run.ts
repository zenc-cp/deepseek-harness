/**
 * One-shot AgencyCLI child lifecycle: spawn `agencycli exec --no-session`
 * through the subprocess seam, settle collected stdout as the final answer,
 * and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-agencycli/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  credentialRef,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Default in-memory stdout cap for the one-shot exec collector. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/** Inputs for the fixed `agencycli exec` argv. */
export interface AgencycliArgvSpec {
  readonly command: string
  readonly cwd: string
  readonly project: string
  readonly agent: string
  readonly prompt: string
}

/** Fully resolved inputs for one AgencyCLI exec run. */
export interface AgencycliRunSpec {
  /** Executable used as argv[0]. */
  readonly command: string
  /** Workspace directory supplied as `--dir` and as the child cwd. */
  readonly cwd: string
  /** AgencyCLI project name. */
  readonly project: string
  /** AgencyCLI agent name. */
  readonly agent: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** In-memory stdout collector cap. */
  readonly maxOutputBytes: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/**
 * Build the fixed one-shot AgencyCLI argv. `--no-session` is required so a
 * DSH run cannot resume a saved AgencyCLI conversation.
 * @param spec - command, workspace, project, agent, and prompt.
 * @returns argv for `agencycli --dir <cwd> exec ... --no-session`.
 */
export function agencycliArgv(spec: AgencycliArgvSpec): string[] {
  return [
    spec.command,
    '--dir',
    spec.cwd,
    'exec',
    '--project',
    spec.project,
    '--agent',
    spec.agent,
    '--prompt',
    spec.prompt,
    '--no-session',
  ]
}

/**
 * Validate and concatenate the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact concatenated text.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-agencycli: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-agencycli: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-agencycli: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Resolve a deployment-owned child-env to credential-ref map. Only mapped
 * names are forwarded; unrelated store keys are never guessed or copied.
 * @param mapping - child environment name to DSH credential ref.
 * @param resolve - per-operation credential resolver.
 * @returns explicit child env entries for the mapped refs.
 */
export async function resolveCredentialEnv(
  mapping: Readonly<Record<string, string>>,
  resolve: (ref: CredentialRef) => Promise<ResolvedCredential | undefined>,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [envName, refName] of Object.entries(mapping)) {
    const ref = credentialRef(refName)
    credentialRef(envName)
    const hit = await resolve(ref)
    if (hit === undefined) {
      throw new Error(
        `subagent-agencycli: credential ref "${refName}" for child env "${envName}" is not configured`,
      )
    }
    env[envName] = hit.value
  }
  return env
}

/**
 * Terminate the managed process tree and wait for the subprocess owner to
 * prove it is gone.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeAgencycliChild(child: SubprocessHandle): Promise<void> {
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  child.terminate()
  await child.waitForExit()
  await child.done.catch(() => {})
}

/**
 * Start `agencycli exec --no-session` and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - workspace, environment, process service, and diagnostic policy.
 * @returns the published run after spawn.
 */
export function startAgencycliRun(
  request: SubagentStartRequest,
  spec: AgencycliRunSpec,
): SubagentRun {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-agencycli: request was aborted before agencycli startup')
  }

  const child = spec.spawn({
    argv: agencycliArgv({
      command: spec.command,
      cwd: spec.cwd,
      project: spec.project,
      agent: spec.agent,
      prompt,
    }),
    cwd: spec.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: spec.maxOutputBytes },
      stderr: 'inherit',
    },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
    signal: request.signal,
  })

  const flags = { cancelled: false }
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    if (child.pid > 0) child.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = (): ContentBlock[] => {
    const text = child.collected.stdout?.readFrom(0).text ?? ''
    return text.length === 0 ? [] : [{ type: 'text', text }]
  }

  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      const outcome = await child.done
      if (outcome.exitCode !== 0) {
        throw new Error(
          `subagent-agencycli: agencycli exited with code ${String(outcome.exitCode)}`,
        )
      }
      return { output: collectOutput(), stopReason: 'completed' }
    },
    collectOutput,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeAgencycliChild(child),
  })
}
