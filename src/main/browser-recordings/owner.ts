import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { constants } from 'node:fs'
import { mkdir, open, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MAX_BROWSER_RECORDING_ITEMS,
  MAX_BROWSER_RECORDING_SEGMENT_BYTES,
  browserRecordingEventSchema,
  browserRecordingGapSchema,
  browserRecordingSegmentSchema,
  browserRecordingControlRequestSchema,
  browserRecordingTargetSchema,
  validateBrowserRecording,
  type BrowserRecording,
  type BrowserRecordingEvent,
  type BrowserRecordingSegment,
  type BrowserRecordingTarget
} from '../../shared/browser-recording'
import type { RunObservationTarget } from '../../shared/run-observation'
import type { CallerContext } from '../caller-context'
import type { AuxiliaryOutput, AuxiliaryOutputResult } from '../notebook/managed-auxiliary-output'

export type BrowserRecordingState =
  'idle' | 'starting' | 'recording' | 'paused' | 'finalizing' | 'finalized' | 'partial' | 'failed'
export type BrowserRecordingStatus = {
  recordingId?: string
  state: BrowserRecordingState
  elapsedMs: number
  segments: number
  bytes: number
  droppedFrames: number
  target?: BrowserRecordingTarget
  error?: 'unavailable' | 'capture-failed' | 'publication-failed' | 'capacity'
}
export type BrowserRecordingHost = {
  caller: CallerContext
  viewerOrigin: string
  projectOrigin: string
}
export type BrowserRecordingSource = {
  target: RunObservationTarget
  signal: AbortSignal
  assertCurrent(): void
  save(output: AuxiliaryOutput): Promise<AuxiliaryOutputResult>
}
export type BrowserRecordingDriverInput = BrowserRecordingHost & {
  signal: AbortSignal
  onSegment(
    segment: Omit<BrowserRecordingSegment, 'segmentId' | 'mediaKey'> & { bytes: Uint8Array }
  ): Promise<void>
  onEvent(event: Omit<BrowserRecordingEvent, 'eventId'>): void
  onGap(gap: z.infer<typeof browserRecordingGapSchema>): void
  onEnded?(reason: 'source-lost' | 'capture-failed' | 'interrupted'): void
  onStarted?(startedAt: number): void
  onDroppedFrames?(count: number): void
}
export type BrowserRecordingDriver = {
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}
type Source = BrowserRecordingSource & { closing: boolean; pending: Set<RecordState> }
type RecordState = {
  id: string
  source: Source
  viewerId: string
  host: BrowserRecordingHost
  assertAuthorized(): void
  clockStart: number
  state: BrowserRecordingState
  recording: BrowserRecording
  bytes: number
  target?: BrowserRecordingTarget
  error?: BrowserRecordingStatus['error']
  controller: AbortController
  driver?: BrowserRecordingDriver
  ready?: Promise<void>
  tail: Promise<void>
  controlTail: Promise<unknown>
  actions: Map<string, { method: string; result: Promise<BrowserRecordingStatus> }>
  completion?: Promise<BrowserRecordingStatus>
  timer?: ReturnType<typeof setTimeout>
}
const scopeKey = (target: RunObservationTarget): string =>
  JSON.stringify([
    target.projectId,
    target.sessionId,
    target.operationId,
    target.executionInvocationId
  ])
const emptyStatus = (): BrowserRecordingStatus => ({
  state: 'idle',
  elapsedMs: 0,
  segments: 0,
  bytes: 0,
  droppedFrames: 0
})
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const requestSchema = browserRecordingControlRequestSchema
const finished = (state: BrowserRecordingState): boolean =>
  ['finalized', 'partial', 'failed'].includes(state)

/** Main-owned evidence only. Sources supply an existing publication capability; this owner
 * cannot open a page, create a Session, start an experiment or acquire a replacement capability. */
