import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  lstat,
  open,
  type FileHandle
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const RESOURCE_LOG_LIMIT = 64 * 1024 * 1024
const WINDOW_LIMIT = RESOURCE_LOG_LIMIT / 2 - 4096
const SEGMENT_LIMIT = 4 * 1024 * 1024
const QUEUE_LIMIT = 1024 * 1024
const RATE_LIMIT = 64 * 1024
const SEGMENT = /^(live|incident)-(\d{8})\.jsonl$/

type Entry = { line: string; bytes: number; anomaly: boolean }
type Segment = { name: string; bytes: number }
type StoreOptions = {
  directory: string
  // Existing application-owned boundary; never create or follow a link at this root.
  rootDirectory?: string
  preserveLive?: boolean
  windowBytes?: number
  segmentBytes?: number
  queueBytes?: number
  rateBytes?: number
  now?: () => number
  onFailure?: () => void
  // Fault-injection seam; production always uses the asynchronous filesystem writer.
  write?: (file: FileHandle, data: Buffer, position: number) => Promise<void>
}

const writeSegment = async (file: FileHandle, data: Buffer, position: number): Promise<void> => {
  let offset = 0
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset)
    if (!bytesWritten) throw new Error('Resource log write made no progress')
    offset += bytesWritten
  }
}

// Dedicated, bounded diagnostic storage. The caller owns the containing runtime directory.
// Markers are one byte; sealing only renames bounded segments, never copies a second window.
export class ResourceLogStore {
  private readonly directory: string
  private readonly windowBytes: number
  private readonly segmentBytes: number
  private readonly queueBytes: number
  private readonly rateBytes: number
  private readonly now: () => number
  private readonly ready: Promise<void>
  private live: Segment[] = []
  private nextSegment = 0
  private resumed = false
  private queue: Entry[] = []
  private pendingBytes = 0
  private rateStarted = 0
  private rateUsed = 0
  private sealingAt = -Infinity
  private draining: Promise<void> | undefined
  private closed = false
  private failed = false
  private retryAt = 0
  private retryCount = 0
  private partial: Segment | undefined
  private writer: { segment: Segment; handle: FileHandle; ino: bigint; dev: bigint } | undefined
  private anomalyQueued = false
  private checkpoint: (() => string) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private suspended = false
  dropped = 0
  sealsSuppressed = 0
  rotatedBytes = 0
  writeFailures = 0

  constructor(private readonly options: StoreOptions) {
    this.directory = options.directory
    this.windowBytes = Math.min(options.windowBytes ?? WINDOW_LIMIT, WINDOW_LIMIT)
    this.segmentBytes = Math.min(options.segmentBytes ?? SEGMENT_LIMIT, this.windowBytes)
    this.queueBytes = Math.min(options.queueBytes ?? QUEUE_LIMIT, QUEUE_LIMIT)
    this.rateBytes = Math.min(options.rateBytes ?? RATE_LIMIT, RATE_LIMIT)
    this.now = options.now ?? Date.now
    this.ready = this.initialize().catch(() => this.fail())
  }

  private path(name: string): string {
    return join(this.directory, name)
  }

