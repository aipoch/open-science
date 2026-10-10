import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import {
  runObservationSnapshotSchema,
  type RunObservationSnapshot,
  type RunObservationTarget
} from '../../shared/run-observation'
import {
  runObservationMediaCaptureSchema,
  type RunObservationArchiveMedia
} from '../../shared/run-observation-archive'
import {
  observationMediaCaptureRequestSchema,
  type ObservationMediaCaptureRequest,
  type ObservationMediaCaptureOptions,
  type ObservationMediaCaptureResult
} from '../../shared/run-observation-capture'
export { observationMediaCaptureRequestSchema } from '../../shared/run-observation-capture'
export type {
  ObservationMediaCaptureRequest,
  ObservationMediaCaptureOptions,
  ObservationMediaCaptureResult
} from '../../shared/run-observation-capture'
import { exceedsDecodedImagePixelLimit, readRasterImageDimensions } from '../raster-image-safety'
import type { AuxiliaryOutput, AuxiliaryOutputResult } from '../notebook/managed-auxiliary-output'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const targetSchema = z
  .object({
    projectId: id,
    sessionId: id,
    operationId: id,
    executionInvocationId: id,
    runId: id
  })
  .strict()
export type ObservationMediaTarget = z.infer<typeof targetSchema>
export type ObservationMediaBytes = { bytes: Uint8Array; reportedCapturedAt?: number }
export type ObservationMediaCaptureAccess = {
  /** Main-only closure pinned to the caller/viewer. This is not part of a request body. */
  assertAuthorized(): void
  signal?: AbortSignal
  captureHostView?(signal: AbortSignal): Promise<ObservationMediaBytes>
  /** Main-only notification for this invocation's newly persisted frame, never an idempotent retry. */
  onCreated?(): void
}
export type ObservationMediaRegistration = {
  target: ObservationMediaTarget
  generationId: string
  recording: {
    recordingId: string
    appendMedia(media: RunObservationArchiveMedia): Promise<void>
  }
  /** Revalidates original execution/environment generation. Must throw when it is no longer active. */
  assertCurrent(): void
  /** Samples now; unchanged evidence may reuse its cursor. Never reads a historical selection. */
  sampleCurrent(signal: AbortSignal): Promise<RunObservationSnapshot>
  projectExports: readonly string[]
  readProjectExport?(exportKey: string, signal: AbortSignal): Promise<ObservationMediaBytes>
  saveAuxiliaryOutput(output: AuxiliaryOutput): Promise<AuxiliaryOutputResult>
  signal?: AbortSignal
}
type ErrorCode =
  | 'unavailable'
  | 'unauthorized'
  | 'invalid-request'
  | 'invalid-image'
  | 'capacity'
  | 'idempotency-conflict'
  | 'save-failed'
  | 'stale-observation'
export class ObservationMediaCaptureError extends Error {
  readonly name = 'ObservationMediaCaptureError'
  constructor(readonly code: ErrorCode) {
    super('The observation image could not be captured.')
  }
}
type CaptureOperation = {
  fingerprint: string
  result: Promise<ObservationMediaCaptureResult>
  /** Only a settled failure before the writer was called is safe to try again. */
  retryable: boolean
}
type CaptureAttempt = { writeStarted: boolean; reservedBytes: number }
type Entry = {
  registration: ObservationMediaRegistration
  controller: AbortController
  queue: Promise<void>
  operations: Map<string, CaptureOperation>
  frames: Map<string, { bytes: Buffer; result: ObservationMediaCaptureResult }>
  bytes: number
  lastSample?: { epoch: string; sequence: number }
  dispose(): void
}
const hash = (body: string | Uint8Array): string => createHash('sha256').update(body).digest('hex')
const keyOf = (target: ObservationMediaTarget): string => JSON.stringify(target)
const sameTarget = (target: ObservationMediaTarget, snapshot: RunObservationSnapshot): boolean =>
  (Object.keys(target) as (keyof ObservationMediaTarget)[]).every(
    (key) => target[key] === snapshot.identity[key]
  )

