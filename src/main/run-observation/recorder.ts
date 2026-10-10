import { createHash } from 'node:crypto'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  runObservationSnapshotSchema,
  runObservationTargetSchema,
  type RunObservationHistory,
  type RunObservationSnapshot,
  type RunObservationTarget
} from '../../shared/run-observation'
import {
  MAX_RUN_OBSERVATION_ARCHIVE_BYTES,
  MAX_RUN_OBSERVATION_ARCHIVE_RECORDS,
  runObservationArchiveMediaSchema,
  type RunObservationArchive,
  type RunObservationArchiveMedia
} from '../../shared/run-observation-archive'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile,
  type DurableJsonFileDependencies
} from '../storage/durable-json-file'
import { buildRunObservationArchive } from './archive'
import {
  RECORDING_SEGMENT_SAMPLES,
  archiveRecordsBytes,
  prepareRecordingSegment,
  readRecordingSegment,
  recordingSegmentReferenceSchema,
  segmentFilename,
  writeRecordingSegment,
  type RecordingSegmentWrite
} from './recorder-segments'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const targetSchema = runObservationTargetSchema.refine((target) => !!target.executionInvocationId)
const referenceSchema = z
  .object({
    artifactId: id.optional(),
    versionId: id,
    checksum: digest,
    sizeBytes: count
  })
  .strict()
const publicationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unpublished') }).strict(),
  referenceSchema.extend({ state: z.literal('saved'), recordedAt: count }).strict(),
  referenceSchema
    .extend({ state: z.literal('published'), recordedAt: count, publishedAt: count })
    .strict()
])
const stopReasonSchema = z.enum([
  'run-ended',
  'viewer-closed',
  'app-exit',
  'capture-failed',
  'manual',
  'capacity'
])
const legacyRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingId: digest,
    target: targetSchema,
    status: z.enum(['recording', 'finished', 'interrupted']),
    createdAt: count,
    updatedAt: count,
    stoppedAt: count.optional(),
    stopReason: stopReasonSchema.optional(),
    capacityLimit: z.enum(['snapshots', 'record-bytes', 'global-bytes']).optional(),
    history: z
      .object({
        coverage: z.literal('process-local'),
        truncated: z.boolean(),
        snapshots: z.array(runObservationSnapshotSchema).max(128)
      })
      .strict(),
    media: z.array(runObservationArchiveMediaSchema).max(2000),
    missingMediaKeys: z.array(id).max(2000),
    samplingFailures: count,
    unavailableSamples: count,
    publication: publicationSchema
  })
  .strict()
const recordSchema = legacyRecordSchema
  .extend({
    schemaVersion: z.literal(2),
    segments: z.array(recordingSegmentReferenceSchema).max(32)
  })
  .strict()
