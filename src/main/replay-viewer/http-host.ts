import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { z } from 'zod'
import {
  browserRecordingMethodSchema,
  browserRecordingInspectionSchema,
  browserRecordingStatusSchema,
  type BrowserRecordingMethod
} from '../../shared/browser-recording'
import type { CallerContext } from '../caller-context'
import type { Locale } from '../../shared/locale'
import type {
  ObservationFramePort,
  ObservationFrameRegistration
} from '../observation-desktop/frame-port'
import type { ManagedRuntimeViews } from '../managed-runtime-views'
import type {
  ObservationViewers,
  ObservationViewAccess,
  ObservationViewDescriptor
} from '../run-observation/viewers'
import { ObservationViewerError } from '../run-observation/viewers'
import {
  runObservationCursorSchema,
  type RunObservationArtifact,
  type RunObservationTarget
} from '../../shared/run-observation'

import type { RecordedObservationTarget } from '../../shared/run-observation-recorded'
import {
  runObservationRecordingStatusSchema,
  type RunObservationRecordingStatus
} from '../../shared/run-observation-recording-status'
import {
  observationMediaCaptureRequestSchema,
  observationCaptureContentRequestSchema,
  MAX_OBSERVATION_CAPTURE_CHUNK_BYTES,
  type ObservationCaptureContent,
  type ObservationCaptureContentRequest,
  type ObservationMediaCaptureRequest,
  type ObservationMediaCaptureResult,
  type ObservationViewerCapture
} from '../../shared/run-observation-capture'

type RecordedEvidenceFormat = import('../../shared/run-observation-recorded').RecordedEvidenceFormat

export type ReplayViewerHttpAccess = ObservationViewDescriptor & Readonly<{ url: string }>
export type ReplayViewerHttpOpenOptions = Readonly<{
  allowInteraction?: boolean
  allowCancel?: boolean
  allowCapture?: boolean
  allowRecording?: boolean
  desktopParent?: 'file:'
}>
type Asset = Readonly<{ body: Uint8Array; mimeType: string }>
type Viewers = Pick<
  ObservationViewers,
  | 'create'
  | 'createRecorded'
  | 'recording'
  | 'selectRecording'
  | 'recordingSelection'
  | 'selectRecordingFile'
  | 'recordingFileSelection'
  | 'selectBrowserMoment'
  | 'browserMomentSelection'
  | 'issueGrant'
  | 'authenticateGrant'
  | 'describe'
  | 'snapshot'
  | 'history'
  | 'changes'
  | 'select'
  | 'selection'
  | 'revoke'
>
export interface ReplayViewerHttpDependencies {
  desktopFrames?: ObservationFramePort
  browserRecording?(
    method: BrowserRecordingMethod,
    input: {
      viewerId: string
      target: RunObservationTarget
      caller: CallerContext
      host?: { caller: CallerContext; viewerOrigin: string; projectOrigin: string }
      request: unknown
      signal: AbortSignal
      assertAuthorized(): void
    }
  ): Promise<unknown>
  /** Main's persisted desktop preference; browser viewers retain their own device language. */
  desktopLocale?(): Locale
  listCaptures?(
    target: RunObservationTarget,
    signal: AbortSignal
  ): Promise<ObservationMediaCaptureResult[]>
  readCapture?(
    target: RunObservationTarget,
    captureId: string,
    signal: AbortSignal
  ): Promise<Asset | undefined>
  recordingStatus?(target: RunObservationTarget): Promise<RunObservationRecordingStatus>
  captureOptions?(
    target: RunObservationTarget,
    hostViewAvailable: boolean
  ): Promise<{ hostView: boolean; projectExports: string[] }>
  capture?(input: {
    target: RunObservationTarget
    request: ObservationMediaCaptureRequest
    assertAuthorized(): void
    signal: AbortSignal
    host?: { caller: CallerContext; viewerOrigin: string; projectOrigin: string }
  }): Promise<{ result: ObservationMediaCaptureResult; created: boolean }>
  viewers: Viewers
  projectViews: Pick<ManagedRuntimeViews, 'open' | 'closeViewer'>
  /** Receives only index.html, favicon.ico or a validated assets/... path. */
  readAsset(path: string): Promise<Asset | undefined>
  readArtifact?(input: {
    target: RunObservationTarget
    runId: string
    artifact: RunObservationArtifact
    signal: AbortSignal
  }): Promise<Asset | undefined>
  readRecordingMedia?(
    target: RecordedObservationTarget,
    mediaKey: string,
    signal: AbortSignal,
    format?: RecordedEvidenceFormat
  ): Promise<Asset | undefined>
  cancelRun?(input: {
    target: RunObservationTarget
    runId: string
    caller: CallerContext
    signal: AbortSignal
  }): Promise<void>
}
type Binding = {
  descriptor: ObservationViewDescriptor
  caller: CallerContext
  options: ReplayViewerHttpOpenOptions
  server: Server
  origin: string
  cookie: string
  closed: boolean
  expiry?: ReturnType<typeof setTimeout>
  revalidation?: ReturnType<typeof setInterval>
  revalidating: boolean
  signal: AbortController
  sockets: Set<Socket>
  active: number
  requests: number
  projectOrigin?: string
  recordingSourceViewId?: string
  desktopFrames?: ObservationFrameRegistration
  captureEvidence: Map<string, NonNullable<ObservationViewerCapture['viewerEvidence']>>
}
const maxBody = 8192,
  maxResponse = 16 * 1024 * 1024,
  maxConnections = 16,
  maxRequests = 20000
const emptyBody = z.object({}).strict()
const changeBody = z.object({ cursor: runObservationCursorSchema }).strict()
const selectionBody = z
  .object({ cursor: runObservationCursorSchema, stepId: z.string().min(1).max(256) })
  .strict()
class HostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
const publicErrors: Record<string, string> = {
  unauthorized: 'Viewer authorization is unavailable.',
  unavailable: 'The viewer is unavailable.',
  invalid: 'The viewer request is invalid.',
  forbidden: 'This action is not authorized for this viewer.',
  'not-found': 'The requested viewer resource is unavailable.',
  'not-running': 'The observed Run is not running.',
  capacity: 'The viewer request limit was reached.',
  oversized: 'The viewer response or request exceeds its limit.',
  failed: 'The viewer request could not be completed.'
}
function sendError(response: ServerResponse, error: unknown): void {
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  const code =
    error instanceof HostError
      ? error.code
      : error instanceof ObservationViewerError
        ? error.code === 'unauthorized'
          ? 'unauthorized'
          : 'unavailable'
        : error instanceof z.ZodError
          ? 'invalid'
          : 'failed'
  const status =
    error instanceof HostError
      ? error.status
      : code === 'unauthorized'
        ? 401
        : code === 'unavailable'
          ? 410
          : code === 'invalid'
            ? 400
            : 503
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  })
  response.end(
    JSON.stringify({ error: { code, message: publicErrors[code] ?? publicErrors.failed } })
  )
}
function pathFrom(raw: string | undefined): URL {
  if (
    !raw ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.length > 2048 ||
    raw.includes('\\')
  )
    throw new HostError(400, 'invalid')
  let decoded: string
  try {
    decoded = decodeURIComponent(raw.split('?')[0])
  } catch {
    throw new HostError(400, 'invalid')
  }
  if (
    decoded.split('/').some((part) => part === '..' || part === '.') ||
    [...decoded].some((char) => char === '\\' || char.charCodeAt(0) < 32)
  )
    throw new HostError(400, 'invalid')
  return new URL(raw, 'http://viewer.invalid')
}
function assetPath(path: string): string | undefined {
  if (path === '/') return 'index.html'
  if (path === '/favicon.ico') return 'favicon.ico'
  if (
    /^\/assets\/[A-Za-z0-9/_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|woff2?|png|jpe?g|svg|gif|ico|webp)$/.test(
      path
    )
  )
    return path.slice(1)
  return undefined
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
    throw new HostError(400, 'invalid')
  if (Number(request.headers['content-length'] ?? 0) > maxBody)
    throw new HostError(413, 'oversized')
  let size = 0
  const chunks: Buffer[] = []
  for await (const value of request) {
    const chunk = Buffer.from(value)
    size += chunk.length
    if (size > maxBody) throw new HostError(413, 'oversized')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HostError(400, 'invalid')
  }
}

/** A separate, narrowly scoped web origin; it never mounts the application's management APIs. */
export class ReplayViewerHttpHost {
  private readonly bindings = new Map<string, Binding>()
  private closed = false
  constructor(private readonly dependencies: ReplayViewerHttpDependencies) {}

  async browserRecording(
    method: BrowserRecordingMethod,
    viewerId: string,
    request: unknown,
    caller: CallerContext
  ): Promise<unknown> {
    await this.dependencies.viewers.describe(viewerId, { caller })
    const binding = this.bindings.get(viewerId)
    if (!binding) throw new HostError(404, 'not-found')
    const result = await this.browserRecordingBound(method, binding, request, binding.signal.signal)
    await this.dependencies.viewers.describe(viewerId, { caller })
    return result
  }
  private async recordingSourceIdentity(
    binding: Binding,
    source: Binding
  ): Promise<string | undefined> {
    if (
      binding.descriptor.mode === 'recorded' ||
      source.descriptor.mode === 'recorded' ||
      source.options.allowRecording !== true ||
      source.caller.surface !== 'electron'
    )
      return undefined
    const target = binding.descriptor.target
    const sourceTarget = source.descriptor.target
    if (target.projectId !== sourceTarget.projectId || target.sessionId !== sourceTarget.sessionId)
      return undefined
    const [requested, actual] = await Promise.all([
      this.dependencies.viewers.snapshot(binding.descriptor.viewerId, { caller: binding.caller }),
      this.dependencies.viewers.snapshot(source.descriptor.viewerId, { caller: source.caller })
    ])
    this.assertCurrent(binding)
    this.assertCurrent(source)
    if (
      !requested.run?.runId ||
      !actual.run?.runId ||
      requested.run.runId !== actual.run.runId ||
      requested.identity.runId !== requested.run.runId ||
      actual.identity.runId !== actual.run.runId ||
      (['projectId', 'sessionId', 'operationId', 'executionInvocationId', 'runId'] as const).some(
        (key) => requested.identity[key] !== actual.identity[key]
      )
    )
      return undefined
    return JSON.stringify([
      requested.identity.projectId,
      requested.identity.sessionId,
      requested.identity.operationId,
      requested.identity.executionInvocationId,
      requested.run.runId
    ])
  }
  private async browserRecordingBound(
    method: BrowserRecordingMethod,
    binding: Binding,
    request: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    browserRecordingMethodSchema.parse(method)
    if (
      !this.dependencies.browserRecording ||
      binding.descriptor.mode === 'recorded' ||
      binding.options.allowRecording !== true
    )
      throw new HostError(403, 'forbidden')
    this.assertCurrent(binding)
    const value = z
      .object({
        sourceViewId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
          .optional()
      })
      .passthrough()
      .parse(request)
    const requestedSource =
      value.sourceViewId ?? (method === 'start' ? binding.recordingSourceViewId : undefined)
    let source = binding
    let sourceIdentity: string | undefined
    if (
      (method === 'start' || method === 'inspect') &&
      requestedSource &&
      requestedSource !== binding.descriptor.viewerId
    ) {
      const candidate = this.bindings.get(requestedSource)
      if (candidate) {
        sourceIdentity = await this.recordingSourceIdentity(binding, candidate)
        if (!sourceIdentity) throw new HostError(403, 'forbidden')
        await this.dependencies.viewers.describe(requestedSource, { caller: candidate.caller })
        this.assertCurrent(candidate)
        source = candidate
      } else throw new HostError(404, 'not-found')
    }
    if (source.descriptor.mode === 'recorded') throw new HostError(403, 'forbidden')
    if (method === 'start' && source.projectOrigin) {
      sourceIdentity ??= await this.recordingSourceIdentity(binding, source)
      if (!sourceIdentity) throw new HostError(403, 'forbidden')
    }
    const result = await this.dependencies.browserRecording(method, {
      viewerId: binding.descriptor.viewerId,
      target: binding.descriptor.target,
      caller: binding.caller,
      ...(source.caller.surface === 'electron' && source.projectOrigin
        ? {
            host: {
              caller: source.caller,
              viewerOrigin: source.origin,
              projectOrigin: source.projectOrigin
            }
          }
        : {}),
      request,
      signal,
      assertAuthorized: () => {
        this.assertCurrent(binding)
        if (method === 'start') this.assertCurrent(source)
      }
    })
    signal.throwIfAborted()
    this.assertCurrent(binding)
    if (
      method === 'start' &&
      sourceIdentity &&
      sourceIdentity !==
        (await this.recordingSourceIdentity(binding, source).catch(() => undefined))
    ) {
      const started = browserRecordingStatusSchema.safeParse(result)
      if (started.success && started.data.recordingId) {
        await this.dependencies
          .browserRecording('stop', {
            viewerId: binding.descriptor.viewerId,
            target: binding.descriptor.target,
            caller: binding.caller,
            request: { requestId: randomUUID(), recordingId: started.data.recordingId },
            signal,
            assertAuthorized: () => this.assertCurrent(binding)
          })
          .catch(() => undefined)
      }
      throw new HostError(403, 'forbidden')
    }
    if (method === 'start') binding.recordingSourceViewId = source.descriptor.viewerId
    if (method === 'inspect') {
      const sources: Array<{ sourceViewId: string; label: 'Desktop project page' }> = []
      for (const candidate of this.bindings.values()) {
        if (!candidate.projectOrigin) continue
        try {
          if (!(await this.recordingSourceIdentity(binding, candidate))) continue
          this.assertCurrent(candidate)
          await this.dependencies.viewers.describe(candidate.descriptor.viewerId, {
            caller: candidate.caller
          })
          sources.push({
            sourceViewId: candidate.descriptor.viewerId,
            label: 'Desktop project page'
          })
        } catch {
          /* An expired page is not a recording source. */
        }
      }
      const inspection = browserRecordingInspectionSchema.parse(result)
      return { ...inspection, sources }
    }
    return result
  }

