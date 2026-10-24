import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import {
  MAX_PROJECT_RECORDING_BYTES,
  MAX_PROJECT_RECORDING_ITEMS,
  MAX_PROJECT_RECORDING_MEDIA_BYTES,
  projectRecordingFrameSchema,
  projectRecordingEventSchema,
  projectRecordingSourceSchema,
  projectRecordingStateSchema,
  validateProjectRecording,
  type ProjectRecording,
  type ProjectRecordingSource,
  type ProjectRecordingValue
} from '../../shared/project-recording'
import { exceedsDecodedImagePixelLimit, readRasterImageDimensions } from '../raster-image-safety'
import type { AuxiliaryOutput, AuxiliaryOutputResult } from '../notebook/managed-auxiliary-output'
import { PROJECT_RECORDING_DATA_FILENAME } from '../../shared/project-recording-data'
import {
  ProjectRecordingDeclarations,
  type ProjectRecordingDeclarationSource
} from './declarations'
export type { ProjectRecordingDeclarationSource } from './declarations'

export type ProjectRecordingCaptureSource = Readonly<{
  /** Main-owned source identity; no untrusted URL, path or executable request is accepted. */
  key: string
  kind: 'project-export' | 'host-view'
  read(signal: AbortSignal): Promise<{ bytes: Uint8Array; reportedCapturedAt?: number }>
}>
export type ProjectRecordingWarning =
  'capture-failed' | 'capacity' | 'invalid-declaration' | 'publication-failed' | 'interrupted'
export type ProjectRecordingResult =
  | {
      status: 'saved'
      recording: ProjectRecording
      artifact: ArtifactVersionFile
      warnings: readonly ProjectRecordingWarning[]
    }
  | { status: 'unavailable'; warnings: readonly ProjectRecordingWarning[] }
export type ProjectRecordingHandle = Readonly<{
  recordingId: string
  /** Coalesced with any pending sample. Never starts a second concurrent capture. */
  sample(): Promise<void>
  recordState(input: {
    label?: string
    value: ProjectRecordingValue
    sourceId?: string
    reportedAt?: number
  }): Promise<void>
  recordEvent(input: {
    name: string
    data?: ProjectRecordingValue
    sourceId?: string
    reportedAt?: number
  }): Promise<void>
  /** Stops timers, drains admitted work, publishes one immutable index; idempotent. */
  finish(reason?: ProjectRecording['coverage']['stopReason']): Promise<ProjectRecordingResult>
  /** Stops capture and drains work. Call finish afterwards to publish the partial evidence. */
  abort(): Promise<void>
}>
export type ProjectRecordingOptions = Readonly<{
  recordingId: string
  title?: string
  source?: ProjectRecordingSource
  sources: readonly ProjectRecordingCaptureSource[]
  declarations?: readonly ProjectRecordingDeclarationSource[]
  save(output: AuxiliaryOutput): Promise<AuxiliaryOutputResult>
  /** Checks original producer generation/authority before and after source reads. */
  assertCurrent(): void
  signal?: AbortSignal
  intervalMs?: number
  readTimeoutMs?: number
  now?: () => number
  limits?: Readonly<{
    frames?: number
    declarations?: number
    imageBytes?: number
    totalMediaBytes?: number
    indexBytes?: number
  }>
}>

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
const limit = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('Invalid project recording limit.')
  return value
}
async function inspectImage(bytes: Buffer): Promise<{
  width: number
  height: number
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  extension: string
}> {
  const detected = (['image/png', 'image/jpeg', 'image/webp'] as const)
    .map((mimeType) => ({ mimeType, dimensions: readRasterImageDimensions(bytes, mimeType) }))
    .find((entry) => !!entry.dimensions)
  if (!detected?.dimensions || exceedsDecodedImagePixelLimit(detected.dimensions))
    throw new Error('Invalid project image.')
  const decoder = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning', animated: false })
  const metadata = await decoder.metadata()
  const transposed = (metadata.orientation ?? 1) >= 5
  if (
    (metadata.pages ?? 1) !== 1 ||
    `image/${metadata.format}` !== detected.mimeType ||
    (transposed ? metadata.height : metadata.width) !== detected.dimensions.width ||
    (transposed ? metadata.width : metadata.height) !== detected.dimensions.height
  )
    throw new Error('Invalid project image.')
  await decoder.stats()
  return {
    ...detected.dimensions,
    mimeType: detected.mimeType,
    extension: detected.mimeType === 'image/jpeg' ? 'jpg' : detected.mimeType.slice(6)
  }
}

