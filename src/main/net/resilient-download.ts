import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  readTextImpl?: (path: string) => Promise<string>
  writeTextImpl?: (path: string, text: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type ResilientDownloadOpts = {
  expectedSha256?: string
  // Exact byte size, normally from a manifest. It is both the short-read target and a hard write
  // ceiling, including response metadata and each streamed chunk. If this and Content-Length are
  // absent, a silently truncated stream cannot be distinguished from a complete unknown-size body.
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

// The response cannot belong to the expected representation (oversized metadata/body or an invalid
// resume range). It is terminal for this invocation, and the untrusted partial is removed after its
// write handle has been closed.
class DownloadResponseIntegrityError extends Error {}

type ResumeValidator = {
  kind: 'etag' | 'last-modified'
  value: string
}

type ResumeMetadata = {
  version: 1
  urlSha256: string
  validator: ResumeValidator
  expectedSize?: number
}

type ContentRange = {
  start: number
  end: number
  total?: number
}

// Marks an error terminal so the retry loop rethrows instead of retrying. Local filesystem faults
// (open/write/end failing with ENOSPC, EIO, EACCES, …) and rename failures are not transient network
// problems — re-downloading will not fix a full or unwritable disk, and after a partial write the
// on-disk .part can be left in a state the resume math should not paper over. Fail fast and loud.
const markTerminal = <E>(error: E): E => {
  ;(error as { terminal?: boolean }).terminal = true
  return error
}

const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')

const strongEtag = (headers: Headers): ResumeValidator | undefined => {
  const etag = headers.get('etag')?.trim()
  return etag && !etag.toLowerCase().startsWith('w/') ? { kind: 'etag', value: etag } : undefined
}

const resumeValidatorFrom = (headers: Headers): ResumeValidator | undefined => {
  const etag = strongEtag(headers)
  if (etag) return etag
  const lastModified = headers.get('last-modified')?.trim()
  return lastModified ? { kind: 'last-modified', value: lastModified } : undefined
}

const parseResumeMetadata = (text: string): ResumeMetadata | undefined => {
  try {
    const value = JSON.parse(text) as Partial<ResumeMetadata>
    const validator = value.validator
    if (
      value.version !== 1 ||
      typeof value.urlSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.urlSha256) ||
      !validator ||
      (validator.kind !== 'etag' && validator.kind !== 'last-modified') ||
      typeof validator.value !== 'string' ||
      validator.value.length === 0 ||
      (value.expectedSize !== undefined &&
        (!Number.isSafeInteger(value.expectedSize) || value.expectedSize < 0))
    ) {
      return undefined
    }
    return value as ResumeMetadata
  } catch {
    return undefined
  }
}

const parseContentRange = (value: string | null): ContentRange | undefined => {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? '')
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? undefined : Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    (total !== undefined && (!Number.isSafeInteger(total) || total <= end))
  ) {
    return undefined
  }
  return { start, end, ...(total === undefined ? {} : { total }) }
}