  async captureOptions(
    viewerId: string,
    caller: CallerContext
  ): Promise<{ hostView: boolean; projectExports: string[] }> {
    const descriptor = await this.dependencies.viewers.describe(viewerId, { caller })
    const binding = this.bindings.get(viewerId)
    if (!binding || descriptor.mode === 'recorded') throw new HostError(403, 'forbidden')
    this.assertCurrent(binding)
    const result = await this.readCaptureOptions(binding)
    await this.dependencies.viewers.describe(viewerId, { caller })
    this.assertCurrent(binding)
    return result
  }

  async capture(
    viewerId: string,
    request: unknown,
    caller: CallerContext
  ): Promise<ObservationViewerCapture> {
    const descriptor = await this.dependencies.viewers.describe(viewerId, { caller })
    const binding = this.bindings.get(viewerId)
    if (!binding || descriptor.mode === 'recorded') throw new HostError(403, 'forbidden')
    const result = await this.captureBound(binding, request, binding.signal.signal)
    await this.dependencies.viewers.describe(viewerId, { caller })
    this.assertCurrent(binding)
    return result
  }

  async captures(viewerId: string, caller: CallerContext): Promise<ObservationViewerCapture[]> {
    const descriptor = await this.dependencies.viewers.describe(viewerId, { caller })
    const binding = this.bindings.get(viewerId)
    if (!binding || descriptor.mode === 'recorded') throw new HostError(403, 'forbidden')
    const frames = await this.readCaptures(binding, binding.signal.signal)
    await this.dependencies.viewers.describe(viewerId, { caller })
    this.assertCurrent(binding)
    return frames
  }

  async captureContent(
    viewerId: string,
    value: ObservationCaptureContentRequest,
    caller: CallerContext
  ): Promise<ObservationCaptureContent> {
    const request = observationCaptureContentRequestSchema.parse(value)
    const descriptor = await this.dependencies.viewers.describe(viewerId, { caller })
    const binding = this.bindings.get(viewerId)
    if (!binding || descriptor.mode === 'recorded' || !this.dependencies.readCapture)
      throw new HostError(403, 'forbidden')
    const frames = await this.readCaptures(binding, binding.signal.signal)
    const frame = frames.find((item) => item.captureId === request.captureId)
    if (!frame) throw new HostError(404, 'not-found')
    const asset = await this.dependencies.readCapture(
      descriptor.target,
      request.captureId,
      binding.signal.signal
    )
    await this.dependencies.viewers.describe(viewerId, { caller })
    this.assertCurrent(binding)
    binding.signal.signal.throwIfAborted()
    if (
      !asset ||
      asset.mimeType !== frame.mimeType ||
      asset.body.byteLength !== frame.sizeBytes ||
      createHash('sha256').update(asset.body).digest('hex') !== frame.checksum
    )
      throw new HostError(404, 'not-found')
    const offset = request.offset ?? 0
    if (offset > asset.body.byteLength) throw new HostError(400, 'invalid')
    const end = Math.min(
      asset.body.byteLength,
      offset + (request.length ?? MAX_OBSERVATION_CAPTURE_CHUNK_BYTES)
    )
    return {
      captureId: frame.captureId,
      mimeType: frame.mimeType,
      checksum: frame.checksum,
      sizeBytes: frame.sizeBytes,
      offset,
      dataBase64: Buffer.from(asset.body.subarray(offset, end)).toString('base64'),
      ...(end < asset.body.byteLength ? { nextOffset: end } : {})
    }
  }

