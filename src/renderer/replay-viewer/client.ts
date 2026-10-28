import { z } from 'zod'
import {
  recordedObservationSelectionSchema as recordedSelectionSchema,
  verifyRecordedObservationSelection,
  equalRecordedEvidence as equivalent
} from '../../shared/recorded-observation-selection'
import { researchReplayTargetSchema } from '../../shared/research-replay'
import {
  browserRecordingMomentSchema,
  browserRecordingStatusSchema,
  browserRecordingInspectionSchema,
  type BrowserRecordingStatus,
  type BrowserRecordingInspection,
  type BrowserRecordingControlRequest,
  type RecordedBrowserPayload,
  type BrowserRecordingMoment
} from '../../shared/browser-recording'
import { LOCALES, type Locale } from '../../shared/locale'
import {
  applyRunObservationChanges,
  runObservationCursorSchema,
  runObservationExecutionContextSchema,
  runObservationIdentitySchema,
  runObservationSnapshotSchema,
  runObservationTargetSchema,
  type RunObservationChanges,
  type RunObservationHistory,
  type RunObservationSelection,
  type RunObservationSnapshot
} from '../../shared/run-observation'
import {
  recordedObservationTargetSchema,
  recordedEvidencePayloadSchema,
  recordedEvidenceFormatSchema,
  type RecordedEvidencePayload,
  recordedFileSelectionSchema,
  recordedFileSelectionForPayload,
  type RecordedObservationFileSelection,
  type RecordedObservationPayload,
  type RecordedObservationTarget,
  type RecordedRunObservationSelection
} from '../../shared/run-observation-recorded'
import type { ReplayResource } from '../../shared/replay'
import type { RuntimeViewAccess } from '../../shared/runtime-view'
import type { RecordedObservationViewerAccess } from '../../shared/run-observation-viewer'
import type { ReplayPreparedResource } from '../src/pages/workspace/replay/replay-resources'
import { replayImageSource } from '../src/pages/workspace/replay/replay-svg'
import {
  runObservationRecordingStatusSchema,
  type RunObservationRecordingStatus
} from '../../shared/run-observation-recording-status'
import {
  observationMediaCaptureOptionsSchema,
  observationMediaCaptureRequestSchema,
  observationViewerCaptureSchema,
  type ObservationMediaCaptureOptions,
  type ObservationMediaCaptureRequest,
  type ObservationMediaCaptureResult,
  type ObservationViewerCapture
} from '../../shared/run-observation-capture'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const liveContextSchema = z
  .object({
    viewerId: id,
    mode: z.literal('live').optional(),
    target: runObservationTargetSchema,
    expiresAt: z.number().finite(),
    presentation: z.enum(['desktop', 'browser']).optional(),
    locale: z.enum(LOCALES).optional(),
    canInteract: z.boolean(),
    canCancel: z.boolean(),
    canCapture: z.boolean().optional(),
    canRecord: z.boolean().optional(),
    canReadArtifacts: z.boolean()
  })
  .strict()
const recordedContextSchema = liveContextSchema.extend({
  mode: z.literal('recorded'),
  format: recordedEvidenceFormatSchema.optional(),
  target: recordedObservationTargetSchema,
  canInteract: z.literal(false),
  canCancel: z.literal(false),
  canCapture: z.literal(false).optional(),
  canRecord: z.literal(false).optional()
})
const researchContextSchema = z
  .object({
    viewerId: id,
    mode: z.literal('research'),
    target: researchReplayTargetSchema,
    expiresAt: z.number().finite(),
    presentation: z.enum(['desktop', 'browser']).optional(),
    locale: z.enum(LOCALES).optional(),
    canInteract: z.literal(false),
    canCancel: z.literal(false),
    canReadArtifacts: z.boolean(),
    canCapture: z.literal(false).optional(),
    canRecord: z.literal(false).optional()
  })
  .strict()
const contextSchema = z.union([liveContextSchema, recordedContextSchema, researchContextSchema])
export type ResearchReplayViewerContext = z.infer<typeof researchContextSchema>
export type RecordedReplayViewerContext = z.infer<typeof recordedContextSchema>
export type ReplayViewerContext = z.infer<typeof contextSchema>
const historySchema = z
  .object({
    coverage: z.literal('process-local'),
    truncated: z.boolean(),
    snapshots: z.array(runObservationSnapshotSchema).min(1).max(128)
  })
  .strict()