export class BrowserRecordingOwner {
  private readonly sources = new Map<string, Source>()
  private readonly records = new Map<string, RecordState>()
  private readonly starts = new Map<
    string,
    { viewerId: string; scope: string; result: Promise<BrowserRecordingStatus> }
  >()
  private closed = false
  constructor(
    private readonly dependencies: {
      startDriver(input: BrowserRecordingDriverInput): Promise<BrowserRecordingDriver>
      now?: () => number
      monotonicNow?: () => number
      maxBytes?: number
      maxDurationMs?: number
      dataRoot?: string
    }
  ) {}

  register(source: BrowserRecordingSource): {
    close(reason?: 'finished' | 'stopped' | 'interrupted'): Promise<void>
  } {
    const key = scopeKey(source.target)
    if (this.closed || this.sources.has(key)) throw new Error('Recording source is unavailable.')
    source.signal.throwIfAborted()
    source.assertCurrent()
    const registered: Source = {
      ...source,
      target: { ...source.target },
      closing: false,
      pending: new Set()
    }
    this.sources.set(key, registered)
    let closing: Promise<void> | undefined
    const close = (reason: 'finished' | 'stopped' | 'interrupted' = 'finished'): Promise<void> => {
      closing ??= (async () => {
        registered.closing = true
        source.signal.removeEventListener('abort', onAbort)
        await Promise.all([...registered.pending].map((record) => this.finish(record, reason)))
        if (this.sources.get(key) === registered) this.sources.delete(key)
      })()
      return closing
    }
    const onAbort = (): void => {
      void close('interrupted')
    }
    source.signal.addEventListener('abort', onAbort, { once: true })
    return { close }
  }

  inspect(target: RunObservationTarget): boolean {
    const source = this.sources.get(scopeKey(target))
    if (this.closed || !source || source.closing || source.signal.aborted) return false
    try {
      source.assertCurrent()
      return true
    } catch {
      return false
    }
  }

  status(viewerId: string, recordingId?: string): BrowserRecordingStatus {
    const record = recordingId
      ? this.records.get(recordingId)
      : [...this.records.values()].reverse().find((entry) => entry.viewerId === viewerId)
    if (!record) return emptyStatus()
    if (record.viewerId !== viewerId) throw new Error('Recording is outside this viewer.')
    return this.describe(record)
  }

  async start(input: {
    target: RunObservationTarget
    viewerId: string
    host: BrowserRecordingHost
    request: unknown
    assertAuthorized(): void
  }): Promise<BrowserRecordingStatus> {
    const request = requestSchema.parse(input.request)
    if (request.recordingId) throw new Error('A new recording cannot select an existing recording.')
    input.assertAuthorized()
    const key = scopeKey(input.target)
    const previous = this.starts.get(request.requestId)
    if (previous) {
      if (previous.viewerId !== input.viewerId || previous.scope !== key)
        throw new Error('Recording request identity was reused.')
      return previous.result
    }
    const source = this.sources.get(key)
    if (!source || !this.inspect(input.target)) throw new Error('Recording source is unavailable.')
    if (
      [...this.records.values()].some(
        (record) =>
          !finished(record.state) && record.host.projectOrigin === input.host.projectOrigin
      )
    )
      throw new Error('The project page is already being recorded.')
    if (this.records.size >= 64 || this.starts.size >= 128)
      throw new Error('Recording capacity reached.')
    const result = this.begin(source, input)
    this.starts.set(request.requestId, { viewerId: input.viewerId, scope: key, result })
    return result
  }

