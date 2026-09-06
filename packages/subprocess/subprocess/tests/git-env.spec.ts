import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

afterEach(() => vi.unstubAllEnvs())

function fixture(entries: Record<string, string> = {}) {
  for (const name of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|(?:KEY|VALUE)_.*)$/i.test(name)) vi.stubEnv(name, undefined)
  }
  for (const [name, value] of Object.entries(entries)) vi.stubEnv(name, value)
}

describe('inherited Git configuration', () => {
  it('preserves the complete launcher control group without reordering or dropping entries', () => {
    const commands = [
      'blame', 'branch', 'config', 'describe', 'log', 'reflog', 'remote',
      'rev-parse', 'shortlog', 'stash', 'submodule', 'tag', 'worktree',
    ]
    const entries: Record<string, string> = { GIT_CONFIG_COUNT: '15' }
    for (const [index, command] of commands.entries()) {
      entries[`GIT_CONFIG_KEY_${index}`] = `alias.${command}`
      entries[`GIT_CONFIG_VALUE_${index}`] = command
    }
    entries.GIT_CONFIG_KEY_13 = 'safe.bareRepository'
    entries.GIT_CONFIG_VALUE_13 = 'explicit'
    entries.GIT_CONFIG_KEY_14 = 'credential.interactive'
    entries.GIT_CONFIG_VALUE_14 = 'never'
    fixture({ ...entries, SAMPLE_API_KEY: 'synthetic', DSH_TEST_FACT: 'synthetic' })
    const env = scrubbedParentEnv()
    expect(Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('GIT_CONFIG_'))))
      .toEqual(entries)
    expect(env.SAMPLE_API_KEY).toBeUndefined()
    expect(env.DSH_TEST_FACT).toBeUndefined()
  })

  it.each([
    ['alias.log', '!echo synthetic-private-value'],
    ['alias.log', 'log --format=synthetic-private-value'],
    ['alias.log', 'status'],
    ['alias.log', ' log'],
    ['alias.log', 'log\n'],
    ['alias.other', 'other'],
    ['alias.push', 'push'],
    ['safe.bareRepository', 'all'],
    ['safe.bareRepository', ''],
    ['credential.interactive', 'true'],
    ['credential.interactive', 'synthetic-private-value'],
  ])('refuses unverified launcher control forms without disclosing them: %s (%#)', (key, value) => {
    fixture({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value })
    expect(() => scrubbedParentEnv()).toThrow(/^Unsupported or incomplete inherited Git configuration$/)
  })

  it('preserves mixed-case names for verified launcher controls', () => {
    fixture({
      git_config_count: '3',
      git_config_key_0: 'Alias.Log',
      git_config_value_0: 'log',
      git_config_key_1: 'Safe.BareRepository',
      git_config_value_1: 'explicit',
      git_config_key_2: 'Credential.Interactive',
      git_config_value_2: 'never',
    })
    const env = scrubbedParentEnv()
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect(env.GIT_CONFIG_KEY_0).toBe('Alias.Log')
    expect(env.GIT_CONFIG_VALUE_0).toBe('log')
    expect(env.GIT_CONFIG_KEY_1).toBe('Safe.BareRepository')
    expect(env.GIT_CONFIG_VALUE_1).toBe('explicit')
    expect(env.GIT_CONFIG_KEY_2).toBe('Credential.Interactive')
    expect(env.GIT_CONFIG_VALUE_2).toBe('never')
  })

  it('preserves complete approved settings and still scrubs ordinary credentials', () => {
    fixture({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/repo', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/hooks', SAMPLE_API_KEY: 'synthetic' })
    const env = scrubbedParentEnv()
    expect(env.GIT_CONFIG_COUNT).toBe('2')
    expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory')
    expect(env.GIT_CONFIG_VALUE_0).toBe('/repo')
    expect(env.GIT_CONFIG_KEY_1).toBe('core.hooksPath')
    expect(env.GIT_CONFIG_VALUE_1).toBe('/hooks')
    expect(env.SAMPLE_API_KEY).toBeUndefined()
  })

  it.each([
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'synthetic' },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory' },
    { GIT_CONFIG_COUNT: '-1' },
    { GIT_CONFIG_COUNT: '1.5' },
    { GIT_CONFIG_COUNT: '99999999999999999999' },
    { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/repo' },
    { GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/repo' },
    { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_00: 'safe.directory' },
    { GIT_CONFIG_PARAMETERS: "'http.extraHeader=synthetic'" },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'synthetic' },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'unknown.setting', GIT_CONFIG_VALUE_0: 'synthetic' },
  ])('rejects unsupported or incomplete configuration without echoing values: %#', (entries) => {
    fixture(entries)
    expect(() => scrubbedParentEnv()).toThrow(/^Unsupported or incomplete inherited Git configuration$/)
  })

  it('handles case-insensitive environment names and preserves empty approved values', () => {
    fixture({ git_config_count: '1', git_config_key_0: 'Core.HooksPath', git_config_value_0: '' })
    expect(scrubbedParentEnv().GIT_CONFIG_VALUE_0).toBe('')
    expect(scrubbedParentEnv().GIT_CONFIG_KEY_0).toBe('Core.HooksPath')
  })

  it('accepts an empty configuration', () => {
    fixture({ GIT_CONFIG_COUNT: '0' })
    expect(scrubbedParentEnv().GIT_CONFIG_COUNT).toBe('0')
  })
})