const selectionSchema = z
  .object({
    selectionId: id,
    identity: runObservationIdentitySchema,
    cursor: runObservationCursorSchema,
    stepId: z.string().min(1).max(256),
    selectedAt: z.number().finite(),
    snapshot: runObservationSnapshotSchema
  })
  .strict()
const changesSchema = z.union([
  z
    .object({
      kind: z.literal('resync'),
      reason: z.enum(['epoch-changed', 'cursor-expired', 'cursor-ahead']),
      snapshot: runObservationSnapshotSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('delta'),
      from: runObservationCursorSchema,
      cursor: runObservationCursorSchema,
      changes: z
        .array(
          z
            .object({
              cursor: runObservationCursorSchema,
              observedAt: z.number().finite(),
              identity: runObservationIdentitySchema.optional(),
              phase: runObservationSnapshotSchema.shape.phase.optional(),
              stepId: runObservationSnapshotSchema.shape.stepId.optional(),
              run: runObservationSnapshotSchema.shape.run.optional(),
              artifacts: runObservationSnapshotSchema.shape.artifacts.optional(),
              artifactsTruncated: z.boolean().optional(),
              executionContext: runObservationExecutionContextSchema.optional()
            })
            .strict()
        )
        .max(128)
    })
    .strict()
])
const runtimeAccessSchema = z
  .object({
    url: z.string().max(8192),
    view: z
      .object({
        viewId: id,
        scope: z
          .object({ projectId: id, sessionId: id, runId: id, environmentId: id, generationId: id })
          .strict(),
        title: z.string().max(256),
        state: z.enum(['ready', 'closed', 'failed']),
        createdAt: z.string(),
        expiresAt: z.string(),
        embeddingAdapted: z.boolean(),
        closedReason: z.string().optional()
      })
      .strict()
  })
  .strict()

const verifiedRecordedSelection = (
  raw: unknown,
  payload: RecordedObservationPayload,
  stepKey?: string
): RecordedRunObservationSelection => {
  try {
    return verifyRecordedObservationSelection(raw, payload, stepKey)
  } catch {
    throw new ReplayViewerRequestError('invalid-response')
  }
}

export class ReplayViewerRequestError extends Error {
  constructor(
    readonly kind: 'authorization' | 'unavailable' | 'invalid-response' | 'network',
    readonly status?: number
  ) {
    super('The scoped observation request did not complete.')
    this.name = 'ReplayViewerRequestError'
  }
}
const verifiedRecordedFileSelection = (
  value: unknown,
  payload: RecordedEvidencePayload,
  mediaKey?: string
): RecordedObservationFileSelection => {
  const selection = recordedFileSelectionSchema.parse(value)
  if ('indexChecksum' in payload) throw new ReplayViewerRequestError('unavailable')
  try {
    const expected = recordedFileSelectionForPayload(payload, selection.mediaKey)
    const content = { ...selection }
    delete content.selectionId
    delete content.selectedAt
    if ((mediaKey && mediaKey !== selection.mediaKey) || !equivalent(content, expected))
      throw new Error('Mismatched evidence.')
  } catch {
    throw new ReplayViewerRequestError('invalid-response')
  }
  return selection
}
const boundedBytes = async (
  response: Response,
  maxBytes: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), truncated: false }
  const chunks: Uint8Array[] = []
  let size = 0,
    truncated = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const keep = Math.min(result.value.byteLength, maxBytes - size)
      if (keep > 0) {
        chunks.push(result.value.slice(0, keep))
        size += keep
      }
      if (keep < result.value.byteLength) {
        truncated = true
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}
const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