const parseContentLength = (value: string | null): number | undefined => {
  if (value === null) return undefined
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return undefined
  const length = Number(normalized)
  return Number.isSafeInteger(length) ? length : undefined
}

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
  const readText = d.readTextImpl ?? ((p) => readFile(p, 'utf8'))
  const writeText = d.writeTextImpl ?? ((p, text) => writeFile(p, text, 'utf8'))
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = d.now ?? (() => Date.now())
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS
  const partPath = `${destPath}.part`
  const metadataPath = `${partPath}.meta`
  const urlSha256 = createHash('sha256').update(url).digest('hex')

  const partSize = async (): Promise<number> => {
    try {
      return (await statFile(partPath)).size
    } catch {
      return 0
    }
  }
  const removeForSafety = async (path: string): Promise<void> => {
    try {
      await removeFile(path)
    } catch (error) {
      throw markTerminal(error)
    }
  }

  // Re-feed the existing .part into the hash so a resumed download's digest covers the whole file.
  const seedHash = async (hash: ReturnType<typeof createHash>, bytes: number): Promise<void> => {
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
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
          once: true
        })
      })
    ])
  }

  // Hoist the hash above the retry loop. The hash is fed bytes incrementally chunk-by-chunk during
  // each attempt; hoisting avoids re-reading the entire .part from disk on every retry (for a 200 MB
  // pack that drops at 150 MB and retries 5× that saves 5 × 150 MB = 750 MB of extra disk I/O).
  // `hashSeededTo` tracks how many bytes are accounted for in the hash so the catch path can
  // reconcile when the .part is behind the hash (partial OS flush after destroy).
  let hash = createHash('sha256')
  let hashSeededTo = 0
  let resumeValidator: ResumeValidator | undefined

  // Seed a partial retained by an earlier call only when its sidecar binds it to this exact request.
  // Current callers scope target paths to one app session, but the helper itself does not assume that.
  {
    let initial = await partSize()
    if (initial > 0) {
      const metadata = await readText(metadataPath).then(parseResumeMetadata, () => undefined)
      if (
        metadata?.urlSha256 === urlSha256 &&
        metadata.expectedSize === opts.expectedSize &&
        (opts.expectedSize == null || initial <= opts.expectedSize)
      ) {
        resumeValidator = metadata.validator
      } else {
        await removeForSafety(partPath)
        await removeForSafety(metadataPath)
        initial = 0
      }
    } else {
      // A sidecar without its .part cannot describe any resumable bytes. Remove it now so a later
      // validator-less interrupted response cannot accidentally inherit the stale validator.
      await removeForSafety(metadataPath)
    }
    await seedHash(hash, initial)
    hashSeededTo = initial
  }

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted')

    if (attempt > 0) {
      const offset = await partSize()
      // Carry the known total/percent (from the manifest expectedSize) through the reconnect so the
      // UI holds the resume position instead of collapsing to an indeterminate bar mid-retry.
      const reconnectTotal = opts.expectedSize
      opts.onProgress?.({
        phase: 'reconnecting',
        transferred: offset,
        total: reconnectTotal,
        percent:
          reconnectTotal && reconnectTotal > 0
            ? Math.round((offset / reconnectTotal) * 100)
            : undefined,
        bytesPerSecond: 0,
        attempt
      })
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      // Race the backoff sleep against the external abort signal so a user cancel does not wait up
      // to MAX_BACKOFF_MS before taking effect.
      await sleepOrAbort(sleep, backoff + Math.floor((now() % 1000) / 4), opts.signal)
    }

    const controller = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => controller.abort(new Error(`stalled >${stallMs}ms`)), stallMs)
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
      if (offset > 0 && !resumeValidator) {
        // A same-process retry is not proof that the remote representation stayed unchanged. Without
        // a strong ETag or Last-Modified value there is no valid If-Range precondition, so retaining
        // these bytes would recreate the blind cross-version splice this helper is meant to prevent.
        await removeForSafety(partPath)
        await removeForSafety(metadataPath)
        offset = 0
        hash = createHash('sha256')
        hashSeededTo = 0
      }
      const headers: Record<string, string> = {}
      if (offset > 0) {
        headers['Range'] = `bytes=${offset}-`
        if (resumeValidator) headers['If-Range'] = resumeValidator.value
      }
      const requestedValidator = offset > 0 ? resumeValidator : undefined

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

      const responseValidator = resumeValidatorFrom(res.headers)
      const contentLengthHeader = res.headers.get('content-length')
      const contentLength = parseContentLength(contentLengthHeader)
      if (contentLengthHeader !== null && contentLength === undefined) {
        throw new DownloadResponseIntegrityError('invalid Content-Length')
      }
      const contentRange =
        res.status === 206 ? parseContentRange(res.headers.get('content-range')) : undefined
      if (res.status === 206) {
        if (!contentRange || contentRange.start !== offset) {
          throw new DownloadResponseIntegrityError(`invalid Content-Range for offset ${offset}`)
        }
        if (
          opts.expectedSize != null &&
          (contentRange.end >= opts.expectedSize ||
            (contentRange.total != null && contentRange.total > opts.expectedSize))
        ) {
          throw new DownloadResponseIntegrityError(
            `Content-Range exceeds expected size ${opts.expectedSize}`
          )
        }
        if (contentLength != null && contentRange.end - contentRange.start + 1 !== contentLength) {
          throw new DownloadResponseIntegrityError(
            'Content-Range length does not match Content-Length'
          )
        }
        if (requestedValidator) {
          const responseValue = res.headers
            .get(requestedValidator.kind === 'etag' ? 'etag' : 'last-modified')
            ?.trim()
          if (responseValue && responseValue !== requestedValidator.value) {
            throw new DownloadResponseIntegrityError(
              `206 response validator does not match ${requestedValidator.kind}`
            )
          }
        }
      }

      // Server returned 200 while we had a partial — it ignored Range, so discard and restart.
      const resuming = res.status === 206 && offset > 0
      if (!resuming && offset > 0) {
        await removeForSafety(partPath)
        await removeForSafety(metadataPath)
        offset = 0
        // Reset the hoisted hash since we are restarting from byte 0.
        hash = createHash('sha256')
        hashSeededTo = 0
      } else if (offset !== hashSeededTo) {
        // The hash cursor and the on-disk .part disagree, so re-seed the hash from disk to match the
        // exact bytes we are about to resume after. This covers both directions:
        //  - offset < hashSeededTo: the .part was truncated below the cursor (partial OS flush).
        //  - offset > hashSeededTo: bytes reached disk that the hash never consumed. File writes are
        //    terminal now, so this should be unreachable — but re-seeding keeps the digest correct
        //    rather than silently skipping the gap and later failing checksum.
        hash = createHash('sha256')
        await seedHash(hash, offset)
        hashSeededTo = offset
      }
      // else: hash already covers [0, offset) — no I/O needed.

      if (!resuming) resumeValidator = responseValidator
      if (resumeValidator) {
        const metadata: ResumeMetadata = {
          version: 1,
          urlSha256,
          validator: resumeValidator,
          ...(opts.expectedSize === undefined ? {} : { expectedSize: opts.expectedSize })
        }
        try {
          await writeText(metadataPath, `${JSON.stringify(metadata)}\n`)
        } catch (metadataError) {
          throw markTerminal(metadataError)
        }
      }

      if (
        opts.expectedSize != null &&
        contentLength != null &&
        offset + contentLength > opts.expectedSize
      ) {
        throw new DownloadResponseIntegrityError(
          `response exceeds expected size (${offset + contentLength} > ${opts.expectedSize})`
        )
      }
      const total =
        opts.expectedSize ?? (contentLength == null ? undefined : offset + contentLength)
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
      // A stream 'error' is a local disk fault (ENOSPC/EIO/…), not a network problem — terminal.
      file.on('error', (e) => (fileError = markTerminal(e)))

      const nodeStream = Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>)
      for await (const chunk of nodeStream) {
        if (fileError) throw fileError
        const buf = Buffer.from(chunk as Uint8Array)
        if (opts.expectedSize != null && transferred + buf.length > opts.expectedSize) {
          throw new DownloadResponseIntegrityError(
            `response exceeds expected size (${transferred + buf.length} > ${opts.expectedSize})`
          )
        }
        // Update the hash only AFTER the write is confirmed. If the write callback rejects, the hash
        // must NOT have consumed these bytes — otherwise it runs ahead of the persisted .part and,
        // when the next attempt resumes at the same offset (no re-seed), the digest is corrupted.
        // hash, transferred, and hashSeededTo advance together in lockstep, with no await between
        // them, so a failed attempt always leaves the three consistent. A write fault is terminal:
        // a partial write may have reached disk, and re-downloading will not fix a bad disk.
        await new Promise<void>((resolve, reject) =>
          file!.write(buf, (e) => (e ? reject(markTerminal(e)) : resolve()))
        )
        hash.update(buf)
        transferred += buf.length
        hashSeededTo = transferred
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

      // Flushing/closing the fd failed — a local disk fault, terminal like the per-chunk writes.
      await new Promise<void>((resolve, reject) =>
        file!.end((e?: Error | null) => (e ? reject(markTerminal(e)) : resolve()))
      )
      file = undefined // fd closed cleanly — no cleanup needed in catch
      if (stallTimer) clearTimeout(stallTimer)
      if (fileError) throw fileError

      // A short read (stream closed before content-length) — retry with Range.
      if (total != null && transferred < total) throw new IncompleteStreamError('short read')

      if (opts.expectedSha256 && hash.digest('hex') !== opts.expectedSha256) {
        // digest() has finalized the hash, so it can never be reused on a retry. Guarantee the
        // DownloadChecksumError is what propagates: if the .part cleanup itself fails (EACCES/EIO),
        // swallow that error rather than let it escape — otherwise the loop would retry with a dead
        // hash. A leftover .part is harmless (the next run re-checks or overwrites it).
        await removeFile(partPath).catch(() => undefined)
        await removeFile(metadataPath).catch(() => undefined)
        throw new DownloadChecksumError()
      }

      // Finalization. digest() above consumed the hash, so it cannot be reused; and a rename failure
      // (EXDEV, EPERM, disk full) is not a transient network fault. Mark any error here terminal so
      // the retry loop does not spin on a dead hash or a rename that will never succeed.
      try {
        await renameFile(partPath, destPath)
      } catch (renameError) {
        throw markTerminal(renameError)
      }
      await removeFile(metadataPath).catch(() => undefined)
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
          if (f.destroyed) {
            resolve()
            return
          }
          f.once('close', resolve)
          f.destroy()
        })
      }
      // Terminal errors: never retry.
      if (error instanceof DownloadChecksumError) throw error
      if (error instanceof DownloadResponseIntegrityError) {
        await removeFile(partPath).catch(() => undefined)
        await removeFile(metadataPath).catch(() => undefined)
        throw error
      }
      if ((error as { terminal?: boolean }).terminal) {
        await removeFile(metadataPath).catch(() => undefined)
        throw error
      }
      if (opts.signal?.aborted) throw opts.signal.reason ?? error
      if (isAbortError(error) && !controller.signal.aborted) throw error
      lastError = error
      fileError = null // reset per-attempt error tracker
      // Retryable (network/stall/5xx/incomplete) — continue to next attempt.
    }
  }
  throw lastError ?? new Error('download failed after retries')
}
