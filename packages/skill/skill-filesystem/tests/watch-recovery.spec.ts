import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const seam = vi.hoisted(() => ({ beforeRead: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    await seam.beforeRead?.()
    return actual.readdir(...args)
  } }
})
import { WatchRecovery } from '../src/watch-recovery.ts'

afterEach(() => { seam.beforeRead = undefined; vi.useRealTimers() })

it('drains an active scan on close and suppresses its invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-drain-'))
  const invalidate = vi.fn()
  const onError = vi.fn()
  const recovery = new WatchRecovery(root, true, false, 10, invalidate, onError)
  try {
    await recovery.initialize()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    seam.beforeRead = async () => { entered.resolve(undefined); await release.promise }
    recovery.observe()
    await entered.promise
    let closed = false
    const closing = recovery.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await writeFile(join(root, 'new.md'), 'new')
    release.resolve(undefined)
    await closing
    expect(invalidate).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  } finally { seam.beforeRead = undefined; await recovery.close(); await rm(root, { recursive: true, force: true }) }
})

it('reports scan errors and recovers on a later raw event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-error-'))
  const invalidate = vi.fn()
  const onError = vi.fn()
  const recovery = new WatchRecovery(root, true, false, 10, invalidate, onError)
  try {
    await recovery.initialize()
    const failure = new Error('fixture read failure')
    seam.beforeRead = async () => { throw failure }
    recovery.observe()
    await expect.poll(() => onError.mock.calls.length).toBe(1)
    expect(onError).toHaveBeenCalledWith(failure)
    expect(invalidate).not.toHaveBeenCalled()
    seam.beforeRead = undefined
    await mkdir(join(root, 'skill'))
    await writeFile(join(root, 'skill', 'SKILL.md'), 'changed')
    recovery.observe()
    await expect.poll(() => invalidate.mock.calls.length).toBe(1)
  } finally { seam.beforeRead = undefined; await recovery.close(); await rm(root, { recursive: true, force: true }) }
})
