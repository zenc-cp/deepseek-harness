/**
 * Fixed AgencyCLI one-shot subagent provider. Every accepted run starts a
 * fresh `agencycli exec --no-session` process in the delegating Session's
 * workspace (or a configured cwd) and returns collected stdout as the answer.
 *
 * @module @deepseek-ai/dsh-subagent-agencycli
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  validateConfiguredCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  resolveCredentialEnv,
  startAgencycliRun,
  type AgencycliRunSpec,
} from './run.ts'

export const name = 'subagent-agencycli'
export const inject = ['subagents', 'subprocess']

/** Deployment-owned AgencyCLI target, environment, and process-release bound. */
export interface Config {
  /** Executable used as argv[0] (default `agencycli`). */
  command?: string
  /**
   * Working directory override for the child and `--dir`. A relative path
   * resolves against the harness launch directory at load. When omitted, each
   * child inherits its delegating parent session's cwd.
   */
  cwd?: string
  /** AgencyCLI project name (`--project`). */
  project: string
  /** AgencyCLI agent name (`--agent`). */
  agent: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Child environment name to DSH credential-ref map. Resolved per start;
   * unmapped store keys are never forwarded. Mapping is deployment config,
   * not a guessed default from Foundry/Caddy names.
   */
  credentialEnv?: Record<string, string>
  /** Grace in milliseconds for AgencyCLI process-tree termination. */
  disposeGraceMs?: number
  /** In-memory stdout collector cap in bytes. */
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default('agencycli'),
  cwd: z.string(),
  project: z.string().required(),
  agent: z.string().required(),
  env: z.dict(z.string()).default({}),
  credentialEnv: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
})

type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

class AgencycliProvider implements SubagentProvider {
  readonly name = 'agencycli'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    const cwd = this.config.cwd !== undefined
      ? resolveChildCwd('subagent-agencycli', this.config.cwd, parentCwd)
      : (() => {
        if (parentCwd === undefined) {
          throw new Error(
            'subagent-agencycli: no working directory for the child — delegate from a parent session that has one',
          )
        }
        return resolveChildCwd('subagent-agencycli', undefined, parentCwd)
      })()

    const mapped = Object.keys(this.config.credentialEnv).length === 0
      ? {}
      : await (async () => {
        const credentials = this.ctx.get('credentials')
        if (credentials === undefined) {
          throw new Error(
            'subagent-agencycli: credentialEnv is configured but the credentials service is not loaded',
          )
        }
        return resolveCredentialEnv(
          this.config.credentialEnv,
          ref => credentials.resolve(ref),
        )
      })()

    const spec: AgencycliRunSpec = {
      command: this.config.command,
      cwd,
      project: this.config.project,
      agent: this.config.agent,
      env: { ...this.config.env, ...mapped },
      disposeGraceMs: this.config.disposeGraceMs,
      maxOutputBytes: this.config.maxOutputBytes,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-agencycli: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startAgencycliRun(request, spec)
  }
}

/**
 * Register the fixed `agencycli` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - AgencyCLI target, credential mapping, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.command.trim().length === 0) {
    throw new Error('subagent-agencycli: command must be non-empty')
  }
  if (resolved.project.trim().length === 0 || resolved.agent.trim().length === 0) {
    throw new Error('subagent-agencycli: project and agent must be non-empty')
  }
  for (const [envName, refName] of Object.entries(resolved.credentialEnv)) {
    credentialRef(envName)
    credentialRef(refName)
  }
  assertPositiveFinite('subagent-agencycli', 'disposeGraceMs', resolved.disposeGraceMs)
  assertPositiveFinite('subagent-agencycli', 'maxOutputBytes', resolved.maxOutputBytes)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-agencycli: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const configuredCwd = validateConfiguredCwd('subagent-agencycli', resolved.cwd)
  const validated: ResolvedConfig = configuredCwd === undefined
    ? resolved
    : { ...resolved, cwd: configuredCwd }
  ctx.subagents.registerProvider(new AgencycliProvider(ctx, validated))
}