  private async readCaptures(
    binding: Binding,
    signal: AbortSignal
  ): Promise<ObservationViewerCapture[]> {
    this.assertCurrent(binding)
    if (binding.descriptor.mode === 'recorded') throw new HostError(403, 'forbidden')
    if (!this.dependencies.listCaptures) return []
    const frames = await this.dependencies.listCaptures(binding.descriptor.target, signal)
    this.assertCurrent(binding)
    signal.throwIfAborted()
    return frames.map((frame) => ({
      ...structuredClone(frame),
      ...(binding.captureEvidence.has(frame.captureId)
        ? { viewerEvidence: structuredClone(binding.captureEvidence.get(frame.captureId)!) }
        : {})
    }))
  }

  private async readCaptureOptions(
    binding: Binding
  ): Promise<{ hostView: boolean; projectExports: string[] }> {
    this.assertCurrent(binding)
    if (
      binding.descriptor.mode === 'recorded' ||
      binding.options.allowCapture !== true ||
      !this.dependencies.captureOptions
    )
      throw new HostError(403, 'forbidden')
    const result = await this.dependencies.captureOptions(
      binding.descriptor.target,
      binding.caller.surface === 'electron' && !!binding.projectOrigin
    )
    this.assertCurrent(binding)
    return result
  }

  private async captureBound(
    binding: Binding,
    value: unknown,
    signal: AbortSignal
  ): Promise<ObservationViewerCapture> {
    this.assertCurrent(binding)
    if (
      binding.descriptor.mode === 'recorded' ||
      binding.options.allowCapture !== true ||
      !this.dependencies.capture
    )
      throw new HostError(403, 'forbidden')
    const request = observationMediaCaptureRequestSchema.parse(value)
    const host =
      binding.caller.surface === 'electron' && binding.projectOrigin
        ? {
            caller: binding.caller,
            viewerOrigin: binding.origin,
            projectOrigin: binding.projectOrigin
          }
        : undefined
    if (request.source === 'host-view' && !host) throw new HostError(403, 'forbidden')
    const { result, created } = await this.dependencies.capture({
      target: binding.descriptor.target,
      request,
      assertAuthorized: () => this.assertCurrent(binding),
      signal,
      ...(host ? { host } : {})
    })
    this.assertCurrent(binding)
    let evidence = binding.captureEvidence.get(result.captureId)
    if (!evidence && created) {
      const current = await this.dependencies.viewers.snapshot(binding.descriptor.viewerId, {
        caller: binding.caller
      })
      this.assertCurrent(binding)
      signal.throwIfAborted()
      // Two observers have distinct cursors. Freeze a real read in this viewer after capture;
      // never infer equality from a timestamp or a recording-local sequence number.
      if (current.run?.status === 'running' && binding.captureEvidence.size < 512) {
        evidence = {
          cursor: current.cursor,
          observedAt: current.observedAt,
          stepId: current.stepId
        }
        binding.captureEvidence.set(result.captureId, structuredClone(evidence))
      }
    }
    return { ...result, ...(evidence ? { viewerEvidence: structuredClone(evidence) } : {}) }
  }

  private async openBoundArchive(
    binding: Binding,
    signal: AbortSignal
  ): Promise<ReplayViewerHttpAccess> {
    this.assertCurrent(binding)
    if (
      binding.caller.surface === 'electron' ||
      binding.descriptor.mode === 'recorded' ||
      !this.dependencies.recordingStatus
    )
      throw new HostError(403, 'forbidden')
    const target = binding.descriptor.target
    const status = runObservationRecordingStatusSchema.parse(
      await this.dependencies.recordingStatus(target)
    )
    if (
      status.state !== 'saved' ||
      !status.archive ||
      (['projectId', 'sessionId', 'operationId', 'executionInvocationId', 'runId'] as const).some(
        (field) => status.target[field] !== target[field]
      ) ||
      status.archive.projectId !== target.projectId ||
      status.archive.sessionId !== target.sessionId
    )
      throw new HostError(409, 'unavailable')
    await this.dependencies.viewers.describe(binding.descriptor.viewerId, {
      caller: binding.caller
    })
    this.assertCurrent(binding)
    signal.throwIfAborted()
    // Only Main's finalized, published receipt selects the next scope. No browser target or
    // execution declaration is accepted. The existing recorded reader verifies the Version.
    const opened = await this.openRecorded(status.archive, binding.caller)
    try {
      await this.dependencies.viewers.describe(binding.descriptor.viewerId, {
        caller: binding.caller
      })
      this.assertCurrent(binding)
      signal.throwIfAborted()
      return opened
    } catch (error) {
      this.closeViewer(opened.viewerId)
      await this.dependencies.viewers
        .revoke(opened.viewerId, { caller: binding.caller })
        .catch(() => undefined)
      throw error
    }
  }