/** Execution-time evidence sink. It knows no Notebook, environment manager, process launcher,
 * page navigator or Replay viewer. A recording error cannot restart or change the experiment. */
export function startProjectRecording(options: ProjectRecordingOptions): ProjectRecordingHandle {
  id.parse(options.recordingId)
  if (options.title !== undefined) z.string().min(1).max(512).parse(options.title)
  const source = options.source && projectRecordingSourceSchema.parse(options.source)
  if (
    options.sources.length > 16 ||
    new Set(options.sources.map((entry) => entry.key)).size !== options.sources.length ||
    options.sources.some(
      (entry) =>
        !id.safeParse(entry.key).success ||
        !['project-export', 'host-view'].includes(entry.kind) ||
        typeof entry.read !== 'function'
    )
  )
    throw new Error('Invalid project recording sources.')
  const sources = options.sources.map((entry) => ({ ...entry }))
  const declarations = (options.declarations ?? []).map((entry) => ({
    ...entry,
    intake: new ProjectRecordingDeclarations()
  }))
  if (
    declarations.length > 1 ||
    declarations.some(
      (entry) => entry.key !== PROJECT_RECORDING_DATA_FILENAME || typeof entry.read !== 'function'
    )
  )
    throw new Error('Invalid project declaration source.')
  const intervalMs = limit(options.intervalMs, 2000, 500, 60_000)
  const readTimeoutMs = limit(options.readTimeoutMs, 5000, 10, 30_000)
  const limits = {
    frames: limit(options.limits?.frames, 300, 1, MAX_PROJECT_RECORDING_ITEMS),
    declarations: limit(options.limits?.declarations, 500, 1, MAX_PROJECT_RECORDING_ITEMS),
    imageBytes: limit(
      options.limits?.imageBytes,
      4 * 1024 * 1024,
      1,
      MAX_PROJECT_RECORDING_MEDIA_BYTES
    ),
    totalMediaBytes: limit(options.limits?.totalMediaBytes, 64 * 1024 * 1024, 1, 256 * 1024 * 1024),
    indexBytes: limit(
      options.limits?.indexBytes,
      MAX_PROJECT_RECORDING_BYTES,
      1024,
      MAX_PROJECT_RECORDING_BYTES
    )
  }
  const now = options.now ?? Date.now
  const timestamp = (): number => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid recording clock.')
    return value
  }
  const startedAt = timestamp()
  let lastTime = startedAt
  const clock = (): number => (lastTime = Math.max(lastTime, timestamp()))
  const recording: ProjectRecording = {
    format: 'open-science-project-recording',
    version: 1,
    recordingId: options.recordingId,
    ...(options.title === undefined ? {} : { title: options.title }),
    startedAt,
    endedAt: startedAt,
    ...(source ? { source } : {}),
    media: [],
    frames: [],
    states: [],
    events: [],
    coverage: {
      kind: 'sampled-project-recording',
      stopReason: 'finished',
      failures: 0,
      unchangedSamples: 0,
      droppedSamples: 0,
      missingMediaKeys: []
    }
  }
  const warnings = new Set<ProjectRecordingWarning>()
  const controller = new AbortController()
  const fingerprints = new Map<string, string>()
  const writes = new Set<string>()
  let mediaBytes = 0
  let stopped = false
  let closing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  let tail = Promise.resolve()
  let finished: Promise<ProjectRecordingResult> | undefined
  let capacity = false
  const warn = (warning: ProjectRecordingWarning): void => {
    warnings.add(warning)
  }
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const stop = (reason: ProjectRecording['coverage']['stopReason']): void => {
    stopped = true
    clear()
    options.signal?.removeEventListener('abort', onAbort)
    if (recording.coverage.stopReason === 'finished') recording.coverage.stopReason = reason
  }
  const onAbort = (): void => {
    warn('interrupted')
    stop('interrupted')
    controller.abort()
  }
  const admit = (): void => {
    controller.signal.throwIfAborted()
    options.signal?.throwIfAborted()
    options.assertCurrent()
  }
  const serial = (operation: () => Promise<void>): Promise<void> => {
    const result = tail.then(operation).catch(() => {
      recording.coverage.failures++
      warn('capture-failed')
    })
    tail = result
    return result
  }
  const atCapacity = (): void => {
    capacity = true
    recording.coverage.droppedSamples++
    warn('capacity')
    stop('capacity')
  }
  // Reserve room for coverage changes and closing timestamps, not just current payload bytes.
  const fitsIndex = (): boolean =>
    Buffer.byteLength(JSON.stringify(recording)) + 1024 <= limits.indexBytes
  const checkSaved = (
    result: AuxiliaryOutputResult,
    filename: string,
    checksum: string,
    size: number
  ): ArtifactVersionFile => {
    if (result.status !== 'saved') throw new Error('Project recording publication failed.')
    const artifact = result.artifact
    if (
      !id.safeParse(artifact.artifactId).success ||
      !id.safeParse(artifact.versionId).success ||
      artifact.name !== filename ||
      artifact.checksum !== checksum ||
      artifact.size !== size ||
      (source?.projectId && artifact.projectId !== source.projectId) ||
      (source?.sessionId && artifact.sessionId !== source.sessionId)
    )
      throw new Error('Project recording publication identity changed.')
    return artifact
  }
  const read = async <T>(reader: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const readController = new AbortController()
    const signal = AbortSignal.any([controller.signal, readController.signal])
    let timeout: ReturnType<typeof setTimeout> | undefined
    let removeAbort: (() => void) | undefined
    try {
      const interrupted = new Promise<never>((_, reject) => {
        const abort = (): void => reject(new Error('Project capture was interrupted.'))
        signal.addEventListener('abort', abort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', abort)
        timeout = setTimeout(() => readController.abort(), readTimeoutMs)
        if (signal.aborted) abort()
      })
      // Late uncooperative readers never publish: only the winner proceeds to the writer.
      return await Promise.race([Promise.resolve().then(() => reader(signal)), interrupted])
    } finally {
      if (timeout) clearTimeout(timeout)
      removeAbort?.()
      readController.abort()
    }
  }
  const capture = async (entry: ProjectRecordingCaptureSource): Promise<void> => {
    if (stopped) return
    admit()
    const began = clock()
    const value = await read(entry.read)
    const ended = clock()
    admit()
    if (
      !(value.bytes instanceof Uint8Array) ||
      !value.bytes.byteLength ||
      value.bytes.byteLength > limits.imageBytes
    )
      throw new Error('Invalid project image size.')
    const bytes = Buffer.from(value.bytes)
    const checksum = hash(bytes)
    if (fingerprints.get(entry.key) === checksum) {
      recording.coverage.unchangedSamples++
      return
    }
    const image = await inspectImage(bytes)
    admit()
    if (
      recording.frames.length >= limits.frames ||
      mediaBytes + bytes.length > limits.totalMediaBytes
    ) {
      atCapacity()
      return
    }
    const sequence = recording.frames.length
    const frameId = `frame-${sequence}`
    const mediaKey = `image-${hash(`${options.recordingId}:${entry.key}:${sequence}:${checksum}`).slice(0, 48)}`
    const filename = `project-frame-${options.recordingId}-${sequence}.${image.extension}`
    // Write once per generation; an uncertain writer result never causes automatic replay.
    if (writes.has(mediaKey)) throw new Error('Project image publication is uncertain.')
    const frame: ProjectRecording['frames'][number] = projectRecordingFrameSchema.parse({
      frameId,
      sequence,
      recordedAt: ended,
      mediaKey,
      provenance: {
        kind: 'capture',
        source: entry.kind,
        sourceKey: entry.key,
        startedAt: began,
        finishedAt: ended,
        width: image.width,
        height: image.height,
        ...(entry.kind === 'project-export' && value.reportedCapturedAt !== undefined
          ? { reportedCapturedAt: value.reportedCapturedAt }
          : {})
      }
    })
    const media = {
      mediaKey,
      name: filename,
      mimeType: image.mimeType,
      checksum,
      sizeBytes: bytes.length,
      sourceVersionId: 'pending-version'
    }
    recording.frames.push(frame)
    recording.media.push(media)
    const fits = fitsIndex()
    recording.frames.pop()
    recording.media.pop()
    if (!fits) {
      atCapacity()
      return
    }
    writes.add(mediaKey)
    const artifact = checkSaved(
      await options.save({
        filename,
        contentType: image.mimeType,
        source: { kind: 'inline', content: bytes.toString('base64'), encoding: 'base64' }
      }),
      filename,
      checksum,
      bytes.length
    )
    // An already-authorized write is drained even when the execution ends during publication.
    // Its immutable content is still retained; cancellation must not erase an admitted frame.
    recording.media.push({ ...media, sourceVersionId: artifact.versionId })
    recording.frames.push(frame)
    mediaBytes += bytes.length
    fingerprints.set(entry.key, checksum)
  }
  const sample = (): Promise<void> => {
    if (pending) return pending
    if (stopped || closing) return Promise.resolve()
    pending = serial(async () => {
      for (const entry of sources) {
        if (stopped) break
        try {
          await capture(entry)
        } catch {
          recording.coverage.failures++
          warn('capture-failed')
        }
      }
      for (const entry of declarations) {
        if (stopped) break
        try {
          admit()
          const bytes = await read(entry.read)
          admit()
          const delta = entry.intake.read(bytes)
          recording.coverage.droppedSamples += delta.missingSequences
          if (!delta.states.length && !delta.events.length) recording.coverage.unchangedSamples++
          for (const state of delta.states) {
            await appendEvidence('state', {
              sourceId: state.id,
              reportedAt: state.reportedAt,
              label: state.label,
              value: state.value
            })
          }
          for (const event of delta.events) {
            await appendEvidence('event', {
              sourceId: event.id,
              reportedAt: event.reportedAt,
              name: event.name,
              data: event.data
            })
          }
        } catch {
          recording.coverage.failures++
          warn('invalid-declaration')
        }
      }
    }).finally(() => {
      pending = undefined
    })
    return pending
  }
  const schedule = (delay = intervalMs): void => {
    if (stopped || closing || (!sources.length && !declarations.length)) return
    timer = setTimeout(() => {
      timer = undefined
      void sample().finally(() => schedule())
    }, delay)
    timer.unref()
  }
  const appendEvidence = async (kind: 'state' | 'event', input: unknown): Promise<void> => {
    if (stopped) return
    admit()
    const entries = kind === 'state' ? recording.states : recording.events
    if (entries.length >= limits.declarations) {
      atCapacity()
      return
    }
    const common = {
      sequence: entries.length,
      recordedAt: clock(),
      source: 'author-declared' as const
    }
    const parsed =
      kind === 'state'
        ? projectRecordingStateSchema.safeParse({
            ...(input as object),
            ...common,
            stateId: `state-${entries.length}`
          })
        : projectRecordingEventSchema.safeParse({
            ...(input as object),
            ...common,
            eventId: `event-${entries.length}`
          })
    if (!parsed.success) {
      recording.coverage.failures++
      warn('invalid-declaration')
      return
    }
    if ('stateId' in parsed.data) recording.states.push(parsed.data)
    else recording.events.push(parsed.data)
    if (!fitsIndex()) {
      entries.pop()
      atCapacity()
    }
  }
  const append = (kind: 'state' | 'event', input: unknown): Promise<void> => {
    if (stopped || closing) return Promise.resolve()
    // Freeze at admission so callers cannot change evidence while another sample is queued.
    let frozen: unknown
    try {
      frozen = structuredClone(input)
    } catch {
      warn('invalid-declaration')
      recording.coverage.failures++
      return Promise.resolve()
    }
    return serial(() => appendEvidence(kind, frozen))
  }
  const finish = (
    reason: ProjectRecording['coverage']['stopReason'] = 'finished'
  ): Promise<ProjectRecordingResult> => {
    if (finished) return finished
    // Clear the schedule now; previously admitted source reads/writes are drained before sealing.
    clear()
    closing = true
    options.signal?.removeEventListener('abort', onAbort)
    finished = (async (): Promise<ProjectRecordingResult> => {
      await pending
      await tail
      stopped = true
      if (recording.coverage.stopReason === 'finished') recording.coverage.stopReason = reason
      if (capacity) recording.coverage.stopReason = 'capacity'
      recording.endedAt = clock()
      try {
        const value = validateProjectRecording(recording)
        const content = JSON.stringify(value)
        if (Buffer.byteLength(content) > limits.indexBytes)
          throw new Error('Project index is too large.')
        const filename = `project-recording-${options.recordingId}.json`
        const artifact = checkSaved(
          await options.save({
            filename,
            contentType: 'application/json',
            source: { kind: 'inline', content }
          }),
          filename,
          hash(content),
          Buffer.byteLength(content)
        )
        return { status: 'saved', recording: value, artifact, warnings: [...warnings] }
      } catch {
        warn('publication-failed')
        return { status: 'unavailable', warnings: [...warnings] }
      } finally {
        controller.abort()
      }
    })()
    return finished
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  else schedule(0)
  return {
    recordingId: options.recordingId,
    sample,
    recordState: (input) => append('state', input),
    recordEvent: (input) => append('event', input),
    finish,
    abort: async () => {
      onAbort()
      await pending
      await tail
    }
  }
}