/** Independent optional image intake. It cannot start a Run, choose an old step or acquire a path. */
export class ObservationMediaCollector {
  private readonly entries = new Map<string, Entry>()
  private readonly drains = new Set<Promise<void>>()
  private readonly waiters: Array<() => void> = []
  private active = 0
  private closed = false
  constructor(
    private readonly settings: {
      now?: () => number
      maxRegistrations?: number
      maxCapturesPerRecording?: number
      maxPendingPerRecording?: number
      maxImageBytes?: number
      maxRecordingBytes?: number
    } = {}
  ) {
    for (const [key, ceiling] of [
      ['maxRegistrations', 8],
      ['maxCapturesPerRecording', 2000],
      ['maxPendingPerRecording', 4],
      ['maxImageBytes', 16 * 1024 * 1024],
      ['maxRecordingBytes', 64 * 1024 * 1024]
    ] as const) {
      const value = settings[key]
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > ceiling))
        throw new ObservationMediaCaptureError('invalid-request')
    }
  }

  register(input: ObservationMediaRegistration): { close(): Promise<void> } {
    const target = targetSchema.parse(input.target)
    id.parse(input.generationId)
    id.parse(input.recording.recordingId)
    if (
      this.closed ||
      this.entries.size >= (this.settings.maxRegistrations ?? 8) ||
      this.entries.has(keyOf(target))
    )
      throw new ObservationMediaCaptureError('unavailable')
    input.assertCurrent()
    input.signal?.throwIfAborted()
    if (
      input.projectExports.length > 100 ||
      input.projectExports.some(
        (key) =>
          !key ||
          key.length > 512 ||
          /[\\/]/.test(key) ||
          [...key].some((character) => character.charCodeAt(0) < 32) ||
          key === '.' ||
          key === '..'
      )
    )
      throw new ObservationMediaCaptureError('invalid-request')
    const controller = new AbortController()
    const entry: Entry = {
      registration: { ...input, target, projectExports: [...new Set(input.projectExports)] },
      controller,
      queue: Promise.resolve(),
      operations: new Map(),
      frames: new Map(),
      bytes: 0,
      dispose: () => input.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      void this.closeEntry(entry)
    }
    this.entries.set(keyOf(target), entry)
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    return { close: () => this.closeEntry(entry) }
  }

  options(
    target: RunObservationTarget,
    access: { assertAuthorized(): void; hostViewAvailable?: boolean }
  ): ObservationMediaCaptureOptions {
    try {
      access.assertAuthorized()
    } catch {
      throw new ObservationMediaCaptureError('unauthorized')
    }
    const parsed = targetSchema.safeParse(target)
    const entry = parsed.success ? this.entries.get(keyOf(parsed.data)) : undefined
    if (!entry) return { hostView: false, projectExports: [] }
    this.assert(entry, access, entry.controller.signal)
    return {
      hostView: access.hostViewAvailable === true,
      projectExports: entry.registration.readProjectExport
        ? [...entry.registration.projectExports]
        : []
    }
  }

  listFrames(
    target: RunObservationTarget,
    access: Pick<ObservationMediaCaptureAccess, 'assertAuthorized' | 'signal'>
  ): ObservationMediaCaptureResult[] {
    const entry = this.readEntry(target, access)
    return entry ? [...entry.frames.values()].map((frame) => structuredClone(frame.result)) : []
  }

  readFrame(
    target: RunObservationTarget,
    captureId: string,
    access: Pick<ObservationMediaCaptureAccess, 'assertAuthorized' | 'signal'>
  ): { bytes: Uint8Array; mimeType: ObservationMediaCaptureResult['mimeType'] } | undefined {
    const entry = this.readEntry(target, access)
    if (!id.safeParse(captureId).success) throw new ObservationMediaCaptureError('invalid-request')
    const frame = entry?.frames.get(captureId)
    return frame ? { bytes: Buffer.from(frame.bytes), mimeType: frame.result.mimeType } : undefined
  }

  private readEntry(
    target: RunObservationTarget,
    access: Pick<ObservationMediaCaptureAccess, 'assertAuthorized' | 'signal'>
  ): Entry | undefined {
    try {
      access.assertAuthorized()
    } catch {
      throw new ObservationMediaCaptureError('unauthorized')
    }
    if (access.signal?.aborted) throw new ObservationMediaCaptureError('unavailable')
    const parsed = targetSchema.safeParse(target)
    const entry = parsed.success ? this.entries.get(keyOf(parsed.data)) : undefined
    if (!entry) return undefined
    this.assert(entry, access, entry.controller.signal)
    return entry
  }

  async capture(
    target: RunObservationTarget,
    value: unknown,
    access: ObservationMediaCaptureAccess
  ): Promise<ObservationMediaCaptureResult> {
    try {
      const parsedTarget = targetSchema.parse(target)
      const request = observationMediaCaptureRequestSchema.parse(value)
      const entry = this.entries.get(keyOf(parsedTarget))
      if (!entry) throw new ObservationMediaCaptureError('unavailable')
      const signal = AbortSignal.any([
        entry.controller.signal,
        ...(access.signal ? [access.signal] : [])
      ])
      const assert = (): void => this.assert(entry, access, signal)
      assert()
      if (
        request.source === 'host-view'
          ? !access.captureHostView
          : !entry.registration.readProjectExport ||
            !entry.registration.projectExports.includes(request.exportKey)
      )
        throw new ObservationMediaCaptureError('unavailable')
      const fingerprint = JSON.stringify(request)
      const previous = entry.operations.get(request.idempotencyKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ObservationMediaCaptureError('idempotency-conflict')
        if (!previous.retryable) {
          const result = await previous.result
          assert()
          return structuredClone(result)
        }
      }
      if (!previous && entry.operations.size >= (this.settings.maxCapturesPerRecording ?? 128))
        throw new ObservationMediaCaptureError('capacity')
      const pending = [...entry.operations.values()].filter(
        (operation) => !operation.retryable && this.pending.has(operation.result)
      ).length
      if (pending >= (this.settings.maxPendingPerRecording ?? 4))
        throw new ObservationMediaCaptureError('capacity')
      const attempt: CaptureAttempt = { writeStarted: false, reservedBytes: 0 }
      const result = entry.queue
        .then(async () => {
          assert()
          const release = await this.acquire(signal)
          try {
            return await this.perform(entry, request, access, signal, assert, attempt)
          } finally {
            release()
          }
        })
        .catch((error) => {
          if (!attempt.writeStarted) {
            // Keep the key/fingerprint, but neither consume image capacity nor poison retries
            // after a confirmed read/validation/sample failure. A writer call may have persisted
            // bytes even when its response is lost; never release or repeat that attempt here.
            entry.bytes -= attempt.reservedBytes
            attempt.reservedBytes = 0
            operation.retryable = true
          }
          if (error instanceof ObservationMediaCaptureError) throw error
          throw new ObservationMediaCaptureError('unavailable')
        })
      const operation: CaptureOperation = { fingerprint, result, retryable: false }
      this.pending.add(result)
      entry.operations.set(request.idempotencyKey, operation)
      entry.queue = result
        .then(
          () => undefined,
          () => undefined
        )
        .finally(() => this.pending.delete(result))
      const captured = await result
      assert()
      return structuredClone(captured)
    } catch (error) {
      if (error instanceof ObservationMediaCaptureError) throw error
      throw new ObservationMediaCaptureError('invalid-request')
    }
  }
  private readonly pending = new Set<Promise<ObservationMediaCaptureResult>>()

  async close(): Promise<void> {
    this.closed = true
    for (const entry of [...this.entries.values()]) void this.closeEntry(entry)
    await Promise.all([...this.drains])
  }
  private closeEntry(entry: Entry): Promise<void> {
    entry.controller.abort()
    entry.frames.clear()
    entry.dispose()
    const key = keyOf(entry.registration.target)
    if (this.entries.get(key) === entry) this.entries.delete(key)
    const drain = entry.queue.finally(() => this.drains.delete(drain))
    this.drains.add(drain)
    return drain
  }
  private assert(entry: Entry, access: ObservationMediaCaptureAccess, signal: AbortSignal): void {
    if (
      this.closed ||
      signal.aborted ||
      this.entries.get(keyOf(entry.registration.target)) !== entry
    )
      throw new ObservationMediaCaptureError('unavailable')
    try {
      access.assertAuthorized()
    } catch {
      throw new ObservationMediaCaptureError('unauthorized')
    }
    try {
      entry.registration.assertCurrent()
    } catch {
      throw new ObservationMediaCaptureError('unavailable')
    }
  }
  private async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.active >= 2)
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => {
          signal.removeEventListener('abort', aborted)
          resolve()
        }
        const aborted = (): void => {
          const index = this.waiters.indexOf(ready)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new ObservationMediaCaptureError('unavailable'))
        }
        this.waiters.push(ready)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })
    signal.throwIfAborted()
    this.active++
    return () => {
      this.active--
      this.waiters.shift()?.()
    }
  }
  private async perform(
    entry: Entry,
    request: ObservationMediaCaptureRequest,
    access: ObservationMediaCaptureAccess,
    signal: AbortSignal,
    assert: () => void,
    attempt: CaptureAttempt
  ): Promise<ObservationMediaCaptureResult> {
    const now = this.settings.now ?? Date.now
    const registration = entry.registration
    assert()
    const startedAt = now()
    const source =
      request.source === 'host-view'
        ? await access.captureHostView!(signal)
        : await registration.readProjectExport!(request.exportKey, signal)
    assert()
    const finishedAt = Math.max(now(), startedAt)
    if (
      !(source.bytes instanceof Uint8Array) ||
      !source.bytes.byteLength ||
      source.bytes.byteLength > (this.settings.maxImageBytes ?? 16 * 1024 * 1024)
    )
      throw new ObservationMediaCaptureError('invalid-image')
    const bytes = Buffer.from(source.bytes)
    const image = await this.validateImage(bytes)
    assert()
    if (entry.bytes + bytes.length > (this.settings.maxRecordingBytes ?? 64 * 1024 * 1024))
      throw new ObservationMediaCaptureError('capacity')
    entry.bytes += bytes.length
    attempt.reservedBytes = bytes.length
    const snapshot = runObservationSnapshotSchema.parse(await registration.sampleCurrent(signal))
    assert()
    if (
      !sameTarget(registration.target, snapshot) ||
      snapshot.run?.runId !== registration.target.runId ||
      snapshot.run.status !== 'running' ||
      (entry.lastSample &&
        (entry.lastSample.epoch !== snapshot.cursor.epoch ||
          entry.lastSample.sequence > snapshot.cursor.sequence))
    )
      throw new ObservationMediaCaptureError('stale-observation')
    entry.lastSample = snapshot.cursor
    const capture = runObservationMediaCaptureSchema.parse({
      source: request.source,
      association: 'current-observation',
      startedAt,
      finishedAt,
      observedAt: snapshot.observedAt,
      width: image.width,
      height: image.height,
      ...(request.source === 'project-export' && source.reportedCapturedAt !== undefined
        ? { reportedCapturedAt: source.reportedCapturedAt }
        : {})
    })
    const captureId = hash(
      JSON.stringify([
        registration.target,
        registration.generationId,
        registration.recording.recordingId,
        request.idempotencyKey
      ])
    )
    const filename = `replay-frame-${captureId}.${image.extension}`
    const checksum = hash(bytes)
    let verifiedWrite = false
    attempt.writeStarted = true
    const saved = await registration.saveAuxiliaryOutput({
      filename,
      contentType: image.mimeType,
      source: { kind: 'inline', content: bytes.toString('base64'), encoding: 'base64' },
      publication: {
        beforeWrite: async (attempt) => {
          assert()
          if (
            attempt.request.projectId !== registration.target.projectId ||
            attempt.request.appSessionId !== registration.target.sessionId ||
            attempt.request.filename !== filename ||
            attempt.request.contentType !== image.mimeType ||
            attempt.request.producerRunId ||
            attempt.source.producerRunId ||
            attempt.source.producerProvenance ||
            attempt.source.kind !== 'inline' ||
            attempt.source.sha256 !== checksum ||
            attempt.source.sizeBytes !== bytes.length
          )
            throw new ObservationMediaCaptureError('save-failed')
          verifiedWrite = true
        }
      }
    })
    assert()
    if (saved.status !== 'saved' || !verifiedWrite)
      throw new ObservationMediaCaptureError('save-failed')
    const artifact = saved.artifact
    if (
      artifact.projectId !== registration.target.projectId ||
      artifact.sessionId !== registration.target.sessionId ||
      artifact.name !== filename ||
      artifact.checksum !== checksum ||
      artifact.size !== bytes.length ||
      artifact.producerRunId
    )
      throw new ObservationMediaCaptureError('save-failed')
    const stepKey = `observation-${snapshot.cursor.sequence}`
    await registration.recording.appendMedia({
      mediaKey: captureId,
      name: filename,
      mimeType: image.mimeType,
      checksum,
      sizeBytes: bytes.length,
      sourceVersionId: artifact.versionId,
      stepKeys: [stepKey],
      capture
    })
    assert()
    const result: ObservationMediaCaptureResult = {
      captureId,
      recordingId: registration.recording.recordingId,
      stepKey,
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      checksum,
      sizeBytes: bytes.length,
      mimeType: image.mimeType,
      publication: artifact.isPublished === true ? 'published' : 'awaiting-publication',
      capture
    }
    entry.frames.set(captureId, { bytes, result: structuredClone(result) })
    try {
      access.onCreated?.()
    } catch {
      // Notification failure must not reclassify an already saved and associated frame as failed.
    }
    return result
  }
  private async validateImage(bytes: Buffer): Promise<{
    width: number
    height: number
    mimeType: ObservationMediaCaptureResult['mimeType']
    extension: string
  }> {
    try {
      const detected = (['image/png', 'image/jpeg', 'image/webp'] as const)
        .map((mimeType) => ({ mimeType, dimensions: readRasterImageDimensions(bytes, mimeType) }))
        .find((entry) => !!entry.dimensions)
      if (!detected?.dimensions || exceedsDecodedImagePixelLimit(detected.dimensions))
        throw new Error()
      const decoder = sharp(bytes, {
        limitInputPixels: 16_000_000,
        failOn: 'warning',
        animated: false
      })
      const metadata = await decoder.metadata()
      const transposed = (metadata.orientation ?? 1) >= 5
      if (
        (metadata.pages ?? 1) !== 1 ||
        `image/${metadata.format}` !== detected.mimeType ||
        (transposed ? metadata.height : metadata.width) !== detected.dimensions.width ||
        (transposed ? metadata.width : metadata.height) !== detected.dimensions.height
      )
        throw new Error()
      await decoder.stats()
      return {
        ...detected.dimensions,
        mimeType: detected.mimeType,
        extension: detected.mimeType === 'image/jpeg' ? 'jpg' : detected.mimeType.slice(6)
      }
    } catch {
      throw new ObservationMediaCaptureError('invalid-image')
    }
  }
}
