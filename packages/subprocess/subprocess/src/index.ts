/**
 * Service Definition for the subprocess capability seam (`ctx.subprocess`): execution-world executable lookup,
 * fully specified managed process trees with raw or
 * collected stdio, and one terminal-process primitive. Command defaulting,
 * shell semantics, deadlines, protocol framing, terminal readiness, and
 * presentation belong to consumers. The local implementation lives in
 * `@deepseek-ai/dsh-subprocess-local`.
 * @module @deepseek-ai/dsh-subprocess
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { proxyEnvironmentForChild } from '@deepseek-ai/dsh-http-proxy'
import { DSH_ENV_PREFIX } from './types.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from './types.ts'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessStdinMode,
  SubprocessStdio,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from './types.ts'

/**
 * Credential-shaped environment names are NOT forwarded to children (the
 * harness's own `DEEPSEEK_API_KEY`/secrets must not leak into a spawned
 * process implicitly). One heuristic for every in-repo spawner; a
 * deliberately supplied entry survives because explicit env layers merge
 * after the scrub.
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

const INHERITED_GIT_IDENTITY_COMMANDS = new Set([
  'blame', 'branch', 'config', 'describe', 'log', 'reflog', 'remote',
  'rev-parse', 'shortlog', 'stash', 'submodule', 'tag', 'worktree',
])

/**
 * The ambient parent environment minus credential-shaped names and minus all
 * `DSH_*` names — the canonical base every harness child starts from. `PATH`,
 * `HOME`, locale, and proxy variables survive, so child CLIs run normally;
 * harness identity never leaks implicitly (a deliberately forwarded
 * credential or current `DSH_*` fact goes through the spec's explicit `env`,
 * which merges after this scrub). Both scrubs match case-insensitively:
 * Windows environment names are case-insensitive, so a parent `dsh_*` entry
 * would otherwise survive and read back as `$env:DSH_*` in the child;
 * deliberate lowercase `dsh_*` names on POSIX are implausible. Exported as a plain function so spawners
 * that cannot route through the service (node-pty backends, SDK-managed
 * transports) share the one scrub definition.
 *
 * When a proxy is active the result also carries the resolved proxy names and the flag a child Node
 * needs to honor them, so a child inherits the same routing as its parent.
 * Inherited Git count/key/value entries are preserved atomically for approved path
 * settings, restrictive launcher controls, and exact known identity aliases.
 * Other settings, malformed groups, and the opaque
 * GIT_CONFIG_PARAMETERS carrier fail closed before explicit overrides merge.
 * @throws Error without configuration values when inherited Git configuration is unsupported or incomplete.
 * @returns a fresh environment object safe to hand to a child spawn.
 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const git = new Map<string, string>()
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    const normalized = key.toUpperCase()
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_.*)$/.test(normalized)) {
      if (git.has(normalized)) throw inheritedGitConfigError()
      git.set(normalized, value)
    } else if (!SENSITIVE_ENV_PATTERN.test(key) && !normalized.startsWith(DSH_ENV_PREFIX)) {
      env[key] = value
    }
  }
  if (git.size > 0) {
    const rawCount = git.get('GIT_CONFIG_COUNT')
    const count = Number(rawCount)
    // Check size before iterating so an untrusted count cannot cause an unbounded loop.
    if (rawCount === undefined || !/^(0|[1-9][0-9]*)$/.test(rawCount)
      || !Number.isSafeInteger(count) || git.size !== 1 + count * 2) throw inheritedGitConfigError()
    env.GIT_CONFIG_COUNT = rawCount
    for (let i = 0; i < count; i++) {
      const key = git.get(`GIT_CONFIG_KEY_${i}`)
      const value = git.get(`GIT_CONFIG_VALUE_${i}`)
      if (key === undefined || value === undefined
        || !supportedInheritedGitSetting(key, value)) throw inheritedGitConfigError()
      env[`GIT_CONFIG_KEY_${i}`] = key
      env[`GIT_CONFIG_VALUE_${i}`] = value
    }
  }
  // A child Node ignores the inherited proxy variables unless the flag this adds is set, so an MCP
  // stdio server or subagent CLI would connect directly while its parent proxies. The same overlay
  // restores each proxy name to what the user exported, undoing this process's own normalization —
  // `undefined` removes a name the user never set.
  for (const [name, value] of Object.entries(proxyEnvironmentForChild())) {
    if (value === undefined) Reflect.deleteProperty(env, name)
    else env[name] = value
  }
  return env
}

function supportedInheritedGitSetting(key: string, value: string): boolean {
  const normalized = key.toLowerCase()
  if (normalized === 'safe.directory' || normalized === 'core.hookspath') return true
  if (normalized === 'safe.barerepository') return value === 'explicit'
  if (normalized === 'credential.interactive') return value === 'never'
  if (!normalized.startsWith('alias.')) return false
  const command = normalized.slice('alias.'.length)
  return INHERITED_GIT_IDENTITY_COMMANDS.has(command) && value === command
}

function inheritedGitConfigError(): Error {
  return new Error('Unsupported or incomplete inherited Git configuration')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subprocess: SubprocessRuntime
  }
}

/**
 * Abstract subprocess service. Subclass, implement {@link spawn}, and load the
 * subclass as a plugin — it registers as `ctx.subprocess` (one implementation
 * per context; loading a second throws, which is cordis' standard
 * duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - Executable paths belong to one execution world shared with the mounted
 *   filesystem provider.
 * - {@link spawn} returns immediately with a live handle; `done` resolves at
 *   process close with exit facts and rejects only for spawn-level failures.
 * - Collect-mode readers are offset-based and non-consuming, so independent
 *   readers never consume one another's output; lossy reads report truncation
 *   and the spill file holding the complete stream when one exists. Piped
 *   streams are handed to the caller raw and never buffered here.
 * - {@link SubprocessHandle.terminate} (and the spec's abort signal) escalates
 *   SIGTERM→grace→SIGKILL — the only termination verb — tree-scoped on every
 *   platform. {@link SubprocessHandle.waitForExit} observes whole-tree
 *   liveness, so a consumer-owned teardown ladder can hold each tier on real
 *   quiescence.
 * - Disposal of the service terminates all still-running managed processes
 *   and awaits their exit.
 * - {@link spawnTerminal} owns terminal allocation, text transport,
 *   foreground groups, signalling, and whole-session quiescence behind one
 *   awaited termination method; readiness and persistent-shell policy stay
 *   in the PTY consumer. Its output stream ends after queued terminal output
 *   when the top-level process exits.
 */
export abstract class SubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  /**
   * Resolve one configured executable in this provider's execution world.
   * Absolute paths are verified; bare names use the provider's scrubbed PATH
   * plus explicit environment overrides. Relative paths containing separators
   * are rejected: the resolution base is undefined, so providers fail loud
   * instead of guessing.
   * @param command - absolute executable path or bare PATH name.
   * @param env - explicit environment entries used for lookup.
   * @param signal - aborts remote or local lookup.
   * @returns a canonical executable path.
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>

  /**
   * Start one managed child process from a fully-specified spec; this seam
   * applies no defaults.
   * @param spec - argv, directory, stdio dispositions, grace, cancellation, and environment.
   * @returns the live process handle (streams/readers, signalling, outcome promise).
   */
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle

  /**
   * Allocate a real terminal and start one owned process session. This is the
   * only non-pipe process primitive: implementations own terminal byte I/O,
   * foreground groups, signals, and complete session-tree cleanup.
   * @param spec - fully specified argv, cwd, environment, dimensions, grace, and allocation cancellation.
   * @returns the live terminal handle after allocation succeeds.
   */
  abstract spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>
}

export default SubprocessRuntime