/** Fixed viewer-relative endpoints only. No token, destination URL or target scope enters a call. */
export class ReplayViewerClient {
  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  protected async request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await this.fetcher(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ReplayViewerRequestError('network')
    }
    if (!response.ok)
      throw new ReplayViewerRequestError(
        response.status === 401 || response.status === 403 ? 'authorization' : 'unavailable',
        response.status
      )
    return response
  }
  protected async json<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.request(path, body, signal)
    try {
      return schema.parse(await response.json())
    } catch {
      throw new ReplayViewerRequestError('invalid-response')
    }
  }
  context(signal?: AbortSignal): Promise<ReplayViewerContext> {
    return this.json('/api/context', contextSchema, undefined, signal)
  }
  async initialLocale(fallback: Locale, signal?: AbortSignal): Promise<Locale> {
    try {
      const context = await this.context(signal)
      return context.presentation === 'desktop' ? (context.locale ?? fallback) : fallback
    } catch {
      // Render the normal reconnect/authorization surface even if initial context is unavailable.
      return fallback
    }
  }
  recordingStatus(signal?: AbortSignal): Promise<RunObservationRecordingStatus> {
    return this.json(
      '/api/recording-status',
      runObservationRecordingStatusSchema,
      undefined,
      signal
    )
  }
  async openArchive(
    expected: RecordedObservationTarget,
    format?: 'web-recording'
  ): Promise<RecordedObservationViewerAccess> {
    const access = await this.json(
      format === 'web-recording' ? '/api/project-recordings/open' : '/api/open-archive',
      z
        .object({
          mode: z.literal('recorded'),
          format: recordedEvidenceFormatSchema.optional(),
          viewerId: id,
          target: recordedObservationTargetSchema,
          expiresAt: z.number().finite(),
          url: z.string().max(8192)
        })
        .strict(),
      {}
    )
    let validUrl = false
    try {
      const url = new URL(access.url)
      validUrl =
        url.protocol === 'http:' &&
        url.hostname === `viewer-${access.viewerId}.localhost` &&
        Boolean(url.port) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.pathname === '/__open_science_viewer' &&
        /^[a-f0-9]{64}$/.test(url.searchParams.get('grant') ?? '') &&
        [...url.searchParams.keys()].length === 1
    } catch {
      /* Invalid access is never a navigation destination. */
    }
    if (
      !validUrl ||
      (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).some(
        (field) => access.target[field] !== expected[field]
      )
    )
      throw new ReplayViewerRequestError('invalid-response')
    return access
  }
  captureOptions(signal?: AbortSignal): Promise<ObservationMediaCaptureOptions> {
    return this.json(
      '/api/capture-options',
      observationMediaCaptureOptionsSchema,
      undefined,
      signal
    )
  }
  async capture(request: ObservationMediaCaptureRequest): Promise<ObservationViewerCapture> {
    const result = await this.json(
      '/api/capture',
      observationViewerCaptureSchema,
      observationMediaCaptureRequestSchema.parse(request)
    )
    if (result.capture.source !== request.source)
      throw new ReplayViewerRequestError('invalid-response')
    return result
  }
  captures(signal?: AbortSignal): Promise<ObservationViewerCapture[]> {
    return this.json(
      '/api/captures',
      z.array(observationViewerCaptureSchema).max(4096),
      undefined,
      signal
    )
  }
  async captureImage(capture: ObservationMediaCaptureResult): Promise<string | null> {
    const response = await this.request(
      `/api/capture-media?captureId=${encodeURIComponent(capture.captureId)}`
    )
    const { bytes, truncated } = await boundedBytes(response, capture.sizeBytes)
    if (truncated || bytes.byteLength !== capture.sizeBytes) return null
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))
    )
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
    return digest === capture.checksum
      ? (replayImageSource(capture.mimeType, base64(bytes)) ?? null)
      : null
  }
  recording(signal?: AbortSignal): Promise<RecordedEvidencePayload> {
    return this.json('/api/recording', recordedEvidencePayloadSchema, undefined, signal)
  }
  inspectBrowserRecording(signal?: AbortSignal): Promise<BrowserRecordingInspection> {
    return this.json(
      '/api/project-recordings/inspect',
      browserRecordingInspectionSchema,
      undefined,
      signal
    )
  }
  browserRecordingStatus(signal?: AbortSignal): Promise<BrowserRecordingStatus> {
    return this.json(
      '/api/project-recordings/status',
      browserRecordingStatusSchema,
      undefined,
      signal
    )
  }
  controlBrowserRecording(
    method: 'start' | 'pause' | 'resume' | 'stop',
    request: BrowserRecordingControlRequest,
    signal?: AbortSignal
  ): Promise<BrowserRecordingStatus> {
    return this.json(
      `/api/project-recordings/${method}`,
      browserRecordingStatusSchema,
      request,
      signal
    )
  }
  browserRecordingMediaUrl(payload: RecordedBrowserPayload, mediaKey: string): string | null {
    const declared = payload.recording.media.find((item) => item.mediaKey === mediaKey)
    const resolved = payload.media.find((item) => item.mediaKey === mediaKey)
    if (
      !declared ||
      !resolved ||
      declared.checksum !== resolved.checksum ||
      declared.sizeBytes !== resolved.sizeBytes
    )
      return null
    return `/api/recording/media?mediaKey=${encodeURIComponent(mediaKey)}`
  }
  private verifyBrowserMoment(
    payload: RecordedBrowserPayload,
    value: unknown,
    offsetMs?: number
  ): BrowserRecordingMoment {
    const moment = browserRecordingMomentSchema.parse(value)
    const segment = payload.recording.segments.find((item) => item.segmentId === moment.segmentId)
    const declared = payload.recording.media.find((item) => item.mediaKey === moment.mediaKey)
    const resolved = payload.media.find((item) => item.mediaKey === moment.mediaKey)
    if (
      !segment ||
      !declared ||
      !resolved ||
      !equivalent(moment.receiving, payload.receiving) ||
      moment.indexChecksum !== payload.indexChecksum ||
      moment.recordingId !== payload.recording.recordingId ||
      (offsetMs !== undefined && moment.offsetMs !== offsetMs) ||
      moment.offsetMs < segment.startMs ||
      moment.offsetMs >= segment.endMs ||
      moment.segmentOffsetMs !== moment.offsetMs - segment.startMs ||
      segment.mediaKey !== moment.mediaKey ||
      moment.resource.artifactId !== resolved.artifactId ||
      moment.resource.versionId !== resolved.versionId ||
      moment.resource.checksum !== declared.checksum ||
      moment.resource.checksum !== resolved.checksum ||
      moment.resource.sizeBytes !== declared.sizeBytes ||
      moment.resource.sizeBytes !== resolved.sizeBytes ||
      moment.resource.name !== declared.name
    )
      throw new ReplayViewerRequestError('invalid-response')
    return moment
  }
  async selectBrowserMoment(
    payload: RecordedBrowserPayload,
    offsetMs: number,
    signal?: AbortSignal
  ): Promise<BrowserRecordingMoment> {
    const value = await this.json(
      '/api/recording/moment',
      browserRecordingMomentSchema,
      { offsetMs },
      signal
    )
    return this.verifyBrowserMoment(payload, value, offsetMs)
  }
  async browserMoment(
    payload: RecordedBrowserPayload,
    signal?: AbortSignal
  ): Promise<BrowserRecordingMoment | null> {
    const value = await this.json(
      '/api/recording/moment',
      browserRecordingMomentSchema.nullable(),
      undefined,
      signal
    )
    return value ? this.verifyBrowserMoment(payload, value) : null
  }
  async selectRecording(
    payload: RecordedObservationPayload,
    stepKey: string,
    signal?: AbortSignal
  ): Promise<RecordedRunObservationSelection> {
    if (!payload.archive.records.some((record) => record.stepKey === stepKey))
      throw new ReplayViewerRequestError('unavailable')
    const response = await this.json(
      '/api/recording/select',
      recordedSelectionSchema,
      { stepKey },
      signal
    )
    return verifiedRecordedSelection(response, payload, stepKey)
  }
  async recordedSelection(
    payload: RecordedObservationPayload,
    signal?: AbortSignal
  ): Promise<RecordedRunObservationSelection | null> {
    const response = await this.json(
      '/api/recording/selection',
      recordedSelectionSchema.nullable(),
      undefined,
      signal
    )
    return response ? verifiedRecordedSelection(response, payload) : null
  }
  async selectRecordingFile(
    payload: RecordedEvidencePayload,
    mediaKey: string,
    signal?: AbortSignal
  ): Promise<RecordedObservationFileSelection> {
    if ('indexChecksum' in payload) throw new ReplayViewerRequestError('unavailable')
    try {
      recordedFileSelectionForPayload(payload, mediaKey)
    } catch {
      throw new ReplayViewerRequestError('unavailable')
    }
    const response = await this.json(
      '/api/recording/file-selection',
      recordedFileSelectionSchema,
      { mediaKey },
      signal
    )
    return verifiedRecordedFileSelection(response, payload, mediaKey)
  }
  async recordedFileSelection(
    payload: RecordedEvidencePayload,
    signal?: AbortSignal
  ): Promise<RecordedObservationFileSelection | null> {
    const response = await this.json(
      '/api/recording/file-selection',
      recordedFileSelectionSchema.nullable(),
      undefined,
      signal
    )
    return response ? verifiedRecordedFileSelection(response, payload) : null
  }
  async recordedMedia(
    payload: RecordedEvidencePayload,
    resource: ReplayResource,
    signal?: AbortSignal
  ): Promise<{ content: string; mimeType: string; truncated: boolean }> {
    const resolved = payload.media.find(
      (item) => item.artifactId === resource.artifactId && item.versionId === resource.versionId
    )
    const declared =
      resolved &&
      ('archive' in payload ? payload.archive : payload.recording).media.find(
        (item) => item.mediaKey === resolved.mediaKey
      )
    if (
      !resolved ||
      !declared ||
      resource.projectId !== payload.receiving.projectId ||
      resource.sessionId !== payload.receiving.sessionId ||
      resolved.checksum !== declared.checksum ||
      resolved.sizeBytes !== declared.sizeBytes ||
      resource.availability !== 'recorded'
    )
      throw new ReplayViewerRequestError('unavailable')
    const response = await this.request(
      `/api/recording/media?mediaKey=${encodeURIComponent(resolved.mediaKey)}`,
      undefined,
      signal
    )
    return this.resourceBytes(response, {
      ...resource,
      name: declared.name,
      mimeType: declared.mimeType
    })
  }
  async readRecordedResource(
    payload: RecordedEvidencePayload,
    resource: ReplayResource
  ): Promise<ReplayPreparedResource> {
    return this.prepareResource(resource, () => this.recordedMedia(payload, resource))
  }
  snapshot(signal?: AbortSignal): Promise<RunObservationSnapshot> {
    return this.json('/api/snapshot', runObservationSnapshotSchema, undefined, signal)
  }
  history(signal?: AbortSignal): Promise<RunObservationHistory> {
    return this.json('/api/history', historySchema, undefined, signal)
  }
  changes(snapshot: RunObservationSnapshot, signal?: AbortSignal): Promise<RunObservationChanges> {
    return this.json('/api/changes', changesSchema, { cursor: snapshot.cursor }, signal)
  }
  async select(
    snapshot: RunObservationSnapshot,
    signal?: AbortSignal
  ): Promise<RunObservationSelection> {
    const selected = await this.json(
      '/api/select',
      selectionSchema,
      { cursor: snapshot.cursor, stepId: snapshot.stepId },
      signal
    )
    if (
      selected.cursor.epoch !== snapshot.cursor.epoch ||
      selected.cursor.sequence !== snapshot.cursor.sequence ||
      selected.stepId !== snapshot.stepId ||
      selected.snapshot.cursor.epoch !== snapshot.cursor.epoch ||
      selected.snapshot.cursor.sequence !== snapshot.cursor.sequence ||
      JSON.stringify(selected.identity) !==
        JSON.stringify(runObservationIdentitySchema.parse(snapshot.identity)) ||
      JSON.stringify(selected.snapshot) !==
        JSON.stringify(runObservationSnapshotSchema.parse(snapshot))
    )
      throw new ReplayViewerRequestError('invalid-response')
    return selected
  }
  selection(signal?: AbortSignal): Promise<RunObservationSelection | null> {
    return this.json('/api/selection', selectionSchema.nullable(), undefined, signal)
  }
  async projectView(
    snapshot: RunObservationSnapshot,
    signal?: AbortSignal
  ): Promise<RuntimeViewAccess> {
    const access = await this.json('/api/project-view', runtimeAccessSchema, {}, signal)
    let url: URL
    try {
      url = new URL(access.url)
    } catch {
      throw new ReplayViewerRequestError('invalid-response')
    }
    const scope = access.view.scope
    if (
      access.view.state !== 'ready' ||
      !snapshot.run ||
      scope.projectId !== snapshot.identity.projectId ||
      scope.sessionId !== snapshot.identity.sessionId ||
      scope.runId !== snapshot.run.runId ||
      url.protocol !== 'http:' ||
      url.hostname !== `rv-${access.view.viewId}.localhost` ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/__open_science_view' ||
      !/^[a-f0-9]{64}$/.test(url.searchParams.get('grant') ?? '') ||
      [...url.searchParams.keys()].some((key) => key !== 'grant')
    )
      throw new ReplayViewerRequestError('invalid-response')
    return access
  }
  async cancel(signal?: AbortSignal): Promise<void> {
    await this.request('/api/cancel', { confirmed: true }, signal)
  }
  async artifact(
    resource: ReplayResource,
    signal?: AbortSignal
  ): Promise<{ content: string; mimeType: string; truncated: boolean }> {
    if (!resource.versionId || resource.availability !== 'recorded')
      throw new ReplayViewerRequestError('unavailable')
    const response = await this.request(
      `/api/artifact?versionId=${encodeURIComponent(resource.versionId)}`,
      undefined,
      signal
    )
    return this.resourceBytes(response, resource)
  }
  protected async resourceBytes(
    response: Response,
    resource: ReplayResource
  ): Promise<{ content: string; mimeType: string; truncated: boolean }> {
    const extension = resource.name.split('.').at(-1)?.toLowerCase() ?? ''
    const imageMime =
      imageTypes[extension] ??
      (resource.mimeType && Object.values(imageTypes).includes(resource.mimeType)
        ? resource.mimeType
        : undefined)
    const { bytes, truncated } = await boundedBytes(
      response,
      imageMime ? 16 * 1024 * 1024 : 192 * 1024
    )
    const mimeType =
      imageMime ??
      response.headers.get('content-type')?.split(';')[0] ??
      resource.mimeType ??
      'text/plain'
    return {
      content: imageMime ? base64(bytes) : new TextDecoder().decode(bytes),
      mimeType,
      truncated
    }
  }
  async readResource(resource: ReplayResource): Promise<ReplayPreparedResource> {
    return this.prepareResource(resource, () => this.artifact(resource))
  }
  protected async prepareResource(
    resource: ReplayResource,
    read: () => Promise<{ content: string; mimeType: string; truncated: boolean }>
  ): Promise<ReplayPreparedResource> {
    try {
      const result = await read()
      if (result.mimeType.startsWith('image/')) {
        const source = !result.truncated && replayImageSource(result.mimeType, result.content)
        return source
          ? {
              status: 'ready',
              kind: 'image',
              content: source,
              mimeType: result.mimeType,
              truncated: false
            }
          : { status: 'unsupported' }
      }
      if (result.mimeType === 'text/html' || /\.html?$/i.test(resource.name))
        return { status: 'unsupported' }
      if (
        !result.mimeType.startsWith('text/') &&
        !/^application\/(?:json|xml|javascript|x-yaml)$/.test(result.mimeType)
      )
        return { status: 'unsupported' }
      return {
        status: 'ready',
        kind: /\.(?:csv|tsv)$/i.test(resource.name) ? 'table' : 'text',
        ...result
      }
    } catch {
      return { status: 'unavailable', reason: 'read-failed' }
    }
  }
}

/** Rebuild every observed intermediate state; do not erase steps by applying only the last delta. */
export function appendViewerChanges(
  history: RunObservationHistory,
  update: RunObservationChanges
): RunObservationHistory {
  const latest = history.snapshots.at(-1)
  if (!latest) throw new ReplayViewerRequestError('invalid-response')
  if (update.kind === 'resync') {
    const next = applyRunObservationChanges(latest, update)
    return next === latest
      ? history
      : { coverage: 'process-local', truncated: true, snapshots: [next] }
  }
  const snapshots = [...history.snapshots]
  let current = latest
  // The shared applier validates the complete chain before any new state is published.
  applyRunObservationChanges(current, update)
  for (const change of update.changes) {
    if (change.cursor.sequence <= current.cursor.sequence) continue
    current = runObservationSnapshotSchema.parse({ ...current, ...change })
    snapshots.push(current)
  }
  return {
    coverage: 'process-local',
    truncated: history.truncated || snapshots.length > 128,
    snapshots: snapshots.slice(-128)
  }
}
