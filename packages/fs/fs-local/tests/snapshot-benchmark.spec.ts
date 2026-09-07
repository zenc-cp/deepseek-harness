import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveLocalTarget } from '../src/fsio.ts'
import { captureSnapshot, streamTextSnapshot } from '../src/snapshot.ts'

it('streams bounded chunks and measures the cost of two non-retaining guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-snapshot-cost-'))
  const samples: { mib: number; chunks: number; plainReadMs: number; snapshotMs: number; twoGuardsMs: number }[] = []
  try {
    for (const mib of [1, 8]) {
      const bytes = mib * 1024 * 1024
      const path = join(dir, `${mib}.txt`)
      await writeFile(path, Buffer.alloc(bytes, 97))
      const target = await resolveLocalTarget(dir, path)
      let start = performance.now()
      await readFile(path)
      const plainReadMs = performance.now() - start
      start = performance.now()
      const stream = streamTextSnapshot(target)
      let total = 0
      let chunks = 0
      let revision
      while (true) {
        const next = await stream.next()
        if (next.done) { revision = next.value; break }
        expect(next.value.length).toBeLessThanOrEqual(64 * 1024)
        total += next.value.length
        chunks++
      }
      const snapshotMs = performance.now() - start
      expect(total).toBe(bytes)
      start = performance.now()
      for (let guard = 0; guard < 2; guard++) {
        const checked = await captureSnapshot(target, { expected: revision }, 0)
        expect(checked.bytes).toBeNull()
        expect(checked.version).toBe(revision)
      }
      const twoGuardsMs = performance.now() - start
      samples.push({ mib, chunks, plainReadMs, snapshotMs, twoGuardsMs })
    }
    // Diagnostic only: no timing threshold, no file contents or revisions logged.
    console.info('Snapshot cost (single warm-cache samples, not isolated):', JSON.stringify(samples))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
