import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CredentialProvider,
  credentialRef,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as agencycli from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import {
  agencycliArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  resolveCredentialEnv,
  textTask,
} from '../src/run.ts'

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent: fakeParent, signal }
}

class FakeCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly store: Record<string, string> = {}) {
    super(ctx)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.store[ref]
    return Promise.resolve(value === undefined || value.length === 0
      ? undefined
      : { value, source: 'memory' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const value = this.store[ref]
    const configured = value !== undefined && value.length > 0
    return Promise.resolve({
      configured,
      ...configured ? { source: 'memory' } : {},
      writable: true,
    })
  }

  override set(): Promise<void> {
    return Promise.reject(new Error('test credentials are read-only'))
  }

  override unset(): Promise<void> {
    return Promise.resolve()
  }
}

class FakeReader {
  constructor(private readonly text: string) {}

  readFrom(fromByte: number) {
    return { text: this.text.slice(fromByte), nextOffset: this.text.length, lossy: false }
  }
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly spec: SubprocessSpawnSpec
  readonly terminate: ReturnType<typeof vi.fn>
  readonly waitForExit: ReturnType<typeof vi.fn>
  readonly settle: (outcome?: SubprocessOutcome) => void
}

function fakeChild(spec: SubprocessSpawnSpec, stdout = 'agency answer\n'): FakeChild {
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  let settled = false
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (
    outcome: SubprocessOutcome = { exitCode: 0, signal: null },
  ): void => {
    if (settled) return
    settled = true
    resolveDone(outcome)
  }
  const terminate = vi.fn(() => { settle() })
  const waitForExit = vi.fn(async () => {
    await done.catch(() => {})
    return true
  })
  const handle: SubprocessHandle = {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: new FakeReader(stdout) },
    done,
    terminate,
    waitForExit,
  }
  void rejectDone
  return { handle, spec, terminate, waitForExit, settle }
}

async function boot(config: agencycli.Config, seed: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(FakeCredentials, seed)
  const children: FakeChild[] = []
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const child = fakeChild(spec)
    children.push(child)
    queueMicrotask(() => { child.settle() })
    return child.handle
  })
  await ctx.plugin(agencycli, config)
  return { ctx, spawn, children }
}

describe('agencycliArgv', () => {
  it('builds a one-shot exec with --dir, --no-session, and no resume flags', () => {
    expect(agencycliArgv({
      command: 'agencycli',
      cwd: '/tmp/agency',
      project: 'demo',
      agent: 'dev',
      prompt: 'summarize the repo',
    })).toEqual([
      'agencycli',
      '--dir',
      '/tmp/agency',
      'exec',
      '--project',
      'demo',
      '--agent',
      'dev',
      '--prompt',
      'summarize the repo',
      '--no-session',
    ])
  })
})