  private async begin(
    source: Source,
    input: {
      viewerId: string
      host: BrowserRecordingHost
      assertAuthorized(): void
    }
  ): Promise<BrowserRecordingStatus> {
    const record: RecordState = {
      id: randomUUID(),
      source,
      viewerId: input.viewerId,
      host: input.host,
      assertAuthorized: input.assertAuthorized,
      clockStart: this.monotonic(),
      state: 'starting',
      bytes: 0,
      controller: new AbortController(),
      tail: Promise.resolve(),
      controlTail: Promise.resolve(),
      actions: new Map(),
      recording: {
        format: 'open-science-web-recording',
        version: 1,
        recordingId: 'pending',
        startedAt: (this.dependencies.now ?? Date.now)(),
        durationMs: 0,
        source: { ...source.target },
        media: [],
        segments: [],
        events: [],
        coverage: { stopReason: 'interrupted', gaps: [], droppedFrames: 0 }
      }
    }
    record.recording.recordingId = record.id
    this.records.set(record.id, record)
    source.pending.add(record)
    record.ready = (async () => {
      try {
        record.driver = await this.dependencies.startDriver({
          ...input.host,
          caller: {
            ...input.host.caller,
            isAuthorizationCurrent: () => {
              try {
                record.assertAuthorized()
                return input.host.caller.isAuthorizationCurrent()
              } catch {
                return false
              }
            }
          },
          signal: record.controller.signal,
          onSegment: (segment) => this.segment(record, segment),
          onEvent: (event) => this.event(record, event),
          onGap: (gap) => this.gap(record, gap),
          onStarted: (startedAt) => {
            if (Number.isSafeInteger(startedAt) && startedAt >= 0) {
              record.recording.startedAt = startedAt
              record.clockStart = this.monotonic()
            }
          },
          onDroppedFrames: (count) => {
            if (Number.isSafeInteger(count) && count > 0)
              record.recording.coverage.droppedFrames += count
          },
          onEnded: (reason) => {
            if (reason === 'capture-failed') record.error = 'capture-failed'
            queueMicrotask(() => {
              void this.finish(record, 'interrupted')
            })
          }
        })
        if (record.state === 'starting') record.state = 'recording'
        const maxDuration = this.dependencies.maxDurationMs ?? 60 * 60 * 1000
        record.timer = setTimeout(() => {
          void this.finish(record, 'capacity')
        }, maxDuration)
        record.timer.unref?.()
      } catch {
        record.state = 'failed'
        record.error = 'capture-failed'
        source.pending.delete(record)
      }
    })()
    await record.ready
    return this.describe(record)
  }

  async control(
    method: 'pause' | 'resume' | 'stop',
    viewerId: string,
    value: unknown
  ): Promise<BrowserRecordingStatus> {
    const request = requestSchema.parse(value)
    const record = request.recordingId && this.records.get(request.recordingId)
    if (!record || record.viewerId !== viewerId)
      throw new Error('Recording is outside this viewer.')
    record.assertAuthorized()
    const previous = record.actions.get(request.requestId)
    if (previous) {
      if (previous.method !== method) throw new Error('Recording request identity was reused.')
      return previous.result
    }
    if (record.actions.size >= 512) throw new Error('Recording action capacity reached.')
    const result = record.controlTail
      .catch(() => undefined)
      .then(async () => {
        await record.ready
        if (method === 'stop') return this.finish(record, 'stopped')
        if (finished(record.state) || record.state === 'finalizing') return this.describe(record)
        if (method === 'pause' && record.state === 'recording') {
          await record.driver!.pause()
          if (record.state === 'recording') record.state = 'paused'
        } else if (method === 'resume' && record.state === 'paused') {
          record.source.assertCurrent()
          await record.driver!.resume()
          if (record.state === 'paused') record.state = 'recording'
        }
        return this.describe(record)
      })
    record.controlTail = result
    record.actions.set(request.requestId, { method, result })
    return result
  }