const storedRecordSchema = z.union([
  recordSchema,
  legacyRecordSchema.transform((record) => ({
    ...record,
    schemaVersion: 2 as const,
    segments: []
  }))
])
type RecordState = z.infer<typeof recordSchema>
export type RunObservationPublication = z.infer<typeof publicationSchema>
export type RunObservationPublicationReference = Readonly<{
  artifactId?: string
  versionId: string
  checksum?: string
  sizeBytes?: number
}>
export type RunObservationRecording = Readonly<{
  recordingId: string
  target: RunObservationTarget
  status: RecordState['status']
  recovered: boolean
  history: RunObservationHistory
  archive?: RunObservationArchive
  publication: RunObservationPublication
  /** Available even when the capacity was reached before the first valid sample. */
  capacityLimit?: RecordState['capacityLimit']
}>
export type RunObservationRecordingHandle = Readonly<{
  recordingId: string
  target: RunObservationTarget
  sample(): Promise<void>
  appendMedia(media: RunObservationArchiveMedia): Promise<void>
  finish(): Promise<RunObservationArchive | undefined>
  /** Stops observation only. It never cancels the observed execution. */
  abort(): Promise<void>
}>
export type RunObservationRecorderDependencies = Readonly<{
  dataRoot: string
  /** An independent Main observer, with current scope authorization before AND after source reads.
   * Return only the owner's sanitized DTO. Never read by latest Run or use a browser grant here. */
  read(
    target: RunObservationTarget,
    signal: AbortSignal
  ): Promise<RunObservationSnapshot | undefined>
  /** Optional additional scope-lifetime gate, also applied to recovered records and publication. */
  authorize?(target: RunObservationTarget): Promise<void>
  /** Proves this exact saved Version is finalized and published in this exact Project/Session. */
  isPublished?(
    target: RunObservationTarget,
    reference: Required<Omit<RunObservationPublicationReference, 'artifactId'>> & {
      artifactId?: string
    }
  ): Promise<boolean>
  onSampleError?(
    target: RunObservationTarget,
    code: 'read-failed' | 'write-failed' | 'source-changed'
  ): void
  intervalMs?: number
  readTimeoutMs?: number
  now?: () => number
  limits?: Readonly<{
    active?: number
    records?: number
    snapshots?: number
    recordBytes?: number
    totalBytes?: number
  }>
  durableFileDependencies?: Partial<DurableJsonFileDependencies>
}>
type Entry = {
  record: RecordState
  generation: number
  writeFailures: number
  stopped: boolean
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
  sample?: Promise<void>
  finish?: Promise<RunObservationArchive | undefined>
  handle: RunObservationRecordingHandle
}
class SourceChangedError extends Error {}
class CapacityError extends Error {
  constructor(readonly limit: NonNullable<RecordState['capacityLimit']>) {
    super(`Observation recorder: ${limit} capacity reached.`)
  }
}
const clone = <T>(value: T): T => structuredClone(value)
const terminal = (snapshot: RunObservationSnapshot | undefined): boolean =>
  !!snapshot?.run &&
  ['completed', 'failed', 'timeout', 'interrupted', 'cancelled'].includes(snapshot.run.status)
const sameTarget = (a: RunObservationTarget, b: RunObservationTarget): boolean =>
  (['projectId', 'sessionId', 'operationId', 'executionInvocationId', 'runId'] as const).every(
    (key) => a[key] === b[key]
  )
const recordingIdFor = (target: RunObservationTarget): string =>
  createHash('sha256')
    .update(JSON.stringify([target.projectId, target.sessionId, target.executionInvocationId]))
    .digest('hex')
const error = (message: string): Error => new Error(`Observation recorder: ${message}`)
const limit = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw error('invalid capacity limit.')
  return value
}

/** Durable sampled evidence, independent of viewer lifetime. One instance owns an app data root.
 * No sidecar can launch an execution, carry a credential or acquire Notebook producer authority. */
