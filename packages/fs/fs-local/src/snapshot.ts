/**
 * Content-bound local reads. A revision describes the raw bytes actually read,
 * not a later path stat. Metadata probes themselves never hash file contents.
 * @module @deepseek-ai/dsh-fs-local/snapshot
 */
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsBytesSnapshot } from '@deepseek-ai/dsh-fs'
import { decodeUtf8Stream } from './fsio.ts'
import type { FsIoInternals, LocalTarget } from './fsio.ts'

const READ_CHUNK_BYTES = 64 * 1024
const BINARY_SAMPLE_BYTES = 8192
const CONTENT_PREFIX = 'content-v1:'

function contentStamp(info: BigIntStats): string {
  // Access time and ctime can change because of this read. Identity, write time,
  // size and basic permissions remain guarded, together with the raw digest.
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.mode}:${info.uid}:${info.gid}:`
}

/**
 * Bind a complete raw digest to the opened file's identity and content metadata.
 * @param info - metadata of the file whose bytes were read or written.
 * @param digest - full SHA-256 of those exact raw bytes.
 * @returns a content revision; callers must not log or interpret it.
 */
export function contentVersion(info: BigIntStats, digest: string): FsVersion {
  return FsVersion(`${CONTENT_PREFIX}${contentStamp(info)}${digest}`)
}

/**
 * Select the content-guard path; malformed content tokens still fail its validation.
 * @param version - an opaque token previously returned by this backend.
 * @returns whether the content-token namespace is used.
 */
export function isContentVersion(version: FsVersion): boolean {
  return version.startsWith(CONTENT_PREFIX)
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('read aborted', 'FS_ABORTED')
}

function stale(target: LocalTarget): FsError {
  return new FsError(`cannot access "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
}

interface SnapshotOptions {
  signal?: AbortSignal | undefined
  internals?: FsIoInternals | undefined
  expected?: FsVersion
  maxBytes?: number
}

async function* rawSnapshot(target: LocalTarget, options: SnapshotOptions): AsyncGenerator<Buffer, FsVersion, void> {
  const { signal, internals, expected, maxBytes } = options
  aborted(signal)
  try {
    const handle = await open(target.targetKey, 'r')
    try {
      aborted(signal)
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const stamp = contentStamp(before)
      if (expected !== undefined) {
        const prefix = `${CONTENT_PREFIX}${stamp}`
        if (!expected.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(expected.slice(prefix.length))) throw stale(target)
      }
      if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      await internals?.inspectSnapshotAfterOpen?.(target)
      const digest = createHash('sha256')
      let total = 0n
      // One extra byte detects growth. Never chase an indefinitely growing file.
      while (total <= before.size) {
        aborted(signal)
        const remaining = before.size + 1n - total
        const length = Number(remaining > BigInt(READ_CHUNK_BYTES) ? BigInt(READ_CHUNK_BYTES) : remaining)
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, null)
        aborted(signal)
        if (bytesRead === 0) break
        total += BigInt(bytesRead)
        if (maxBytes !== undefined && total > BigInt(maxBytes)) {
          throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
        }
        if (total > before.size) throw stale(target)
        const chunk = buffer.subarray(0, bytesRead)
        digest.update(chunk)
        yield chunk
      }
      if (total !== before.size) throw stale(target)
      await internals?.inspectSnapshotAfterRead?.(target)
      aborted(signal)
      const after = await handle.stat({ bigint: true })
      const current = await stat(target.targetKey, { bigint: true })
      aborted(signal)
      if (contentStamp(after) !== stamp || contentStamp(current) !== stamp) throw stale(target)
      const version = contentVersion(before, digest.digest('hex'))
      if (expected !== undefined && version !== expected) throw stale(target)
      return version
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    if (error instanceof FsError) throw error
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        if (expected !== undefined) throw stale(target)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new FsError(`cannot read "${target.displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
      }
    }
    throw error
  }
}

/**
 * Read/hash the complete file, retaining at most a bounded optional diff basis.
 * @param target - resolved file to read.
 * @param options - cancellation, expected revision, cap, and deterministic test boundaries.
 * @param captureLimit - exclusive retained-byte bound; zero hashes without retaining content.
 * @returns the revision and complete retained bytes, or null when at/above the capture bound.
 */
export async function captureSnapshot(
  target: LocalTarget,
  options: SnapshotOptions,
  captureLimit: number,
): Promise<{ version: FsVersion; bytes: Buffer | null }> {
  const stream = rawSnapshot(target, options)
  let retained = captureLimit > 0
  let total = 0
  const chunks: Buffer[] = []
  try {
    while (true) {
      const next = await stream.next()
      if (next.done) return { version: next.value, bytes: retained ? Buffer.concat(chunks, total) : null }
      if (retained) {
        total += next.value.length
        if (total >= captureLimit) {
          retained = false
          chunks.length = 0
        } else {
          chunks.push(next.value)
        }
      }
    }
  } finally {
    await stream.return(undefined as never)
  }
}

/**
 * Stream validated UTF-8 while hashing raw bytes before BOM/line-ending handling.
 * @param target - resolved file to read.
 * @param signal - cancellation between bounded descriptor reads.
 * @param internals - deterministic fixture-only race hooks.
 * @returns decoded chunks with a content revision only at successful normal EOF.
 */
export async function* streamTextSnapshot(
  target: LocalTarget,
  signal?: AbortSignal,
  internals?: FsIoInternals,
): AsyncGenerator<string, FsVersion, void> {
  const stream = rawSnapshot(target, { signal, internals })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampled = 0
  try {
    while (true) {
      const next = await stream.next()
      if (next.done) {
        const tail = decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
        if (tail) yield tail
        aborted(signal)
        return next.value
      }
      if (sampled < BINARY_SAMPLE_BYTES) {
        const sample = next.value.subarray(0, BINARY_SAMPLE_BYTES - sampled)
        if (sample.includes(0)) throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
        sampled += sample.length
      }
      yield decodeUtf8Stream(decoder, next.value, 'read', target.displayPath)
    }
  } finally {
    await stream.return(undefined as never)
  }
}

/**
 * Read complete bounded raw bytes with their content-bound revision.
 * @param target - resolved regular file to read.
 * @param signal - aborts reading.
 * @param maxBytes - inclusive byte cap.
 * @param internals - deterministic fixture-only race hooks.
 * @returns exact raw bytes and their immutable revision.
 */
export async function readBytesSnapshot(
  target: LocalTarget,
  signal: AbortSignal | undefined,
  maxBytes: number,
  internals?: FsIoInternals,
): Promise<FsBytesSnapshot> {
  const result = await captureSnapshot(target, { signal, internals, maxBytes }, maxBytes + 1)
  if (result.bytes === null) throw new FsError('read exceeded its byte limit', 'FS_TOO_LARGE')
  return { bytes: result.bytes, version: result.version }
}
