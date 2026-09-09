import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'

const watchers = vi.hoisted(() => [] as EventEmitter[])
vi.mock('chokidar', () => ({ default: { watch: () => {
  const watcher = new EventEmitter()
  Object.assign(watcher, { close: async () => {} })
  watchers.push(watcher)
  queueMicrotask(() => watcher.emit('ready'))
  return watcher
} } }))

afterEach(() => { watchers.length = 0; vi.useRealTimers() })

it('recovers raw-only writes without invalidating on reads, noise, or after disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-raw-recovery-'))
  const file = join(root, 'demo', 'SKILL.md')
  const text = (description: string) => `---\nname: demo\ndescription: ${description}\n---\nBody\n`
  await mkdir(join(root, 'demo'))
  await writeFile(file, text('Before'))
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(SkillFileSystem, {
    includeDefaultRoots: false, customSkillDirs: [root], watch: true,
    watchStabilityThresholdMs: 20, watchPollIntervalMs: 10,
  })
  try {
    expect((await ctx.skills.list())[0]?.description).toBe('Before')
    const listSpy = vi.spyOn(SkillFileSystem.FileSystemSkillProvider.prototype, 'list')
    const raw = () => watchers[0]!.emit('raw', 'change', 'SKILL.md', {})
    await readFile(file)
    for (let i = 0; i < 100; i++) raw()
    await new Promise(resolve => setTimeout(resolve, 100))
    await ctx.skills.list()
    expect(listSpy).not.toHaveBeenCalled()
    await writeFile(join(root, 'noise.txt'), 'irrelevant')
    raw()
    await new Promise(resolve => setTimeout(resolve, 100))
    await ctx.skills.list()
    expect(listSpy).not.toHaveBeenCalled()
    await writeFile(file, text('After modification'))
    for (let i = 0; i < 100; i++) raw()
    await expect.poll(async () => (await ctx.skills.list())[0]?.description).toBe('After modification')
    expect(listSpy).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    raw()
    expect(vi.getTimerCount()).toBe(1)
    await fiber.dispose()
    expect(vi.getTimerCount()).toBe(0)
    raw()
    expect(vi.getTimerCount()).toBe(0)
    listSpy.mockRestore()
  } finally {
    await fiber.dispose()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