  private fail(): void {
    if (this.failed) return
    this.failed = true
    this.dropped += this.queue.length
    this.queue = []
    this.pendingBytes = 0
    clearTimeout(this.timer)
    try {
      this.options.onFailure?.()
    } catch {
      /* Diagnostics cannot affect the caller. */
    }
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await stat(this.path(name))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async segments(kind: 'live' | 'incident'): Promise<Segment[]> {
    const result: Segment[] = []
    for (const name of await readdir(this.directory)) {
      const match = SEGMENT.exec(name)
      if (match?.[1] !== kind) continue
      const info = await lstat(this.path(name))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid resource log segment')
      result.push({ name, bytes: info.size })
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async initialize(): Promise<void> {
    const root = resolve(this.options.rootDirectory ?? dirname(this.directory))
    const suffix = relative(root, resolve(this.directory))
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
      throw new Error('Resource log directory is outside its root')
    let current = root
    // Check each boundary before descending or creating a child. Recursive mkdir would
    // follow an existing logs junction and mutate its target before checking the leaf.
    for (const part of ['', ...suffix.split(sep)]) {
      if (part) {
        current = join(current, part)
        try {
          await mkdir(current)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const directory = await lstat(current)
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('Invalid resource log directory')
    }
    // Only this version's fixed names may be mutated. Unknown contents are preserved fail-closed.
    const names = await readdir(this.directory)
    if (names.some((name) => !SEGMENT.test(name) && name !== 'open' && name !== 'seal.pending')) {
      throw new Error('Unknown resource log contents')
    }
    for (const marker of ['open', 'seal.pending']) {
      if (await this.exists(marker)) {
        const info = await lstat(this.path(marker))
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1)
          throw new Error('Invalid resource log marker')
      }
    }
    this.live = await this.segments('live')
    const incident = await this.segments('incident')
    if (
      [this.live, incident].some(
        (items) =>
          items.some((item) => item.bytes > SEGMENT_LIMIT) ||
          items.reduce((sum, item) => sum + item.bytes, 0) > WINDOW_LIMIT
      )
    ) {
      throw new Error('Resource log window is inconsistent')
    }
    if (
      [...this.live, ...incident].reduce((sum, item) => sum + item.bytes, 0) >
      RESOURCE_LOG_LIMIT - 4096
    ) {
      throw new Error('Resource log budget is inconsistent')
    }
    if (await this.exists('seal.pending')) await this.finishSeal()
    if (await this.exists('open')) await this.seal()
    else if (!this.options.preserveLive) {
      for (const item of this.live) await rm(this.path(item.name))
      this.live = []
    }
    // Explicit stop/start retains completed recordings. Never reopen a previous segment for
    // writing: its identity may have changed while recording was disabled.
    if (this.live.length) {
      this.nextSegment = Number(this.live.at(-1)!.name.slice(5, 13)) + 1
      this.resumed = true
    }
    // Previous-run evidence is sealed before replacing its marker. Unlinking never writes
    // through a file link; exclusive creation rejects any entry inserted before the open.
    await rm(this.path('open'), { force: true })
    await writeFile(this.path('open'), '1', { flag: 'wx' })
  }

  // Serialized by the writer. A pending marker makes a partially renamed window recoverable.
  private async finishSeal(): Promise<void> {
    for (const item of this.live) {
      const target = item.name.replace('live-', 'incident-')
      if (await this.exists(target)) throw new Error('Conflicting resource log segment')
      await rename(this.path(item.name), this.path(target))
    }
    this.live = []
    this.nextSegment = 0
    await rm(this.path('seal.pending'), { force: true })
  }

  private async seal(): Promise<void> {
    if (!this.live.length) return
    await this.closeWriter()
    for (const item of await this.segments('incident')) await rm(this.path(item.name))
    await writeFile(this.path('seal.pending'), '1', { flag: 'wx' })
    await this.finishSeal()
  }

  append(line: string, anomaly = false, sampled = false): boolean {
    if (this.closed || this.failed) return false
    const bytes = Buffer.byteLength(line)
    const now = this.now()
    const reserve = Math.min(64 * 1024, Math.floor(this.queueBytes / 16))
    const priority =
      anomaly && !this.anomalyQueued && now - this.sealingAt >= 60_000 && bytes <= reserve
    if (now - this.rateStarted >= 1000) {
      this.rateStarted = now
      this.rateUsed = 0
    }
    if (
      !line.endsWith('\n') ||
      bytes > this.segmentBytes ||
      bytes + this.pendingBytes > this.queueBytes - (priority ? 0 : reserve) ||
      (!sampled && !priority && bytes + this.rateUsed > this.rateBytes)
    ) {
      this.dropped++
      return false
    }
    if (!sampled && !priority) this.rateUsed += bytes
    if (priority) this.anomalyQueued = true
    this.pendingBytes += bytes
    this.queue.push({ line, bytes, anomaly })
    this.scheduleFlush()
    return true
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended
    if (suspended) {
      clearTimeout(this.timer)
      this.timer = undefined
    } else this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (
      this.timer ||
      this.draining ||
      this.closed ||
      this.failed ||
      this.suspended ||
      !this.queue.length
    )
      return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.flush()
      },
      Math.max(1000, this.retryAt - this.now())
    )
    this.timer.unref()
  }

  setCheckpoint(checkpoint: () => string): void {
    this.checkpoint = checkpoint
  }

  flush(): Promise<void> {
    if (this.draining) return this.draining
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.suspended && !this.closed) return Promise.resolve()
    this.draining = this.drain()
      .catch(() => this.fail())
      .finally(async () => {
        if (this.failed || this.closed) await this.closeWriter().catch(() => this.fail())
        this.draining = undefined
        this.scheduleFlush()
      })
    return this.draining
  }

  private async drain(): Promise<void> {
    await this.ready
    if (this.now() < this.retryAt) return
    if (this.partial) {
      try {
        // A write may have written a prefix before reporting ENOSPC. Restore the last known
        // boundary before retrying; a crash instead leaves only an ignorable partial final line.
        const handle = await this.writerFor(this.partial)
        await handle.truncate(this.partial.bytes)
        this.partial = undefined
      } catch (error) {
        if (this.retry(error)) return
        throw error
      }
    }
    while (this.queue.length && !this.failed && (!this.suspended || this.closed)) {
      let segment = this.live.at(-1)
      const first = this.queue[0]
      if (this.resumed || !segment || segment.bytes + first.bytes > this.segmentBytes) {
        this.resumed = false
        if (this.nextSegment >= 100_000_000) throw new Error('Resource segment sequence exhausted')
        segment = { name: `live-${String(this.nextSegment++).padStart(8, '0')}.jsonl`, bytes: 0 }
        this.live.push(segment)
      }
      const batch: Entry[] = []
      let prefix = ''
      if (segment.bytes === 0 && this.checkpoint) {
        try {
          const line = this.checkpoint()
          if (
            line.endsWith('\n') &&
            Buffer.byteLength(line) <= Math.min(64 * 1024, this.segmentBytes - first.bytes)
          )
            prefix = line
          else this.dropped++
        } catch {
          this.dropped++
        }
      }
      let bytes = Buffer.byteLength(prefix)
      for (const entry of this.queue) {
        if (
          segment.bytes + bytes + entry.bytes > this.segmentBytes ||
          bytes + entry.bytes > this.windowBytes
        )
          break
        batch.push(entry)
        bytes += entry.bytes
        if (entry.anomaly) break
      }
      while (this.live.reduce((sum, item) => sum + item.bytes, 0) + bytes > this.windowBytes) {
        const oldest = this.live[0]
        if (oldest === segment) throw new Error('Resource record exceeds window')
        await rm(this.path(oldest.name))
        this.live.shift()
        this.rotatedBytes += oldest.bytes
      }
      try {
        const handle = await this.writerFor(segment)
        await (this.options.write ?? writeSegment)(
          handle,
          Buffer.from(prefix + batch.map((entry) => entry.line).join('')),
          segment.bytes
        )
      } catch (error) {
        // A failed exclusive open has not written a prefix and must not trigger truncation.
        if (this.writer?.segment === segment) this.partial = segment
        if (this.retry(error)) return
        throw error
      }
      this.retryAt = 0
      this.retryCount = 0
      segment.bytes += bytes
      this.queue.splice(0, batch.length)
      this.pendingBytes -= batch.reduce((sum, entry) => sum + entry.bytes, 0)
      if (batch.at(-1)?.anomaly) {
        this.anomalyQueued = false
        if (this.now() - this.sealingAt >= 60_000) {
          await this.seal()
          this.sealingAt = this.now()
        } else this.sealsSuppressed++
      }
    }
  }

  private async closeWriter(): Promise<void> {
    const writer = this.writer
    this.writer = undefined
    await writer?.handle.close()
  }

  private async writerFor(segment: Segment): Promise<FileHandle> {
    if (this.writer?.segment !== segment) {
      await this.closeWriter()
      // Never adopt an existing pathname, even for an empty/new segment. Keep this one handle
      // through appends and partial-write recovery, so a later path swap cannot redirect IO.
      const handle = await open(this.path(segment.name), 'wx+', 0o600)
      try {
        const info = await handle.stat({ bigint: true })
        this.writer = { segment, handle, ino: info.ino, dev: info.dev }
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    const writer = this.writer
    const [entry, opened] = await Promise.all([
      lstat(this.path(segment.name), { bigint: true }),
      writer.handle.stat({ bigint: true })
    ])
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.ino !== writer.ino ||
      entry.dev !== writer.dev ||
      opened.nlink !== 1n ||
      entry.nlink !== 1n
    ) {
      throw new Error('Resource log segment identity changed')
    }
    return writer.handle
  }

  private retry(error: unknown): boolean {
    if (
      !['ENOSPC', 'EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return false
    this.writeFailures++
    this.retryAt = this.now() + [1000, 5000, 30_000, 60_000][Math.min(this.retryCount++, 3)]
    return true
  }

  async close(clean: boolean): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    await this.flush()
    this.checkpoint = undefined
    // A failed write must not erase the evidence that this run may be incomplete.
    if (clean && !this.failed && !this.pendingBytes && !this.partial)
      await rm(this.path('open'), { force: true }).catch(() => this.fail())
  }

  get status(): {
    failed: boolean
    pendingBytes: number
    dropped: number
    sealsSuppressed: number
    rotatedBytes: number
    writeFailures: number
  } {
    return {
      failed: this.failed,
      pendingBytes: this.pendingBytes,
      dropped: this.dropped,
      sealsSuppressed: this.sealsSuppressed,
      rotatedBytes: this.rotatedBytes,
      writeFailures: this.writeFailures
    }
  }
}