export class RunObservationRecorder {
  private readonly directory: string
  private readonly active = new Map<string, Entry>()
  private readonly capacity: {
    active: number
    records: number
    snapshots: number
    recordBytes: number
    totalBytes: number
  }
  private readonly interval: number
  private readonly readTimeout: number
  private readonly now: () => number
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly dependencies: RunObservationRecorderDependencies) {
    this.directory = join(dependencies.dataRoot, 'managed-run-observations')
    this.now = dependencies.now ?? Date.now
    this.interval = limit(dependencies.intervalMs, 1000, 10, 60_000)
    this.readTimeout = limit(dependencies.readTimeoutMs, 10_000, 10, 60_000)
    this.capacity = {
      active: limit(dependencies.limits?.active, 16, 1, 64),
      records: limit(dependencies.limits?.records, 256, 1, 4096),
      snapshots: limit(
        dependencies.limits?.snapshots,
        MAX_RUN_OBSERVATION_ARCHIVE_RECORDS,
        1,
        MAX_RUN_OBSERVATION_ARCHIVE_RECORDS
      ),
      recordBytes: limit(dependencies.limits?.recordBytes, 8 * 1024 * 1024, 2048, 12 * 1024 * 1024),
      totalBytes: limit(dependencies.limits?.totalBytes, 128 * 1024 * 1024, 2048, 512 * 1024 * 1024)
    }
  }

  async start(input: RunObservationTarget): Promise<RunObservationRecordingHandle> {
    const target = targetSchema.parse(input)
    await this.authorize(target)
    return this.exclusive(async () => {
      this.assertOpen()
      const recordingId = recordingIdFor(target)
      const existing = this.active.get(recordingId)
      if (existing) {
        this.assertTarget(existing.record, target)
        return existing.handle
      }
      const saved = await this.readRecord(target)
      this.assertOpen()
      await this.authorize(target)
      this.assertOpen()
      if (saved) {
        // A process restart cannot prove continuity with the old observer epoch. Keep the actual
        // partial capture, never silently resume it or run the original experiment again.
        const recovered =
          saved.status === 'recording' ? this.stoppedRecord(saved, 'app-exit') : saved
        if (recovered !== saved) await this.writeRecord(recovered)
        return this.entry(recovered, true).handle
      }
      if (this.active.size >= this.capacity.active) throw error('active recording limit reached.')
      const now = this.now()
      const record: RecordState = {
        schemaVersion: 2,
        segments: [],
        recordingId,
        target,
        status: 'recording',
        createdAt: now,
        updatedAt: now,
        history: { coverage: 'process-local', truncated: false, snapshots: [] },
        media: [],
        missingMediaKeys: [],
        samplingFailures: 0,
        unavailableSamples: 0,
        publication: { state: 'unpublished' }
      }
      await this.writeRecord(record)
      // close() can arrive while fsync is pending: persist a stopped record, without arming a timer.
      if (this.closed) {
        await this.writeRecord(this.stoppedRecord(record, 'app-exit'))
        throw error('closed.')
      }
      const entry = this.entry(record, false)
      this.active.set(recordingId, entry)
      this.schedule(entry)
      return entry.handle
    })
  }

  async load(input: RunObservationTarget): Promise<RunObservationRecording | undefined> {
    const target = targetSchema.parse(input)
    await this.authorize(target)
    return this.exclusive(async () => {
      this.assertOpen()
      const record = await this.readRecord(target)
      await this.authorize(target)
      this.assertOpen()
      if (!record) return undefined
      const recovered = record.status === 'recording' && !this.active.has(record.recordingId)
      const projected = recovered ? this.stoppedRecord(record, 'app-exit') : record
      const history = await this.history(record)
      const archive = await this.archive(projected, history)
      await this.authorize(target)
      this.assertOpen()
      return clone({
        recordingId: record.recordingId,
        target: record.target,
        status: projected.status,
        recovered,
        history,
        archive,
        capacityLimit: record.capacityLimit,
        publication: record.publication
      })
    })
  }

  /** A save receipt is not publication proof. Failed publication remains recoverable and must not
   * cause another Artifact save; retry verifying this exact saved Version instead. */
  async markPublished(
    input: RunObservationTarget,
    inputReference: RunObservationPublicationReference
  ): Promise<RunObservationPublication> {
    const target = targetSchema.parse(input)
    const requested = referenceSchema
      .partial({ checksum: true, sizeBytes: true })
      .parse(inputReference)
    await this.authorize(target)
    return this.exclusive(async () => {
      this.assertOpen()
      const record = await this.readRecord(target)
      if (!record || record.status === 'recording')
        throw error('recording is not ready for publication.')
      const archive = await this.archive(record)
      if (!archive) throw error('no sampled evidence is available.')
      const text = JSON.stringify(archive)
      const checksum = createHash('sha256').update(text).digest('hex')
      const sizeBytes = Buffer.byteLength(text)
      if (
        (requested.checksum !== undefined && requested.checksum !== checksum) ||
        (requested.sizeBytes !== undefined && requested.sizeBytes !== sizeBytes)
      )
        throw error('publication content does not match the recording.')
      const reference = { ...requested, checksum, sizeBytes }
      if (
        record.publication.state !== 'unpublished' &&
        (record.publication.versionId !== reference.versionId ||
          record.publication.artifactId !== reference.artifactId ||
          record.publication.checksum !== checksum ||
          record.publication.sizeBytes !== sizeBytes)
      )
        throw error('recording already has a different save receipt.')
      await this.authorize(target)
      this.assertOpen()
      const alreadyPublished = record.publication.state === 'published'
      // Save receipt first. A failing verifier must not lose the Version identity and cause a second save.
      const saved: RecordState = {
        ...record,
        publication: alreadyPublished
          ? record.publication
          : {
              ...reference,
              state: 'saved',
              recordedAt:
                record.publication.state === 'unpublished'
                  ? this.now()
                  : record.publication.recordedAt
            }
      }
      await this.writeRecord(saved)
      if (alreadyPublished) return clone(saved.publication)
      const published = (await this.dependencies.isPublished?.(target, reference)) ?? false
      await this.authorize(target)
      this.assertOpen()
      if (!published) return clone(saved.publication)
      const finalized: RecordState = {
        ...saved,
        publication: {
          ...reference,
          state: 'published',
          recordedAt:
            saved.publication.state === 'unpublished' ? this.now() : saved.publication.recordedAt,
          publishedAt: this.now()
        }
      }
      await this.writeRecord(finalized)
      return clone(finalized.publication)
    })
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const entries = [...this.active.values()]
    for (const entry of entries) this.stop(entry)
    this.closing = (async () => {
      await Promise.allSettled(entries.map((entry) => entry.sample))
      await this.exclusive(async () => {
        const failures: unknown[] = []
        for (const entry of entries) {
          try {
            if (entry.record.status === 'recording') await this.persistStopped(entry, 'app-exit')
          } catch (failure) {
            failures.push(failure)
          }
        }
        this.active.clear()
        if (failures.length)
          throw error(
            'some interrupted recordings could not be flushed; existing sidecars remain recoverable.'
          )
      })
    })()
    return this.closing
  }

  private entry(record: RecordState, stopped: boolean): Entry {
    const entry: Entry = { record, stopped, generation: 0, writeFailures: 0, handle: undefined! }
    entry.handle = Object.freeze({
      recordingId: record.recordingId,
      target: Object.freeze(clone(record.target)),
      sample: () => this.sample(entry),
      appendMedia: (media: RunObservationArchiveMedia) => this.appendMedia(entry, media),
      finish: () => this.finish(entry),
      abort: async () => {
        this.stop(entry)
        await entry.sample?.catch(() => undefined)
        await this.exclusive(async () => {
          if (entry.record.status === 'recording') await this.persistStopped(entry, 'manual')
          this.active.delete(entry.record.recordingId)
        })
      }
    })
    return entry
  }

  private schedule(entry: Entry): void {
    if (this.closed || entry.stopped) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.sample(entry)
        .catch(() => undefined)
        .finally(() => this.schedule(entry))
    }, this.interval)
    entry.timer.unref()
  }

  private sample(entry: Entry): Promise<void> {
    if (entry.sample) return entry.sample
    if (entry.stopped || this.closed) return Promise.resolve()
    const generation = entry.generation
    const controller = new AbortController()
    entry.controller = controller
    entry.sample = (async () => {
      let snapshot: RunObservationSnapshot | undefined
      let failed: 'read-failed' | 'source-changed' | undefined
      let stopCapture = false
      try {
        await this.authorize(entry.record.target)
        snapshot = await this.readWithTimeout(entry.record.target, controller)
        await this.authorize(entry.record.target)
        if (snapshot) {
          snapshot = runObservationSnapshotSchema.parse(snapshot)
          this.checkSnapshot(entry.record, snapshot)
        }
      } catch (failure) {
        snapshot = undefined
        failed = failure instanceof SourceChangedError ? 'source-changed' : 'read-failed'
        // A read that ignores abort must not accumulate a new unresolved promise each interval.
        stopCapture = failure instanceof SourceChangedError || controller.signal.aborted
      }
      if (entry.stopped || this.closed || entry.generation !== generation) return
      try {
        await this.exclusive(async () => {
          if (entry.stopped || this.closed || entry.generation !== generation) return
          await this.authorize(entry.record.target)
          if (entry.stopped || this.closed || entry.generation !== generation) return
          const next = clone(entry.record)
          next.samplingFailures += entry.writeFailures
          next.updatedAt = Math.max(this.now(), next.updatedAt, snapshot?.observedAt ?? 0)
          if (failed) next.samplingFailures++
          else if (!snapshot) next.unavailableSamples++
          else {
            const last = next.history.snapshots.at(-1)
            if (last?.cursor.sequence === snapshot.cursor.sequence) {
              if (!entry.writeFailures) return
            } else
              next.history.snapshots.push(snapshot as z.infer<typeof runObservationSnapshotSchema>)
            if (!next.segments.length && next.history.snapshots[0].cursor.sequence > 0)
              next.history.truncated = true
          }
          if (stopCapture) {
            this.stop(entry)
            await this.persist(entry, this.stoppedRecord(next, 'capture-failed'))
            this.active.delete(entry.record.recordingId)
          } else {
            try {
              await this.persistSample(entry, next)
            } catch (failure) {
              if (!(failure instanceof CapacityError)) throw failure
              this.stop(entry)
              await this.persist(
                entry,
                this.stoppedRecord(
                  {
                    ...entry.record,
                    updatedAt: next.updatedAt,
                    samplingFailures: next.samplingFailures,
                    unavailableSamples: next.unavailableSamples,
                    capacityLimit: failure.limit
                  },
                  'capacity'
                )
              )
              this.active.delete(entry.record.recordingId)
            }
          }
          entry.writeFailures = 0
        })
      } catch {
        entry.writeFailures++
        this.notify(entry, 'write-failed')
        throw error('sample could not be persisted.')
      }
      if (failed) this.notify(entry, failed)
    })().finally(() => {
      entry.sample = undefined
      entry.controller = undefined
    })
    return entry.sample
  }

  private async finish(entry: Entry): Promise<RunObservationArchive | undefined> {
    if (entry.finish) return entry.finish
    entry.finish = (async () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = undefined
      await entry.sample?.catch(() => undefined)
      // A final successful read does not promise that every intermediate source revision was seen.
      if (!entry.stopped && !this.closed) await this.sample(entry).catch(() => undefined)
      this.stop(entry)
      return this.exclusive(async () => {
        if (entry.record.status === 'recording') {
          const reason = this.closed
            ? 'app-exit'
            : terminal(entry.record.history.snapshots.at(-1))
              ? 'run-ended'
              : 'capture-failed'
          await this.persistStopped(entry, reason)
        }
        this.active.delete(entry.record.recordingId)
        return this.archive(entry.record)
      })
    })()
    try {
      return await entry.finish
    } catch (failure) {
      entry.finish = undefined
      throw failure
    }
  }

  private async appendMedia(entry: Entry, input: RunObservationArchiveMedia): Promise<void> {
    const media = runObservationArchiveMediaSchema.parse(input)
    await this.authorize(entry.record.target)
    await this.exclusive(async () => {
      this.assertOpen()
      if (entry.stopped || entry.record.status !== 'recording')
        throw error('recording has stopped.')
      await this.authorize(entry.record.target)
      this.assertOpen()
      if (entry.stopped) throw error('recording has stopped.')
      const steps = new Set(
        (await this.history(entry.record)).snapshots.map(
          (snapshot) => `observation-${snapshot.cursor.sequence}`
        )
      )
      if (media.stepKeys.some((step) => !steps.has(step)))
        throw error('media does not reference retained observations.')
      const previous = entry.record.media.find((item) => item.mediaKey === media.mediaKey)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(media))
          throw error('media key already has different content.')
        return
      }
      if (entry.record.media.length >= 2000) throw error('media descriptor limit reached.')
      const next = clone(entry.record)
      next.media.push(media)
      next.updatedAt = Math.max(this.now(), next.updatedAt)
      await this.persistSample(entry, next)
    })
  }

  private async readWithTimeout(
    target: RunObservationTarget,
    controller: AbortController
  ): Promise<RunObservationSnapshot | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: () => void = () => undefined
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(error('read interrupted.'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => controller.abort(), this.readTimeout)
      timer.unref()
    })
    try {
      if (controller.signal.aborted) throw error('read interrupted.')
      return await Promise.race([
        this.dependencies.read(clone(target), controller.signal),
        interrupted
      ])
    } finally {
      if (timer) clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private checkSnapshot(
    record: Pick<RecordState, 'target'> & { history: RunObservationHistory },
    snapshot: RunObservationSnapshot
  ): void {
    const target = record.target
    for (const key of [
      'projectId',
      'sessionId',
      'operationId',
      'executionInvocationId',
      'runId'
    ] as const) {
      if (target[key] && target[key] !== snapshot.identity[key]) throw new SourceChangedError()
    }
    const previous = record.history.snapshots.at(-1)
    if (!previous) return
    if (
      previous.cursor.epoch !== snapshot.cursor.epoch ||
      snapshot.cursor.sequence < previous.cursor.sequence ||
      snapshot.observedAt < previous.observedAt ||
      (
        [
          'projectId',
          'sessionId',
          'operationId',
          'executionInvocationId',
          'environmentId',
          'runId'
        ] as const
      ).some(
        (key) => previous.identity[key] && previous.identity[key] !== snapshot.identity[key]
      ) ||
      (previous.cursor.sequence === snapshot.cursor.sequence &&
        JSON.stringify(previous) !== JSON.stringify(snapshot))
    )
      throw new SourceChangedError()
  }

  /** The active chunk alone is mutable. Sealed samples remain on disk and are never ring-dropped. */
  private async persistSample(entry: Entry, next: RecordState): Promise<void> {
    const count =
      next.segments.reduce((sum, ref) => sum + ref.snapshotCount, 0) + next.history.snapshots.length
    if (count > this.capacity.snapshots) throw new CapacityError('snapshots')
    let segment: RecordingSegmentWrite | undefined
    if (next.history.snapshots.length > RECORDING_SEGMENT_SAMPLES) {
      segment = prepareRecordingSegment(
        next.recordingId,
        next.target,
        next.segments.length,
        next.history.snapshots.slice(0, RECORDING_SEGMENT_SAMPLES)
      )
      next.segments.push(segment.reference)
      next.history.snapshots = next.history.snapshots.slice(RECORDING_SEGMENT_SAMPLES)
    }
    const rawBytes =
      Buffer.byteLength(JSON.stringify(next)) +
      next.segments.reduce((sum, ref) => sum + ref.sizeBytes, 0)
    // Exact portable record bytes plus a conservative allowance for coverage/identity metadata.
    // Media is included separately; this guarantees aggregation remains within the public 16 MiB limit.
    const archiveBytes =
      next.segments.reduce((sum, ref) => sum + ref.archiveRecordBytes, 0) +
      archiveRecordsBytes(next.history.snapshots) +
      Buffer.byteLength(JSON.stringify(next.media)) +
      Buffer.byteLength(JSON.stringify(next.missingMediaKeys)) +
      16 * 1024
    if (
      rawBytes > this.capacity.recordBytes - 1024 ||
      archiveBytes > MAX_RUN_OBSERVATION_ARCHIVE_BYTES
    )
      throw new CapacityError('record-bytes')
    await this.checkDiskCapacity(next, segment, 1024)
    if (segment) {
      await writeRecordingSegment({
        directory: this.directory,
        recordingId: next.recordingId,
        target: next.target,
        segment,
        dependencies: this.dependencies.durableFileDependencies
      })
      await this.authorize(next.target)
    }
    await this.persist(entry, next)
  }

  private async history(record: RecordState): Promise<RunObservationHistory> {
    const snapshots: RunObservationSnapshot[] = []
    for (const reference of record.segments) {
      snapshots.push(
        ...(await readRecordingSegment({
          directory: this.directory,
          recordingId: record.recordingId,
          target: record.target,
          reference,
          dependencies: this.dependencies.durableFileDependencies
        }))
      )
    }
    snapshots.push(...record.history.snapshots)
    for (let index = 0; index < snapshots.length; index++) {
      this.checkSnapshot(
        {
          ...record,
          history: { ...record.history, snapshots: index ? [snapshots[index - 1]] : [] }
        },
        snapshots[index]
      )
    }
    return { ...record.history, snapshots }
  }

  private stoppedRecord(
    record: RecordState,
    reason: NonNullable<RecordState['stopReason']>
  ): RecordState {
    const stoppedAt = Math.max(record.updatedAt, record.history.snapshots.at(-1)?.observedAt ?? 0)
    return {
      ...record,
      status: reason === 'run-ended' ? 'finished' : 'interrupted',
      stoppedAt,
      stopReason: reason,
      updatedAt: stoppedAt
    }
  }

  private async archive(
    record: RecordState,
    history = undefined as RunObservationHistory | undefined
  ): Promise<RunObservationArchive | undefined> {
    history ??= await this.history(record)
    if (!history.snapshots.length) return undefined
    return buildRunObservationArchive({
      recordingId: record.recordingId,
      history,
      capturedAt: record.stoppedAt ?? record.updatedAt,
      stopReason: record.stopReason ?? 'manual',
      media: record.media,
      missingMediaKeys: record.missingMediaKeys,
      samplingFailures: record.samplingFailures,
      unavailableSamples: record.unavailableSamples,
      capacityLimit: record.capacityLimit
    })
  }

  private decode = (text: string): RecordState => {
    try {
      const record = storedRecordSchema.parse(JSON.parse(text))
      if (
        record.recordingId !== recordingIdFor(record.target) ||
        record.createdAt > record.updatedAt ||
        Buffer.byteLength(text) + record.segments.reduce((sum, ref) => sum + ref.sizeBytes, 0) >
          12 * 1024 * 1024 ||
        (record.stopReason === 'capacity') !== (record.capacityLimit !== undefined) ||
        record.segments.some(
          (ref, index) => ref.ordinal !== index || ref.snapshotCount !== RECORDING_SEGMENT_SAMPLES
        ) ||
        record.segments.reduce((sum, ref) => sum + ref.snapshotCount, 0) +
          record.history.snapshots.length >
          MAX_RUN_OBSERVATION_ARCHIVE_RECORDS ||
        (record.status === 'recording') !==
          (record.stoppedAt === undefined && record.stopReason === undefined) ||
        (record.status !== 'recording' &&
          (record.stoppedAt === undefined ||
            record.stopReason === undefined ||
            record.stoppedAt !== record.updatedAt)) ||
        (record.status === 'finished' && record.stopReason !== 'run-ended') ||
        (record.status === 'recording' && record.publication.state !== 'unpublished')
      )
        throw error('invalid lifecycle.')
      for (let index = 0; index < record.history.snapshots.length; index++) {
        this.checkSnapshot(
          {
            ...record,
            history: { ...record.history, snapshots: record.history.snapshots.slice(0, index) }
          },
          record.history.snapshots[index]
        )
      }
      if (
        !record.history.snapshots.length &&
        !record.segments.length &&
        (record.media.length ||
          record.missingMediaKeys.length ||
          record.publication.state !== 'unpublished')
      )
        throw error('no evidence for stored references.')
      return record
    } catch {
      throw new DurableJsonRecoveryBarrierError(
        'Observation recording is malformed or from an unsupported version; preserving it.'
      )
    }
  }

  private async readRecord(target: RunObservationTarget): Promise<RecordState | undefined> {
    const path = this.path(recordingIdFor(target))
    try {
      if (!(await lstat(path)).isFile()) throw error('recording is not a regular file.')
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
    }
    const result = await readDurableJsonFile(
      path,
      this.decode,
      this.dependencies.durableFileDependencies,
      { maxBytes: this.capacity.recordBytes }
    )
    if (result.status === 'missing') return undefined
    this.assertTarget(result.value, target)
    // Validate every referenced segment and its cross-segment continuity before using recovered data.
    const archive = await this.archive(result.value)
    if (archive && result.value.publication.state !== 'unpublished') {
      const text = JSON.stringify(archive)
      if (
        result.value.publication.checksum !== createHash('sha256').update(text).digest('hex') ||
        result.value.publication.sizeBytes !== Buffer.byteLength(text)
      )
        throw new DurableJsonRecoveryBarrierError(
          'Observation publication digest does not match; preserving the recording.'
        )
    }
    return result.value
  }

  private async persistStopped(
    entry: Entry,
    reason: NonNullable<RecordState['stopReason']>
  ): Promise<void> {
    const record = this.stoppedRecord(
      {
        ...entry.record,
        samplingFailures: entry.record.samplingFailures + entry.writeFailures
      },
      reason
    )
    await this.persist(entry, record)
    entry.writeFailures = 0
  }

  private async persist(entry: Entry, record: RecordState): Promise<void> {
    try {
      await this.writeRecord(record)
      entry.record = record
    } catch (failure) {
      // rename may have succeeded before directory fsync failed. The visible durable file wins;
      // never overwrite it later using the previous in-memory snapshot.
      const current = await this.readRecord(record.target).catch(() => undefined)
      if (current) {
        entry.record = current
        if (JSON.stringify(current) === JSON.stringify(record)) entry.writeFailures = 0
      }
      throw failure
    }
  }

  private async writeRecord(record: RecordState): Promise<void> {
    const text = JSON.stringify(record)
    if (
      Buffer.byteLength(text) + record.segments.reduce((sum, ref) => sum + ref.sizeBytes, 0) >
      this.capacity.recordBytes
    )
      throw new CapacityError('record-bytes')
    this.decode(text)
    await this.checkDiskCapacity(record, undefined, record.status === 'recording' ? 1024 : 0)
    await writeDurableJsonFile(
      this.path(record.recordingId),
      text,
      this.dependencies.durableFileDependencies
    )
  }

  private async checkDiskCapacity(
    record: RecordState,
    pending?: RecordingSegmentWrite,
    reserve = 0
  ): Promise<void> {
    let bytes = 0
    let records = 0
    let existingBytes = 0
    let pendingExists = false
    let entries = 0
    let directory: Awaited<ReturnType<typeof opendir>> | undefined
    try {
      directory = await opendir(this.directory)
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
    }
    if (directory) {
      for await (const item of directory) {
        if (++entries > this.capacity.records * 72 + 64)
          throw error('recording directory capacity reached.')
        if (!/^[a-f0-9]{64}(?:\.segment-\d{2})?\.json(?:\..+\.tmp)?$/.test(item.name)) continue
        if (!item.isFile()) throw error('recording directory contains an invalid entry.')
        const stat = await lstat(join(this.directory, item.name))
        if (!stat.isFile()) throw error('recording directory changed during inspection.')
        bytes += stat.size
        if (/^[a-f0-9]{64}\.json$/.test(item.name)) records++
        if (item.name === `${record.recordingId}.json`) existingBytes = stat.size
        if (pending && item.name === segmentFilename(record.recordingId, pending.reference.ordinal))
          pendingExists = true
      }
    }
    if (!existingBytes && records >= this.capacity.records)
      throw error(
        'durable recording capacity reached; retain or export existing evidence before recording more.'
      )
    const newSegmentBytes = pending && !pendingExists ? pending.reference.sizeBytes : 0
    // Reserve final status/publication metadata for every other recording. The selected recording
    // may consume its own reserve while stopping, even when a different recording filled its quota.
    const otherReserves = (records - (existingBytes ? 1 : 0)) * 1024
    if (pending && bytes + newSegmentBytes + otherReserves + reserve > this.capacity.totalBytes)
      throw new CapacityError('global-bytes')
    if (
      bytes -
        existingBytes +
        Buffer.byteLength(JSON.stringify(record)) +
        newSegmentBytes +
        otherReserves +
        reserve >
      this.capacity.totalBytes
    )
      throw new CapacityError('global-bytes')
  }

  private async authorize(target: RunObservationTarget): Promise<void> {
    try {
      await this.dependencies.authorize?.(clone(target))
    } catch {
      throw error('selected scope is no longer available.')
    }
  }
  private assertTarget(record: RecordState, target: RunObservationTarget): void {
    if (!sameTarget(record.target, target))
      throw error('recording target does not match its original scope.')
  }
  private stop(entry: Entry): void {
    entry.stopped = true
    entry.generation++
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.controller?.abort()
  }
  private path(recordingId: string): string {
    return join(this.directory, `${recordingId}.json`)
  }
  private assertOpen(): void {
    if (this.closed) throw error('closed.')
  }
  private notify(entry: Entry, code: 'read-failed' | 'write-failed' | 'source-changed'): void {
    try {
      this.dependencies.onSampleError?.(clone(entry.record.target), code)
    } catch {
      /* Observability cannot control a Run. */
    }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
