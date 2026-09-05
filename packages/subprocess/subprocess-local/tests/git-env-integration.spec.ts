import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSubprocess } from '../src/spawn.ts'

function launcherFixture() {
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_.*)$/i.test(name)) vi.stubEnv(name, undefined)
  }
  const commands = ['blame', 'branch', 'config', 'describe', 'log', 'reflog', 'remote', 'rev-parse', 'shortlog', 'stash', 'submodule', 'tag', 'worktree']
  vi.stubEnv('GIT_CONFIG_COUNT', '15')
  for (const [index, command] of commands.entries()) {
    vi.stubEnv(`GIT_CONFIG_KEY_${index}`, `alias.${command}`)
    vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, command)
  }
  vi.stubEnv('GIT_CONFIG_KEY_13', 'safe.bareRepository')
  vi.stubEnv('GIT_CONFIG_VALUE_13', 'explicit')
  vi.stubEnv('GIT_CONFIG_KEY_14', 'credential.interactive')
  vi.stubEnv('GIT_CONFIG_VALUE_14', 'never')
  vi.stubEnv('INTEGRATION_SECRET_TOKEN', 'synthetic-do-not-forward')
}

afterEach(() => vi.unstubAllEnvs())

const stdio = { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } } as const

describe('Git environment through real local subprocesses', () => {
  it('preserves all launcher pairs and excludes ambient credentials in a real child', async () => {
    launcherFixture()
    const script = 'const e=process.env; console.log(JSON.stringify({count:e.GIT_CONFIG_COUNT, keys:Array.from({length:15},(_,i)=>e["GIT_CONFIG_KEY_"+i]), values:Array.from({length:15},(_,i)=>e["GIT_CONFIG_VALUE_"+i]), secretPresent:e.INTEGRATION_SECRET_TOKEN!==undefined}))'
    const child = spawnSubprocess({ argv: [process.execPath, '-e', script], cwd: process.cwd(), stdio, graceMs: 1000 })
    try {
      expect((await child.done).exitCode).toBe(0)
      const result = JSON.parse(child.collected.stdout!.readFrom(0).text)
      expect(result.count).toBe('15')
      expect(result.keys).toEqual(Array.from({ length: 15 }, (_, i) => process.env[`GIT_CONFIG_KEY_${i}`]))
      expect(result.values).toEqual(Array.from({ length: 15 }, (_, i) => process.env[`GIT_CONFIG_VALUE_${i}`]))
      expect(result.secretPresent).toBe(false)
    } finally {
      await child.terminate()
      await child.waitForExit()
    }
  })

  it.each([['safe.bareRepository', 'explicit'], ['credential.interactive', 'never'], ['alias.log', 'log']])('real Git parses the complete group and retains %s', async (key, value) => {
    launcherFixture()
    const child = spawnSubprocess({ argv: ['git', 'config', '--get', key], cwd: process.cwd(), stdio, graceMs: 1000 })
    try {
      expect((await child.done).exitCode).toBe(0)
      expect(child.collected.stdout!.readFrom(0).text.trim()).toBe(value)
      expect(child.collected.stderr!.readFrom(0).text).toBe('')
    } finally {
      await child.terminate()
      await child.waitForExit()
    }
  })

  it('rejects malformed inherited configuration before invoking the OS spawner', () => {
    launcherFixture()
    vi.stubEnv('GIT_CONFIG_KEY_0', undefined)
    const spawn = vi.fn()
    expect(() => spawnSubprocess({ argv: [process.execPath, '-e', ''], cwd: process.cwd(), stdio, graceMs: 1000 }, { spawn }))
      .toThrow(/^Unsupported or incomplete inherited Git configuration$/)
    expect(spawn).not.toHaveBeenCalled()
  })
})
