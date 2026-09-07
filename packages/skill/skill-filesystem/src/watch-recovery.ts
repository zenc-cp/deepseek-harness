import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Metadata-only fallback for raw events that never become normalized changes. */
export class WatchRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private dirty = false
  private closed = false
  private previous: string | undefined

  constructor(
    private readonly root: string,
    private readonly followSymlinks: boolean,
    private readonly skipSystem: boolean,
    private readonly delayMs: number,
    private readonly invalidate: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  async initialize(): Promise<void> {
    this.previous = await this.fingerprint()
  }

  observe(): void {
    if (this.closed) return
    this.dirty = true
    if (this.timer !== undefined || this.running !== undefined) return
    // Do not restart the timer: continuous event bursts cannot starve recovery.
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.dirty = false
      this.running = this.check().finally(() => {
        this.running = undefined
        if (this.dirty) this.observe()
      })
    }, this.delayMs)
    this.timer.unref()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }

  private async check(): Promise<void> {
    try {
      const current = await this.fingerprint()
      if (this.closed) return
      if (current !== this.previous) {
        this.previous = current
        this.invalidate()
      }
    } catch (error) {
      if (!this.closed) this.onError(error)
    }
  }

  private async fingerprint(): Promise<string> {
    const values: string[] = []
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (absent(error)) return 'absent'
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (this.closed) break
      if (this.skipSystem && entry.name === '.system') continue
      const path = join(this.root, entry.name)
      try {
        const info = this.followSymlinks ? await stat(path, { bigint: true }) : await lstat(path, { bigint: true })
        const candidate = info.isDirectory() ? join(path, 'SKILL.md') : entry.name.endsWith('.md') && info.isFile() ? path : undefined
        if (candidate === undefined) continue
        const file = candidate === path
          ? info
          : this.followSymlinks ? await stat(candidate, { bigint: true }) : await lstat(candidate, { bigint: true })
        if (!file.isFile()) continue
        // atime/ctime change on reads on some Windows volumes. Exclude both.
        values.push(`${entry.name}:${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.mode}`)
      } catch (error) {
        if (!absent(error)) throw error
      }
    }
    return JSON.stringify(values)
  }
}

function absent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