  private segment(
    record: RecordState,
    input: Omit<BrowserRecordingSegment, 'segmentId' | 'mediaKey'> & { bytes: Uint8Array }
  ): Promise<void> {
    const bytes = Buffer.from(input.bytes)
    const operation = record.tail
      .then(async () => {
        if (finished(record.state) || record.source.signal.aborted) return
        record.source.assertCurrent()
        const number = record.recording.segments.length
        if (
          !bytes.length ||
          bytes.length > MAX_BROWSER_RECORDING_SEGMENT_BYTES ||
          record.bytes + bytes.length > (this.dependencies.maxBytes ?? 512 * 1024 * 1024) ||
          number >= MAX_BROWSER_RECORDING_ITEMS
        ) {
          record.error = 'capacity'
          queueMicrotask(() => {
            void this.finish(record, 'capacity')
          })
          return
        }
        const mediaKey = `segment-${number}`
        const segment = browserRecordingSegmentSchema.parse({
          startMs: input.startMs,
          endMs: input.endMs,
          width: input.width,
          height: input.height,
          codec: input.codec,
          frameRate: input.frameRate,
          segmentId: mediaKey,
          mediaKey
        })
        if (segment.startMs < (record.recording.segments.at(-1)?.endMs ?? 0))
          throw new Error('Recording segments overlap.')
        const name = `web-recording-${record.id}-${number}.webm`
        const result = await record.source.save({
          filename: name,
          contentType: 'video/webm',
          source: { kind: 'inline', encoding: 'base64', content: bytes.toString('base64') }
        })
        if (result.status !== 'saved') throw new Error('Recording segment could not be saved.')
        record.recording.media.push({
          mediaKey,
          name,
          mimeType: 'video/webm',
          checksum: hash(bytes),
          sizeBytes: bytes.length,
          sourceVersionId: result.artifact.versionId
        })
        record.recording.segments.push(segment)
        record.bytes += bytes.length
        record.recording.durationMs = Math.max(record.recording.durationMs, segment.endMs)
        // Every committed segment gets an immutable partial index. Crash recovery never needs
        // to restart the project or reinterpret an unfinalized encoder buffer.
        await this.publish(record, 'interrupted', 'checkpoint')
      })
      .catch(() => {
        record.error = 'publication-failed'
        queueMicrotask(() => {
          void this.finish(record, 'interrupted')
        })
      })
    record.tail = operation
    return operation
  }

  private event(record: RecordState, input: Omit<BrowserRecordingEvent, 'eventId'>): void {
    if (finished(record.state) || record.recording.events.length >= MAX_BROWSER_RECORDING_ITEMS)
      return
    const event = browserRecordingEventSchema.safeParse({
      ...input,
      eventId: `event-${record.recording.events.length}`
    })
    if (!event.success || event.data.offsetMs < (record.recording.events.at(-1)?.offsetMs ?? 0))
      return
    record.recording.events.push(event.data)
  }
  private gap(record: RecordState, input: z.infer<typeof browserRecordingGapSchema>): void {
    if (
      finished(record.state) ||
      record.recording.coverage.gaps.length >= MAX_BROWSER_RECORDING_ITEMS
    )
      return
    const gap = browserRecordingGapSchema.safeParse(input)
    if (!gap.success || gap.data.endMs <= gap.data.startMs) return
    const last = record.recording.coverage.gaps.at(-1)
    if (last && gap.data.startMs < last.endMs) return
    record.recording.coverage.gaps.push(gap.data)
  }

  private async publish(
    record: RecordState,
    reason: BrowserRecording['coverage']['stopReason'],
    publication: 'checkpoint' | 'final'
  ): Promise<void> {
    record.source.assertCurrent()
    const durationMs = Math.max(
      record.recording.durationMs,
      record.recording.events.at(-1)?.offsetMs ?? 0,
      record.recording.coverage.gaps.at(-1)?.endMs ?? 0
    )
    const recording = validateBrowserRecording({
      ...record.recording,
      durationMs,
      coverage: { ...record.recording.coverage, stopReason: reason }
    })
    const result = await record.source.save({
      // The managed writer binds an idempotent write to its filename for this operation.
      // A changed index needs its own immutable filename, never a repeated write identity.
      filename:
        publication === 'checkpoint'
          ? `web-recording-${record.id}-checkpoint-${recording.segments.length}.json`
          : `web-recording-${record.id}.json`,
      contentType: 'application/json',
      source: { kind: 'inline', content: JSON.stringify(recording) }
    })
    if (result.status !== 'saved') throw new Error('Recording index could not be saved.')
    const target = {
      projectId: record.source.target.projectId,
      sessionId: record.source.target.sessionId,
      artifactId: result.artifact.artifactId,
      versionId: result.artifact.versionId
    }
    if (this.dependencies.dataRoot) {
      const content = JSON.stringify(recording)
      const receipt = {
        target,
        checksum: hash(Buffer.from(content)),
        sizeBytes: Buffer.byteLength(content),
        mapping: Object.fromEntries(
          recording.media.map((media) => [media.sourceVersionId, media.sourceVersionId])
        )
      }
      const path = this.receiptPath(target)!
      await mkdir(join(this.dependencies.dataRoot, 'browser-recordings', 'receipts'), {
        recursive: true,
        mode: 0o700
      })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    }
    record.target = target
    record.recording.durationMs = durationMs
  }