describe('textTask', () => {
  it('joins text blocks and rejects empty or non-text tasks', () => {
    expect(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(() => textTask([])).toThrow('the one-shot task must contain only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'hidden' }]))
      .toThrow('the one-shot task must contain only text blocks')
    expect(() => textTask([{ type: 'text', text: '   ' }])).toThrow('the one-shot task must not be empty')
  })
})

describe('resolveCredentialEnv', () => {
  it('resolves only mapped refs and never invents AgencyCLI keys from unrelated stores', async () => {
    const values: Record<string, string> = {
      TEST_CHILD_TOKEN: 'mapped-secret',
      FOUNDRY_ENTRA_TOKEN: 'must-not-auto-map',
      CADDY_BASICAUTH_PW: 'must-not-auto-map',
    }
    const resolve = async (ref: CredentialRef) => {
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'memory' }
    }

    expect(await resolveCredentialEnv({}, resolve)).toEqual({})
    expect(await resolveCredentialEnv(
      { AGENCYCLI_HTTP_API_KEY: 'TEST_CHILD_TOKEN' },
      resolve,
    )).toEqual({ AGENCYCLI_HTTP_API_KEY: 'mapped-secret' })
  })

  it('fails a missing mapped ref without putting the secret value in the error', async () => {
    const resolve = async (ref: CredentialRef) =>
      ref === 'PRESENT_TOKEN' ? { value: 'super-secret-value', source: 'memory' } : undefined

    await expect(resolveCredentialEnv(
      { AGENCYCLI_HTTP_API_KEY: 'MISSING_REF' },
      resolve,
    )).rejects.toThrow(
      'credential ref "MISSING_REF" for child env "AGENCYCLI_HTTP_API_KEY" is not configured',
    )
    try {
      await resolveCredentialEnv({ AGENCYCLI_HTTP_API_KEY: 'MISSING_REF' }, resolve)
    } catch (error: unknown) {
      expect(String(error)).not.toContain('super-secret-value')
    }
  })
})

describe('subagent-agencycli provider', () => {
  it('registers an out-of-process one-shot provider and validates disposeGraceMs', async () => {
    const { ctx } = await boot({ project: 'demo', agent: 'dev' })
    expect(ctx.subagents.list()).toEqual(['agencycli'])
    expect(ctx.subagents.getProvider('agencycli')).toMatchObject({
      name: 'agencycli',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    await ctx.fiber.dispose()

    const invalid = new Context()
    await invalid.plugin(SubagentRuntime)
    await invalid.plugin(LocalSubprocessRuntime)
    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(invalid.plugin(agencycli, {
        project: 'demo',
        agent: 'dev',
        disposeGraceMs,
      })).rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(invalid.plugin(agencycli, {
      project: 'demo',
      agent: 'dev',
      disposeGraceMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    await invalid.fiber.dispose()
  })

  it('spawns agencycli exec --no-session and settles collected stdout as the answer', async () => {
    const { ctx, spawn, children } = await boot({
      project: 'demo',
      agent: 'dev',
      env: { AGENCY_EXPLICIT: 'from-config' },
    })
    const run = await ctx.subagents.start('agencycli', request())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'agency answer\n' }])
    expect(spawn).toHaveBeenCalledTimes(1)
    const spec = spawn.mock.calls[0]![0]
    expect(spec.argv).toEqual(agencycliArgv({
      command: 'agencycli',
      cwd: process.cwd(),
      project: 'demo',
      agent: 'dev',
      prompt: 'do the task',
    }))
    expect(spec.cwd).toBe(process.cwd())
    expect(spec.env).toMatchObject({ AGENCY_EXPLICIT: 'from-config' })
    expect(spec.env).not.toHaveProperty('FOUNDRY_ENTRA_TOKEN')
    expect(spec.env).not.toHaveProperty('AGENCYCLI_HTTP_API_KEY')
    expect(spec.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: DEFAULT_MAX_OUTPUT_BYTES },
      stderr: 'inherit',
    })
    expect(spec.graceMs).toBe(DEFAULT_DISPOSE_GRACE_MS)
    await run.dispose()
    expect(children[0]!.terminate).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('maps configured credential refs into child env and does not forward unmapped store keys', async () => {
    const { ctx, spawn } = await boot({
      project: 'demo',
      agent: 'dev',
      credentialEnv: { AGENCYCLI_HTTP_API_KEY: 'TEST_CHILD_TOKEN' },
    }, {
      TEST_CHILD_TOKEN: 'mapped-secret',
      FOUNDRY_ENTRA_TOKEN: 'must-not-auto-map',
      CADDY_BASICAUTH_PW: 'must-not-auto-map',
    })
    const run = await ctx.subagents.start('agencycli', request())
    await run.result
    const env = spawn.mock.calls[0]![0].env
    expect(env).toMatchObject({ AGENCYCLI_HTTP_API_KEY: 'mapped-secret' })
    expect(env).not.toHaveProperty('FOUNDRY_ENTRA_TOKEN')
    expect(env).not.toHaveProperty('CADDY_BASICAUTH_PW')
    expect(env).not.toHaveProperty('TEST_CHILD_TOKEN')
    await run.dispose()
    await ctx.fiber.dispose()
  })

  it('fails before spawn when a mapped credential ref is unconfigured', async () => {
    const { ctx, spawn } = await boot({
      project: 'demo',
      agent: 'dev',
      credentialEnv: { AGENCYCLI_HTTP_API_KEY: 'MISSING_REF' },
    }, { TEST_CHILD_TOKEN: 'mapped-secret' })
    await expect(ctx.subagents.start('agencycli', request())).rejects.toThrow(
      'credential ref "MISSING_REF" for child env "AGENCYCLI_HTTP_API_KEY" is not configured',
    )
    expect(spawn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('requires a parent session cwd without suggesting unsupported config', async () => {
    const { ctx, spawn } = await boot({ project: 'demo', agent: 'dev' })
    await expect(ctx.subagents.start('agencycli', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
      signal: new AbortController().signal,
    })).rejects.toThrow(
      'subagent-agencycli: no working directory for the child — delegate from a parent session that has one',
    )
    expect(spawn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape and package-owned empty invariant', async () => {
    expect('default' in agencycli).toBe(false)
    expect(agencycli.name).toBe('subagent-agencycli')
    expect(agencycli.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(agencycli)).toBe(agencycli)

    const dispose = vi.fn()
    const register = vi.fn((
      _packageName: string,
      _installer: InvariantInstaller,
    ) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-subagent-agencycli',
      expect.any(Function),
    )
    const install = register.mock.calls[0]![1]
    await install(new Context(), (message) => { throw new Error(message) })
    expect(invariant.name).toBe('subagent-agencycli-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(credentialRef('AGENCYCLI_HTTP_API_KEY')).toBe('AGENCYCLI_HTTP_API_KEY')
  })
})
