import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import type { DownloadProgress } from '../../shared/download-progress'
import { SpeedMeter } from './download-speed'

export class DownloadChecksumError extends Error {
  constructor(message = 'Checksum mismatch') {
    super(message)
    this.name = 'DownloadChecksumError'
  }
}

export type ResilientDownloadDeps = {
  fetchImpl?: typeof fetch
  createWriteStreamImpl?: (path: string, opts?: { flags?: string }) => WriteStream
  statImpl?: (path: string) => Promise<{ size: number }>
  rmImpl?: (path: string) => Promise<void>
  renameImpl?: (from: string, to: string) => Promise<void>
  openReadStreamImpl?: (path: string) => NodeJS.ReadableStream
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type ResilientDownloadOpts = {
  expectedSha256?: string
  expectedSize?: number
  maxRetries?: number
  stallTimeoutMs?: number
  signal?: AbortSignal
  onProgress?: (p: DownloadProgress) => void
  deps?: ResilientDownloadDeps
}

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_STALL_MS = 60_000
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

// Signals that a server closed the stream before delivering all expected bytes (short read).
class IncompleteStreamError extends Error {}

const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')

export const resilientDownload = async (
  url: string,
  destPath: string,
  opts: ResilientDownloadOpts = {}
): Promise<string> => {
  const d = opts.deps ?? {}
  const fetchImpl = d.fetchImpl ?? fetch
  const mkWrite = d.createWriteStreamImpl ?? ((p, o) => createWriteStream(p, o))
  const statFile = d.statImpl ?? ((p) => stat(p))
  const removeFile = d.rmImpl ?? ((p) => rm(p, { force: true }))
  const renameFile = d.renameImpl ?? rename
  const openRead = d.openReadStreamImpl ?? ((p) => createReadStream(p))
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = d.now ?? (() => Date.now())
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS
  const partPath = `${destPath}.part`

  const partSize = async (): Promise<number> => {
    try {
      return (await statFile(partPath)).size
    } catch {
      return 0
    }
  }

  // Re-feed the existing .part into the hash so a resumed download's digest covers the whole file.
  const seedHash = async (
    hash: ReturnType<typeof createHash>,
    bytes: number
  ): Promise<void> => {
    if (bytes <= 0) return
    await new Promise<void>((resolve, reject) => {
      const rs = openRead(partPath)
      ;(rs as NodeJS.ReadableStream).on('data', (c: Buffer) => hash.update(c))
      ;(rs as NodeJS.ReadableStream).on('end', () => resolve())
      ;(rs as NodeJS.ReadableStream).on('error', reject)
    })
  }

  // Resolves after `ms` ms but rejects early when the external abort signal fires, so a user
  // cancel during exponential backoff does not wait up to MAX_BACKOFF_MS before taking effect.
  const sleepOrAbort = (sleepFn: typeof sleep, ms: number, signal?: AbortSignal): Promise<void> => {
    if (!signal) return sleepFn(ms)
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    return Promise.race([
      sleepFn(ms),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new Error('aborted')),
          { once: true }
        )
      })
    ])
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted')

    if (attempt > 0) {
      const offset = await partSize()
      opts.onProgress?.({ phase: 'reconnecting', transferred: offset, bytesPerSecond: 0, attempt })
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      // Race the backoff sleep against the external abort signal so a user cancel does not wait up
      // to MAX_BACKOFF_MS before taking effect.
      await sleepOrAbort(sleep, backoff + Math.floor((now() % 1000) / 4), opts.signal)
    }

    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(
        () => controller.abort(new Error(`stalled >${stallMs}ms`)),
        stallMs
      )
    }
    const combined = opts.signal
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal

    // Hoisted so the catch path can destroy the descriptor before the next retry attempt,
    // preventing descriptor leaks and Windows rename/append failures on a retried .part file.
    let file: WriteStream | undefined
    let fileError: Error | null = null

    try {
      let offset = await partSize()
      const headers: Record<string, string> = {}
      if (offset > 0) headers['Range'] = `bytes=${offset}-`

      armStall()
      const res = await fetchImpl(url, { headers, signal: combined })

      if (res.status >= 500) throw new Error(`server error ${res.status}`)
      if (res.status >= 400 && res.status < 500) {
        // Terminal: 4xx errors are not transient network problems.
        const err = new Error(`request failed (${res.status})`)
        ;(err as { terminal?: boolean }).terminal = true
        throw err
      }
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`unexpected status ${res.status}`)
      }
      if (!res.body) throw new Error('response had no body')

      // Server returned 200 while we had a partial — it ignored Range, so discard and restart.
      const resuming = res.status === 206 && offset > 0
      if (!resuming && offset > 0) {
        await removeFile(partPath)
        offset = 0
      }

      const hash = createHash('sha256')
      await seedHash(hash, offset)

      const rawContentLength = Number(res.headers.get('content-length'))
      const total =
        rawContentLength > 0
          ? offset + rawContentLength
          : opts.expectedSize
      const meter = new SpeedMeter({ now })
      let transferred = offset
      meter.record(transferred)
      opts.onProgress?.({
        phase: 'downloading',
        transferred,
        total,
        percent: total ? Math.round((transferred / total) * 100) : undefined,
        bytesPerSecond: 0,
        attempt
      })

      file = mkWrite(partPath, offset > 0 ? { flags: 'a' } : undefined)
      file.on('error', (e) => (fileError = e))

      const nodeStream = Readable.fromWeb(
        res.body as unknown as NodeReadableStream<Uint8Array>
      )
      for await (const chunk of nodeStream) {
        if (fileError) throw fileError
        const buf = Buffer.from(chunk as Uint8Array)
        hash.update(buf)
        await new Promise<void>((resolve, reject) =>
          file!.write(buf, (e) => (e ? reject(e) : resolve()))
        )
        transferred += buf.length
        meter.record(transferred)
        armStall()
        const bps = meter.bytesPerSecond()
        opts.onProgress?.({
          phase: 'downloading',
          transferred,
          total,
          percent: total ? Math.round((transferred / total) * 100) : undefined,
          bytesPerSecond: bps,
          etaSeconds: meter.etaSeconds(total),
          attempt
        })
      }

      await new Promise<void>((resolve, reject) =>
        file!.end((e?: Error | null) => (e ? reject(e) : resolve()))
      )
      file = undefined // fd closed cleanly — no cleanup needed in catch
      if (stallTimer) clearTimeout(stallTimer)
      if (fileError) throw fileError

      // A short read (stream closed before content-length) — retry with Range.
      if (total != null && transferred < total) throw new IncompleteStreamError('short read')

      if (opts.expectedSha256 && hash.digest('hex') !== opts.expectedSha256) {
        await removeFile(partPath)
        throw new DownloadChecksumError()
      }

      await renameFile(partPath, destPath)
      opts.onProgress?.({
        phase: 'downloading',
        transferred,
        total: total ?? transferred,
        percent: 100,
        bytesPerSecond: 0,
        etaSeconds: 0,
        attempt
      })
      return destPath
    } catch (error) {
      if (stallTimer) clearTimeout(stallTimer)
      // Close any open write descriptor before the next retry so the .part file is not held open
      // across attempts (prevents descriptor leaks and Windows rename/append failures).
      if (file !== undefined) {
        const f = file
        file = undefined
        await new Promise<void>((resolve) => {
          if (f.destroyed) { resolve(); return }
          f.once('close', resolve)
          f.destroy()
        })
      }
      // Terminal errors: never retry.
      if (error instanceof DownloadChecksumError) throw error
      if ((error as { terminal?: boolean }).terminal) throw error
      if (opts.signal?.aborted) throw opts.signal.reason ?? error
      if (isAbortError(error) && !controller.signal.aborted) throw error
      lastError = error
      fileError = null // reset per-attempt error tracker
      // Retryable (network/stall/5xx/incomplete) — continue to next attempt.
    }
  }
  throw lastError ?? new Error('download failed after retries')
}
