import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/**
 * Minimal concrete service: a hand-built handle. The seam is spawn-only —
 * defaulting, shell semantics, and deadlines belong to callers — so this stub
 * is all an implementation owes the abstract class.
 */
class StubSubprocessRuntime extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> {
    return `/bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const read: SubprocessOutputRead = { text: '', nextOffset: 0, lossy: false }
    const collected = spec.stdio.stdout !== 'pipe' && spec.stdio.stdout !== 'inherit'
      ? { stdout: { readFrom: () => read } }
      : {}
    return {
      pid: spec.argv.length,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

describe('Git indexed environment scrubbing', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'],
    ['git_config_count', 'git_config_key_0', 'git_config_value_0'],
    ['Git_Config_Count', 'Git_Config_Key_12', 'Git_Config_Value_12'],
  ])('removes the entire ambient indexed family starting with %s', (count, key, value) => {
    vi.stubEnv(count, '1')
    vi.stubEnv(key, 'http.extraHeader')
    vi.stubEnv(value, 'Authorization: synthetic-test-only')
    vi.stubEnv('SCRUB_PROBE_PLAIN', 'visible')

    const env = scrubbedParentEnv()
    const indexedNames = Object.keys(env).filter(name => /^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/i.test(name))
    expect(indexedNames).toEqual([])
    expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
    expect(env.PATH).toBeDefined()
  })

  it('also removes orphaned values and malformed counts without parsing their contents', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', 'invalid-count')
    vi.stubEnv('GIT_CONFIG_KEY_0', undefined)
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'synthetic-orphan')
    vi.stubEnv('GIT_CONFIG_VALUE_999', 'synthetic-out-of-range')
    const env = scrubbedParentEnv()
    expect(Object.keys(env).filter(name => /^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/i.test(name))).toEqual([])
  })

  it('preserves unrelated Git controls', () => {
    vi.stubEnv('GIT_TERMINAL_PROMPT', '0')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const env = scrubbedParentEnv()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })

  it('lets Git parse configuration after sanitizing a synthetic indexed entry', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'test.scrubProbe')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'synthetic-test-only')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-scrub-git-'))
    const config = join(dir, 'empty.gitconfig')
    try {
      writeFileSync(config, '')
      const result = spawnSync('git', ['config', '--list'], {
        cwd: dir,
        env: { ...scrubbedParentEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config },
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)

      // Explicit, complete overrides still belong to the caller after the scrub.
      const explicit = spawnSync('git', ['config', '--get', 'test.scrubProbe'], {
        cwd: dir,
        env: {
          ...scrubbedParentEnv(),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'test.scrubProbe',
          GIT_CONFIG_VALUE_0: 'explicit-test-value',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(explicit.error).toBeUndefined()
      expect(explicit.status, explicit.stderr).toBe(0)
      expect(explicit.stdout.trim()).toBe('explicit-test-value')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SubprocessRuntime seam', () => {
  it('a concrete subclass registers as ctx.subprocess and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    const handle = ctx.subprocess.spawn({
      argv: ['true'],
      cwd: '/stub',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: 'inherit' },
      graceMs: 1,
    })
    expect(handle.pid).toBe(1)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })

  it('loading a second implementation throws (one subprocess service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    class SecondService extends StubSubprocessRuntime {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "subprocess" has been registered/)
  })

  it('scrubbedParentEnv drops credential-shaped and DSH_ names (case-insensitively) but keeps PATH', () => {
    process.env.DSH_SCRUB_PROBE = 'stale'
    process.env.dsh_scrub_probe_lower = 'stale'
    process.env.SCRUB_PROBE_TOKEN = 'secret'
    process.env.SCRUB_PROBE_PASSWORD = 'secret'
    process.env.SCRUB_PROBE_PLAIN = 'visible'
    try {
      const env = scrubbedParentEnv()
      expect(env.DSH_SCRUB_PROBE).toBeUndefined()
      expect(env.dsh_scrub_probe_lower).toBeUndefined()
      expect(env.SCRUB_PROBE_TOKEN).toBeUndefined()
      expect(env.SCRUB_PROBE_PASSWORD).toBeUndefined()
      expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.DSH_SCRUB_PROBE
      delete process.env.dsh_scrub_probe_lower
      delete process.env.SCRUB_PROBE_TOKEN
      delete process.env.SCRUB_PROBE_PASSWORD
      delete process.env.SCRUB_PROBE_PLAIN
    }
  })
})
