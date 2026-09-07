import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { contentVersion } from '../src/snapshot.ts'

let dir: string
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-snapshot-'))
  const ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

async function fixture(content = 'first'): Promise<FsTarget> {
  const path = join(dir, 'file.txt')
  await writeFile(path, content)
  // Exactly representable timestamps let an in-place writer restore mtime,
  // without the precision loss of round-tripping a current timestamp via Date.
  await utimes(path, 1000, 1000)
  return fs.resolve(path)
}

async function snapshot(target: FsTarget, signal?: AbortSignal): Promise<{ text: string; version: FsVersion }> {
  const stream = fs.streamTextSnapshot(target, signal)
  let text = ''
  while (true) {
    const next = await stream.next()
    if (next.done) return { text, version: next.value }
    text += next.value
  }
}

async function overwriteInPlace(target: FsTarget, content: string): Promise<void> {
  await writeFile(String(target.targetKey), content)
  await utimes(String(target.targetKey), 1000, 1000)
}

describe('content-bound observations', () => {
  it('allows an unchanged read-to-edit despite access/ctime-only changes', async () => {
    const target = await fixture()
    const observed = await snapshot(target)
    await utimes(String(target.targetKey), 2000, 1000)
    expect((await snapshot(target)).version).toBe(observed.version)
    await fs.editText(target, { oldString: 'first', newString: 'edited', replaceAll: false }, observed)
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('edited')
  })

  it('rejects a true in-place same-size rewrite with restored mtime before matching', async () => {
    const target = await fixture()
    const before = await stat(String(target.targetKey), { bigint: true })
    const observed = await snapshot(target)
    await overwriteInPlace(target, 'other')
    const after = await stat(String(target.targetKey), { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.size).toBe(before.size)
    expect(after.mtimeNs).toBe(before.mtimeNs)
    await expect(fs.editText(target, { oldString: 'first', newString: 'bad', replaceAll: false }, observed))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('other')
  })

  it('does not bind unseen bytes written after reading to an old observation', async () => {
    const target = await fixture()
    fs.internals.inspectSnapshotAfterRead = async () => {
      delete fs.internals.inspectSnapshotAfterRead
      await overwriteInPlace(target, 'other')
    }
    const observed = await snapshot(target)
    expect(observed.text).toBe('first')
    await expect(fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: observed.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('other')
  })

  it('rejects path replacement while reading from the original handle', async () => {
    const target = await fixture()
    const replacement = join(dir, 'replacement.txt')
    await writeFile(replacement, 'other')
    await utimes(replacement, 1000, 1000)
    fs.internals.inspectSnapshotAfterOpen = async () => {
      // Windows disallows rename-over-open-target; moving the old entry aside
      // still leaves the descriptor open and deterministically swaps the path.
      await rename(String(target.targetKey), join(dir, 'old-open-file.txt'))
      await rename(replacement, String(target.targetKey))
    }
    await expect(snapshot(target)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('other')
  })

  it('never rebinds session A when session B observes different bytes', async () => {
    const target = await fixture()
    const a = await snapshot(target)
    await overwriteInPlace(target, 'other')
    const b = await snapshot(target)
    expect(b.version).not.toBe(a.version)
    await expect(fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: a.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await fs.writeText(target, 'winner', { kind: 'replaceIfVersion', version: b.version })
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('winner')
  })

  it('serializes concurrent guarded edits so exactly one wins', async () => {
    const target = await fixture()
    const observed = await snapshot(target)
    const results = await Promise.allSettled([
      fs.editText(target, { oldString: 'first', newString: 'one', replaceAll: false }, observed),
      fs.editText(target, { oldString: 'first', newString: 'two', replaceAll: false }, observed),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'FS_STALE_VERSION' } })
  })

  it('retains a content observation after an edit miss and ambiguous match', async () => {
    const target = await fixture('a a a')
    const observed = await snapshot(target)
    await expect(fs.editText(target, { oldString: 'z', newString: 'X', replaceAll: false }, observed))
      .rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(fs.editText(target, { oldString: 'a', newString: 'X', replaceAll: false }, observed))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    expect((await snapshot(target)).version).toBe(observed.version)
    await fs.editText(target, { oldString: 'a', newString: 'X', replaceAll: true }, observed)
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('X X X')
  })

  it('ignores simulated access/ctime drift, but not permission changes, in content tokens', async () => {
    const target = await fixture()
    const info = await stat(String(target.targetKey), { bigint: true })
    const version = contentVersion(info, '0'.repeat(64))
    info.ctimeNs += 1_000_000n
    info.atimeNs += 1_000_000n
    expect(contentVersion(info, '0'.repeat(64))).toBe(version)
    info.mode ^= 0o222n
    expect(contentVersion(info, '0'.repeat(64))).not.toBe(version)
  })

  it('keeps legacy metadata guards strict', async () => {
    const target = await fixture()
    const observed = (await fs.stat(target))!
    await utimes(String(target.targetKey), 2000, 2000)
    await expect(fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: observed.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('returns a content-bound mutation outcome usable after a subsequent read', async () => {
    const target = await fixture()
    const written = await fs.writeText(target, 'first')
    await fs.readText(target)
    expect((await snapshot(target)).version).toBe(written.version)
    await fs.editText(target, { oldString: 'first', newString: 'other', replaceAll: false }, written)
  })

  it('hashes raw BOM and CRLF bytes and supports bounded binary snapshots', async () => {
    const target = await fixture('\uFEFFfirst\r\n')
    const text = await snapshot(target)
    const raw = await fs.readBytesSnapshot(target, undefined, 64)
    expect(text.text).toBe('first\r\n')
    expect(Buffer.from(raw.bytes).toString('utf8')).toBe('\uFEFFfirst\r\n')
    expect(raw.version).toBe(text.version)
    await writeFile(String(target.targetKey), Buffer.from([0, 1, 2]))
    const binary = await fs.readBytesSnapshot(target, undefined, 3)
    expect([...binary.bytes]).toEqual([0, 1, 2])
    await expect(fs.readBytesSnapshot(target, undefined, 2)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await expect(snapshot(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('cancels mid-stream without supplying a final revision', async () => {
    const target = await fixture('a'.repeat(128 * 1024))
    const controller = new AbortController()
    const stream = fs.streamTextSnapshot(target, controller.signal)
    expect((await stream.next()).done).toBe(false)
    controller.abort()
    await expect(stream.next()).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  it('closing a partially consumed stream does not mint a revision', async () => {
    const target = await fixture('a'.repeat(128 * 1024))
    const stream = fs.streamTextSnapshot(target)
    expect((await stream.next()).done).toBe(false)
    expect(await stream.return(undefined as never)).toEqual({ done: true, value: undefined })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  it.each(['write', 'edit'] as const)('rechecks a content guard after staging a %s', async (operation) => {
    const target = await fixture()
    const observed = await snapshot(target)
    fs.internals.inspectTemp = async () => {
      await overwriteInPlace(target, 'other')
    }
    const mutation = operation === 'write'
      ? fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: observed.version })
      : fs.editText(target, { oldString: 'first', newString: 'bad', replaceAll: false }, observed)
    await expect(mutation).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('other')
    expect(await readdir(dir)).toEqual(['file.txt'])
  })

  it('does not bind a mutation outcome to unseen post-publication bytes', async () => {
    const target = await fixture()
    fs.internals.removeStagingDir = async (stagingDir) => {
      await overwriteInPlace(target, 'other')
      await rm(stagingDir, { recursive: true, force: true })
    }
    const outcome = await fs.writeText(target, 'first')
    delete fs.internals.removeStagingDir
    await expect(fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: outcome.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await readFile(String(target.targetKey), 'utf8')).toBe('other')
  })

  it('rejects a malformed content token without exposing its digest in the error', async () => {
    const target = await fixture()
    const observed = await snapshot(target)
    const version = `${observed.version}0` as FsVersion
    try {
      await fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version })
      expect.fail('malformed content revision was accepted')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FS_STALE_VERSION' })
      expect(String(error)).not.toContain(observed.version)
    }
  })

  it('supports empty snapshots and never completes invalid UTF-8 snapshots', async () => {
    const target = await fixture('')
    const text = await snapshot(target)
    const raw = await fs.readBytesSnapshot(target, undefined, 0)
    expect(text.text).toBe('')
    expect(raw.bytes).toHaveLength(0)
    expect(raw.version).toBe(text.version)
    await writeFile(String(target.targetKey), Buffer.from([0xc3]))
    await expect(snapshot(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('leaves stat, lstat and directory listing on the metadata-only path', async () => {
    const target = await fixture()
    fs.internals.inspectSnapshotAfterOpen = () => { throw new Error('unexpected content I/O') }
    expect((await fs.stat(target))?.version.startsWith('content-v1:')).toBe(false)
    expect((await fs.lstat(String(target.targetKey)))?.version.startsWith('content-v1:')).toBe(false)
    const entries = await fs.listDir(await fs.resolve(dir))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.version?.startsWith('content-v1:')).toBe(false)
  })

  it('rejects growth beyond a raw snapshot cap without unbounded reading', async () => {
    const target = await fixture('abc')
    fs.internals.inspectSnapshotAfterOpen = async () => {
      await writeFile(String(target.targetKey), 'abcdefgh')
    }
    await expect(fs.readBytesSnapshot(target, undefined, 3)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })
})