  async open(
    target: RunObservationTarget,
    caller: CallerContext,
    options: ReplayViewerHttpOpenOptions = {}
  ): Promise<ReplayViewerHttpAccess> {
    if (this.closed) throw new HostError(410, 'unavailable')
    if (
      (options.allowCancel && !this.dependencies.cancelRun) ||
      (options.desktopParent !== undefined && options.desktopParent !== 'file:')
    )
      throw new HostError(403, 'forbidden')
    const access = await this.dependencies.viewers.create(target, caller)
    return this.bind(access, caller, options)
  }
  async openRecorded(
    target: RecordedObservationTarget,
    caller: CallerContext,
    options: Pick<ReplayViewerHttpOpenOptions, 'desktopParent'> & {
      format?: RecordedEvidenceFormat
    } = {}
  ): Promise<ReplayViewerHttpAccess> {
    if (this.closed) throw new HostError(410, 'unavailable')
    if (
      Object.keys(options).some((key) => !['desktopParent', 'format'].includes(key)) ||
      (options.format !== undefined &&
        !['run-observation', 'project-recording', 'web-recording'].includes(options.format)) ||
      (options.desktopParent !== undefined && options.desktopParent !== 'file:')
    )
      throw new HostError(403, 'forbidden')
    return this.bind(
      await this.dependencies.viewers.createRecorded(target, caller, options.format),
      caller,
      options
    )
  }
  private async bind(
    access: ObservationViewAccess,
    caller: CallerContext,
    options: ReplayViewerHttpOpenOptions
  ): Promise<ReplayViewerHttpAccess> {
    const server = createServer((request, response) => {
      void this.handle(access.viewerId, request, response)
    })
    const binding: Binding = {
      descriptor: {
        ...(access.mode === 'recorded'
          ? {
              mode: 'recorded' as const,
              target: structuredClone(access.target),
              ...(access.format ? { format: access.format } : {})
            }
          : { target: structuredClone(access.target) }),
        viewerId: access.viewerId,
        expiresAt: access.expiresAt
      },
      caller: Object.freeze({
        ...caller,
        authorities: Object.freeze([...caller.authorities]),
        isAuthorizationCurrent: caller.isAuthorizationCurrent.bind(caller)
      }),
      options: Object.freeze({ ...options }),
      server,
      origin: '',
      cookie: `os_observation_${access.viewerId.replaceAll('-', '')}`,
      closed: false,
      signal: new AbortController(),
      sockets: new Set(),
      active: 0,
      requests: 0,
      captureEvidence: new Map(),
      revalidating: false
    }
    this.bindings.set(access.viewerId, binding)
    server.maxHeadersCount = 64
    server.headersTimeout = 10000
    server.requestTimeout = 15000
    server.on('connection', (socket) => {
      if (binding.closed || binding.sockets.size >= maxConnections * 2) {
        socket.destroy()
        return
      }
      binding.sockets.add(socket)
      socket.once('close', () => binding.sockets.delete(socket))
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        const onClose = (): void => reject(new HostError(410, 'unavailable'))
        server.once('close', onClose)
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('close', onClose)
          server.removeListener('error', reject)
          if (binding.closed || this.closed) {
            server.close()
            reject(new HostError(410, 'unavailable'))
          } else resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new HostError(503, 'failed')
      binding.origin = `http://viewer-${access.viewerId}.localhost:${address.port}`
      await this.dependencies.viewers.describe(access.viewerId, { caller })
      this.assertCurrent(binding)
      if (caller.surface === 'electron' && options.desktopParent === 'file:') {
        if (!this.dependencies.desktopFrames) throw new HostError(503, 'desktop-unavailable')
        binding.desktopFrames = await this.dependencies.desktopFrames.registerViewer({
          origin: binding.origin,
          caller: binding.caller,
          expiresAt: access.expiresAt,
          assertCurrent: () => this.assertCurrent(binding)
        })
      }
      binding.expiry = setTimeout(
        () => this.closeViewer(access.viewerId),
        Math.max(1, access.expiresAt - Date.now())
      )
      binding.expiry.unref()
      // A browser may pause observation polling while keeping a project stream alive. Main
      // still checks the original lease and scope; no renderer heartbeat is authorization.
      binding.revalidation = setInterval(() => {
        try {
          this.assertCurrent(binding)
        } catch {
          this.closeViewer(access.viewerId)
          // Let the capability owner discard its grants/capabilities too. describe performs
          // its own original-caller check, so this cannot renew an expired authorization.
          void this.dependencies.viewers
            .describe(access.viewerId, { caller: binding.caller })
            .catch(() => undefined)
          return
        }
        if (binding.revalidating) return
        binding.revalidating = true
        void this.dependencies.viewers
          .describe(access.viewerId, { caller: binding.caller })
          .catch(() => this.closeViewer(access.viewerId))
          .finally(() => {
            binding.revalidating = false
          })
      }, 500)
      binding.revalidation.unref()
      return await this.access(binding, access)
    } catch (error) {
      this.closeViewer(access.viewerId)
      await this.dependencies.viewers.revoke(access.viewerId, { caller }).catch(() => undefined)
      throw error
    }
  }

  async issueAccess(viewerId: string, caller: CallerContext): Promise<ReplayViewerHttpAccess> {
    const binding = this.bindings.get(viewerId)
    if (!binding) throw new HostError(410, 'unavailable')
    const grant = await this.dependencies.viewers.issueGrant(viewerId, caller)
    this.assertCurrent(binding)
    return this.access(binding, grant)
  }
  /** Called by ObservationViewers.onRevoked as well as application shutdown; no recursive revoke. */
  closeViewer(viewerId: string): void {
    const binding = this.bindings.get(viewerId)
    if (!binding) return
    this.bindings.delete(viewerId)
    binding.closed = true
    binding.desktopFrames?.close()
    binding.signal.abort()
    if (binding.expiry) clearTimeout(binding.expiry)
    if (binding.revalidation) clearInterval(binding.revalidation)
    this.dependencies.projectViews.closeViewer(viewerId)
    binding.server.closeAllConnections()
    for (const socket of binding.sockets) socket.destroy()
    binding.server.close()
  }
  close(): void {
    this.closed = true
    for (const viewerId of this.bindings.keys()) this.closeViewer(viewerId)
  }
  private async access(
    binding: Binding,
    grant: ObservationViewAccess
  ): Promise<ReplayViewerHttpAccess> {
    const url = `${binding.origin}/__open_science_viewer?grant=${grant.grant}`
    await binding.desktopFrames?.issueGrant(url, grant.grantExpiresAt)
    this.assertCurrent(binding)
    return {
      ...structuredClone(binding.descriptor),
      url
    }
  }
  private assertCurrent(binding: Binding): void {
    if (
      this.closed ||
      binding.closed ||
      this.bindings.get(binding.descriptor.viewerId) !== binding ||
      Date.now() >= binding.descriptor.expiresAt
    )
      throw new HostError(410, 'unavailable')
    binding.signal.signal.throwIfAborted()
    if (!binding.caller.isAuthorizationCurrent()) throw new HostError(401, 'unauthorized')
  }
  private async handle(
    viewerId: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const binding = this.bindings.get(viewerId)
    if (!binding) {
      sendError(response, new HostError(410, 'unavailable'))
      return
    }
    let reserved = false
    const requestLifetime = new AbortController()
    const timeout = setTimeout(() => {
      requestLifetime.abort()
      sendError(response, new HostError(503, 'failed'))
    }, 30000)
    timeout.unref()
    response.once('close', () => {
      clearTimeout(timeout)
      requestLifetime.abort()
    })
    const signal = AbortSignal.any([binding.signal.signal, requestLifetime.signal])
    try {
      this.assertCurrent(binding)
      if (request.headers.host !== new URL(binding.origin).host)
        throw new HostError(403, 'forbidden')
      const url = pathFrom(request.url)
      if (++binding.requests > maxRequests || binding.active >= maxConnections)
        throw new HostError(429, 'capacity')
      binding.active++
      reserved = true
      if (url.pathname === '/__open_science_viewer') {
        if (request.method !== 'GET' || [...url.searchParams.keys()].some((key) => key !== 'grant'))
          throw new HostError(400, 'invalid')
        const auth = await this.dependencies.viewers.authenticateGrant(
          url.searchParams.get('grant') ?? ''
        )
        if (auth.viewerId !== viewerId) throw new HostError(403, 'forbidden')
        this.assertCurrent(binding)
        await this.dependencies.viewers.describe(viewerId, { capability: auth.capability })
        this.assertCurrent(binding)
        await binding.desktopFrames?.authenticateGrant(url.searchParams.get('grant') ?? '')
        this.assertCurrent(binding)
        response.writeHead(303, {
          location: '/',
          'set-cookie': `${binding.cookie}=${auth.capability}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/`,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer'
        })
        response.end()
        return
      }
      if (request.headers.origin !== undefined && request.headers.origin !== binding.origin)
        throw new HostError(403, 'forbidden')
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.headers.origin !== binding.origin
      )
        throw new HostError(403, 'forbidden')
      const capability =
        request.headers.cookie
          ?.split(';')
          .map((value) => value.trim())
          .find((value) => value.startsWith(`${binding.cookie}=`))
          ?.slice(binding.cookie.length + 1) ?? ''
      const auth = { capability }
      const descriptor = await this.dependencies.viewers.describe(viewerId, auth)
      this.assertCurrent(binding)
      const read = async (): Promise<unknown> => {
        if (request.method === 'GET' && url.pathname === '/api/context')
          return {
            ...descriptor,
            presentation: binding.caller.surface === 'electron' ? 'desktop' : 'browser',
            ...(binding.caller.surface === 'electron' && this.dependencies.desktopLocale
              ? { locale: this.dependencies.desktopLocale() }
              : {}),
            canInteract:
              descriptor.mode !== 'recorded' && binding.options.allowInteraction === true,
            canCancel:
              descriptor.mode !== 'recorded' &&
              binding.options.allowCancel === true &&
              !!this.dependencies.cancelRun,
            canCapture:
              descriptor.mode !== 'recorded' &&
              binding.options.allowCapture === true &&
              !!this.dependencies.capture,
            canRecord:
              descriptor.mode !== 'recorded' &&
              binding.options.allowRecording === true &&
              !!this.dependencies.browserRecording,
            canReadArtifacts:
              descriptor.mode === 'recorded'
                ? !!this.dependencies.readRecordingMedia
                : !!this.dependencies.readArtifact
          }
        if (descriptor.mode === 'recorded') {
          if (request.method === 'GET' && url.pathname === '/api/recording/moment')
            return this.dependencies.viewers.browserMomentSelection(viewerId, auth)
          if (request.method === 'POST' && url.pathname === '/api/recording/moment') {
            const { offsetMs } = z
              .object({ offsetMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
              .strict()
              .parse(await readBody(request))
            return this.dependencies.viewers.selectBrowserMoment(viewerId, offsetMs, auth)
          }
          if (request.method === 'GET' && url.pathname === '/api/recording')
            return this.dependencies.viewers.recording(viewerId, auth)
          if (request.method === 'GET' && url.pathname === '/api/recording/selection')
            return this.dependencies.viewers.recordingSelection(viewerId, auth)
          if (request.method === 'GET' && url.pathname === '/api/recording/file-selection')
            return this.dependencies.viewers.recordingFileSelection(viewerId, auth)
          if (request.method === 'POST' && url.pathname === '/api/recording/file-selection') {
            const { mediaKey } = z
              .object({ mediaKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) })
              .strict()
              .parse(await readBody(request))
            return this.dependencies.viewers.selectRecordingFile(viewerId, mediaKey, auth)
          }
          if (request.method === 'POST' && url.pathname === '/api/recording/select') {
            const { stepKey } = z
              .object({ stepKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) })
              .strict()
              .parse(await readBody(request))
            return this.dependencies.viewers.selectRecording(viewerId, stepKey, auth)
          }
          throw new HostError(403, 'forbidden')
        }
        if (request.method === 'POST' && url.pathname === '/api/project-recordings/open') {
          emptyBody.parse(await readBody(request))
          const status = browserRecordingStatusSchema.parse(
            await this.browserRecordingBound('status', binding, {}, signal)
          )
          if (
            !status.target ||
            !['finalized', 'partial'].includes(status.state) ||
            status.target.projectId !== descriptor.target.projectId ||
            status.target.sessionId !== descriptor.target.sessionId
          )
            throw new HostError(409, 'unavailable')
          const opened = await this.openRecorded(status.target, binding.caller, {
            format: 'web-recording',
            ...(binding.options.desktopParent
              ? { desktopParent: binding.options.desktopParent }
              : {})
          })
          try {
            this.assertCurrent(binding)
            signal.throwIfAborted()
            return opened
          } catch (error) {
            this.closeViewer(opened.viewerId)
            await this.dependencies.viewers
              .revoke(opened.viewerId, { caller: binding.caller })
              .catch(() => undefined)
            throw error
          }
        }
        if (url.pathname.startsWith('/api/project-recordings/')) {
          const method = browserRecordingMethodSchema.parse(
            url.pathname.slice('/api/project-recordings/'.length)
          )
          if (['inspect', 'status'].includes(method)) {
            if (request.method !== 'GET') throw new HostError(400, 'invalid')
            return this.browserRecordingBound(method, binding, {}, signal)
          }
          if (request.method !== 'POST') throw new HostError(400, 'invalid')
          return this.browserRecordingBound(method, binding, await readBody(request), signal)
        }
        if (request.method === 'GET' && url.pathname === '/api/captures') {
          return this.readCaptures(binding, signal)
        }
        if (request.method === 'POST' && url.pathname === '/api/open-archive') {
          emptyBody.parse(await readBody(request))
          return this.openBoundArchive(binding, signal)
        }
        if (request.method === 'GET' && url.pathname === '/api/capture-options')
          return this.readCaptureOptions(binding)
        if (request.method === 'POST' && url.pathname === '/api/capture')
          return this.captureBound(binding, await readBody(request), signal)
        if (request.method === 'GET' && url.pathname === '/api/recording-status') {
          if (!this.dependencies.recordingStatus) throw new HostError(404, 'not-found')
          return this.dependencies.recordingStatus(descriptor.target)
        }
        if (request.method === 'GET' && url.pathname === '/api/snapshot')
          return this.dependencies.viewers.snapshot(viewerId, auth)
        if (request.method === 'GET' && url.pathname === '/api/history')
          return this.dependencies.viewers.history(viewerId, auth)
        if (request.method === 'GET' && url.pathname === '/api/selection')
          return (await this.dependencies.viewers.selection(viewerId, auth)) ?? null
        if (request.method === 'POST' && url.pathname === '/api/changes') {
          const { cursor } = changeBody.parse(await readBody(request))
          return this.dependencies.viewers.changes(viewerId, cursor, auth)
        }
        if (request.method === 'POST' && url.pathname === '/api/select')
          return this.dependencies.viewers.select(
            viewerId,
            selectionBody.parse(await readBody(request)),
            auth
          )
        if (request.method === 'POST' && url.pathname === '/api/project-view') {
          if (binding.options.allowInteraction !== true) throw new HostError(403, 'forbidden')
          emptyBody.parse(await readBody(request))
          const snapshot = await this.dependencies.viewers.snapshot(viewerId, auth)
          if (!snapshot.run || snapshot.run.status !== 'running')
            throw new HostError(409, 'not-running')
          const access = await this.dependencies.projectViews.open(
            {
              projectId: descriptor.target.projectId,
              sessionId: descriptor.target.sessionId,
              runId: snapshot.run.runId
            },
            viewerId,
            [
              binding.origin,
              ...(binding.options.desktopParent ? [binding.options.desktopParent] : [])
            ],
            'partitioned',
            () => this.assertCurrent(binding)
          )
          try {
            const current = await this.dependencies.viewers.snapshot(viewerId, auth)
            if (
              !current.run ||
              current.run.runId !== access.view.scope.runId ||
              current.run.status !== 'running'
            )
              throw new HostError(409, 'not-running')
            this.assertCurrent(binding)
          } catch (error) {
            this.dependencies.projectViews.closeViewer(viewerId)
            throw error
          }
          binding.projectOrigin = new URL(access.url).origin
          return access
        }
        if (request.method === 'POST' && url.pathname === '/api/cancel') {
          if (binding.options.allowCancel !== true || !this.dependencies.cancelRun)
            throw new HostError(403, 'forbidden')
          z.object({ confirmed: z.literal(true) })
            .strict()
            .parse(await readBody(request))
          const snapshot = await this.dependencies.viewers.snapshot(viewerId, auth)
          if (!snapshot.run || !['running', 'queued'].includes(snapshot.run.status))
            throw new HostError(409, 'not-running')
          await this.dependencies.viewers.describe(viewerId, auth)
          this.assertCurrent(binding)
          await this.dependencies.cancelRun({
            target: descriptor.target,
            runId: snapshot.run.runId,
            caller: binding.caller,
            signal
          })
          return { requested: true }
        }
        throw new HostError(404, 'not-found')
      }
      let asset: Asset | undefined
      let artifactResponse = false
      if (url.pathname === '/api/capture-media' && request.method === 'GET') {
        artifactResponse = true
        if (
          descriptor.mode === 'recorded' ||
          !this.dependencies.readCapture ||
          [...url.searchParams.keys()].some((key) => key !== 'captureId') ||
          url.searchParams.getAll('captureId').length !== 1
        )
          throw new HostError(404, 'not-found')
        const captureId = url.searchParams.get('captureId')!
        if (!/^[a-f0-9]{64}$/.test(captureId)) throw new HostError(400, 'invalid')
        asset = await this.dependencies.readCapture(descriptor.target, captureId, signal)
        if (!asset) throw new HostError(404, 'not-found')
      } else if (
        url.pathname === '/api/recording/media' &&
        ['GET', 'HEAD'].includes(request.method ?? '')
      ) {
        artifactResponse = true
        if (descriptor.mode !== 'recorded' || !this.dependencies.readRecordingMedia)
          throw new HostError(404, 'not-found')
        if (
          [...url.searchParams.keys()].some((key) => key !== 'mediaKey') ||
          url.searchParams.getAll('mediaKey').length !== 1
        )
          throw new HostError(400, 'invalid')
        const mediaKey = url.searchParams.get('mediaKey')!
        const payload = await this.dependencies.viewers.recording(viewerId, auth)
        if (!payload.media.some((media) => media.mediaKey === mediaKey))
          throw new HostError(404, 'not-found')
        asset = await this.dependencies.readRecordingMedia(
          descriptor.target,
          mediaKey,
          signal,
          descriptor.format
        )
        if (!asset) throw new HostError(404, 'not-found')
        if (descriptor.format === 'web-recording') {
          if (!('indexChecksum' in payload)) throw new HostError(404, 'not-found')
          const media = payload.recording.media.find((item) => item.mediaKey === mediaKey)
          if (
            !media ||
            asset.mimeType !== 'video/webm' ||
            asset.body.byteLength !== media.sizeBytes ||
            asset.body.byteLength > maxResponse ||
            createHash('sha256').update(asset.body).digest('hex') !== media.checksum
          )
            throw new HostError(404, 'not-found')
          await this.dependencies.viewers.describe(viewerId, auth)
          this.assertCurrent(binding)
          signal.throwIfAborted()
          const size = asset.body.byteLength
          let start = 0,
            end = size - 1
          const rawRange = request.headers.range
          if (rawRange !== undefined) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange)
            let invalid = !match || (!match[1] && !match[2])
            if (match && !invalid) {
              if (!match[1]) {
                const suffix = Number(match[2])
                invalid = !Number.isSafeInteger(suffix) || suffix <= 0
                start = Math.max(0, size - suffix)
              } else {
                start = Number(match[1])
                end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
                invalid =
                  !Number.isSafeInteger(start) ||
                  !Number.isSafeInteger(end) ||
                  start > end ||
                  start >= size
              }
            }
            if (invalid) {
              response.writeHead(416, {
                'content-range': `bytes */${size}`,
                'accept-ranges': 'bytes',
                'content-length': '0',
                'cache-control': 'no-store'
              })
              response.end()
              return
            }
          }
          response.writeHead(rawRange === undefined ? 200 : 206, {
            'content-type': 'video/webm',
            'content-length': String(end - start + 1),
            'accept-ranges': 'bytes',
            ...(rawRange === undefined ? {} : { 'content-range': `bytes ${start}-${end}/${size}` }),
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "sandbox; default-src 'none'"
          })
          if (request.method !== 'HEAD') {
            // Each independently playable segment remains bounded. Honor backpressure and
            // revocation while delivering ranges, without materializing the whole recording.
            for (let offset = start; offset <= end; offset += 64 * 1024) {
              signal.throwIfAborted()
              this.assertCurrent(binding)
              if (
                !response.write(asset.body.subarray(offset, Math.min(end + 1, offset + 64 * 1024)))
              ) {
                await new Promise<void>((resolve, reject) => {
                  const cleanup = (): void => {
                    response.off('drain', drained)
                    signal.removeEventListener('abort', aborted)
                  }
                  const drained = (): void => {
                    cleanup()
                    resolve()
                  }
                  const aborted = (): void => {
                    cleanup()
                    reject(new HostError(410, 'unavailable'))
                  }
                  response.once('drain', drained)
                  signal.addEventListener('abort', aborted, { once: true })
                  if (signal.aborted) aborted()
                })
              }
            }
          }
          response.end()
          return
        }
      } else if (url.pathname === '/api/artifact' && request.method === 'GET') {
        if (descriptor.mode === 'recorded') throw new HostError(403, 'forbidden')
        artifactResponse = true
        if (!this.dependencies.readArtifact) throw new HostError(404, 'not-found')
        if ([...url.searchParams.keys()].some((key) => key !== 'versionId'))
          throw new HostError(400, 'invalid')
        const versionId = url.searchParams.get('versionId')
        const snapshot = await this.dependencies.viewers.snapshot(viewerId, auth)
        const artifact = snapshot.artifacts.find((value) => value.versionId === versionId)
        if (!artifact || !snapshot.run) throw new HostError(404, 'not-found')
        asset = await this.dependencies.readArtifact({
          target: descriptor.target,
          runId: snapshot.run.runId,
          artifact,
          signal
        })
        if (!asset) throw new HostError(404, 'not-found')
      } else if (url.pathname.startsWith('/api/')) {
        if (url.search) throw new HostError(400, 'invalid')
        const result = await read()
        asset = {
          body: Buffer.from(JSON.stringify(result)),
          mimeType: 'application/json; charset=utf-8'
        }
      } else {
        if (!['GET', 'HEAD'].includes(request.method ?? '') || url.search)
          throw new HostError(404, 'not-found')
        const path = assetPath(url.pathname)
        if (!path) throw new HostError(404, 'not-found')
        asset = await this.dependencies.readAsset(path)
        if (!asset) throw new HostError(404, 'not-found')
      }
      if (asset.body.byteLength > maxResponse || /[\r\n]/.test(asset.mimeType))
        throw new HostError(413, 'oversized')
      await this.dependencies.viewers.describe(viewerId, auth)
      this.assertCurrent(binding)
      signal.throwIfAborted()
      response.writeHead(200, {
        'content-type': asset.mimeType,
        'content-length': String(asset.body.byteLength),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        ...(artifactResponse ? { 'content-disposition': 'attachment; filename="artifact"' } : {}),
        'content-security-policy': artifactResponse
          ? "sandbox; default-src 'none'"
          : `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; connect-src 'self'; frame-src http://*.localhost:*; frame-ancestors ${binding.options.desktopParent ?? "'none'"}; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'`,
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
      })
      response.end(request.method === 'HEAD' ? undefined : asset.body)
    } catch (error) {
      sendError(response, error)
    } finally {
      clearTimeout(timeout)
      if (reserved) binding.active--
    }
  }
}