  private receiptPath(target: BrowserRecordingTarget): string | undefined {
    if (!this.dependencies.dataRoot) return undefined
    const key = hash(
      Buffer.from(
        JSON.stringify([target.projectId, target.sessionId, target.artifactId, target.versionId])
      )
    )
    return join(this.dependencies.dataRoot, 'browser-recordings', 'receipts', `${key}.json`)
  }

  /** Pure Main-private attestation read. Importing an index does not create this receipt. */
  async readNativeSourceVersionMapping(
    target: BrowserRecordingTarget,
    identity: { checksum: string; sizeBytes: number }
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const path = this.receiptPath(target)
    if (!path) return undefined
    try {
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let contents: string
      try {
        const limit = 1024 * 1024
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > limit) return undefined
        const buffer = Buffer.alloc(limit + 1)
        let total = 0
        while (total <= limit) {
          const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
          if (!bytesRead) break
          total += bytesRead
        }
        if (total > limit) return undefined
        contents = buffer.subarray(0, total).toString('utf8')
      } finally {
        await file.close()
      }
      const receipt = z
        .object({
          target: browserRecordingTargetSchema,
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
          sizeBytes: z.number().int().nonnegative(),
          mapping: z.record(
            z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
            z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
          )
        })
        .strict()
        .parse(JSON.parse(contents))
      if (
        receipt.checksum !== identity.checksum ||
        receipt.sizeBytes !== identity.sizeBytes ||
        (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).some(
          (field) => receipt.target[field] !== target[field]
        ) ||
        Object.entries(receipt.mapping).some(([source, receiving]) => source !== receiving) ||
        Object.keys(receipt.mapping).length > MAX_BROWSER_RECORDING_ITEMS
      )
        return undefined
      return Object.freeze(receipt.mapping)
    } catch {
      return undefined
    }
  }

  private finish(
    record: RecordState,
    reason: BrowserRecording['coverage']['stopReason']
  ): Promise<BrowserRecordingStatus> {
    if (record.completion) return record.completion
    record.completion = (async () => {
      await record.ready
      if (record.timer) clearTimeout(record.timer)
      if (finished(record.state)) return this.describe(record)
      record.state = 'finalizing'
      try {
        await record.driver?.stop()
      } catch {
        record.error ??= 'capture-failed'
      }
      await record.tail
      record.controller.abort()
      try {
        if (record.recording.segments.length) {
          await this.publish(record, record.error ? 'interrupted' : reason, 'final')
          record.state =
            !record.error && ['finished', 'stopped'].includes(reason) ? 'finalized' : 'partial'
        } else {
          record.state = 'failed'
          record.error ??= 'capture-failed'
        }
      } catch {
        record.state = record.target ? 'partial' : 'failed'
        record.error = 'publication-failed'
      }
      record.source.pending.delete(record)
      return this.describe(record)
    })()
    return record.completion
  }

  private monotonic(): number {
    return (this.dependencies.monotonicNow ?? (() => performance.now()))()
  }
  private describe(record: RecordState): BrowserRecordingStatus {
    return {
      recordingId: record.id,
      state: record.state,
      elapsedMs: finished(record.state)
        ? record.recording.durationMs
        : Math.max(0, Math.floor(this.monotonic() - record.clockStart)),
      segments: record.recording.segments.length,
      bytes: record.bytes,
      droppedFrames: record.recording.coverage.droppedFrames,
      ...(record.target ? { target: { ...record.target } } : {}),
      ...(record.error ? { error: record.error } : {})
    }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const source of this.sources.values()) source.closing = true
    await Promise.all(
      [...this.records.values()].map((record) => this.finish(record, 'interrupted'))
    )
    this.sources.clear()
  }
}
