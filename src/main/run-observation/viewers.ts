import { captureRecordedObservationSelection } from '../../shared/recorded-observation-selection'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CallerContext } from '../caller-context'
import {
  runObservationCursorSchema,
  runObservationTargetSchema,
  type RunObservationCursor,
  type RunObservationTarget
} from '../../shared/run-observation'
import type { RunObservationOwner, RunObservationViewer } from './owner'
import {
  recordedBrowserPayloadSchema,
  browserRecordingMomentSchema,
  type RecordedBrowserPayload,
  type BrowserRecordingMoment
} from '../../shared/browser-recording'
import {
  recordedObservationTargetSchema,
  recordedObservationPayloadSchema,
  recordedProjectPayloadSchema,
  recordedEvidenceFormatSchema,
  type RecordedEvidenceFormat,
  type RecordedEvidencePayload,
  type RecordedProjectPayload,
  recordedFileSelectionSchema,
  recordedFileSelectionForPayload,
  type RecordedObservationFileSelection,
  type RecordedObservationTarget,
  type RecordedObservationPayload,
  type RecordedRunObservationSelection
} from '../../shared/run-observation-recorded'

export type ObservationViewAuthorization =
  | Readonly<{ caller: CallerContext; capability?: never }>
  | Readonly<{ capability: string; caller?: never }>
export type LiveObservationViewDescriptor = Readonly<{
  viewerId: string
  mode?: 'live'
  target: RunObservationTarget
  expiresAt: number
}>
export type RecordedObservationViewDescriptor = Readonly<{
  viewerId: string
  mode: 'recorded'
  format?: RecordedEvidenceFormat
  target: RecordedObservationTarget
  expiresAt: number
}>
export type ObservationViewDescriptor =
  LiveObservationViewDescriptor | RecordedObservationViewDescriptor
export type ObservationViewAccess = ObservationViewDescriptor &
  Readonly<{
    /** Single-use bootstrap credential. Never persist, log or include it in an Artifact. */
    grant: string
    grantExpiresAt: number
  }>
export type ObservationBrowserAccess = ObservationViewDescriptor &
  Readonly<{
    /** Read/selection capability for this viewer only; the HTTP adapter must protect its cookie. */
    capability: string
  }>
type RevokeReason =
  'revoked' | 'expired' | 'authorization-revoked' | 'scope-unavailable' | 'shutdown'
type Observer = Pick<
  RunObservationOwner,
  'snapshot' | 'history' | 'changes' | 'select' | 'selection'
>
export type ObservationViewersDependencies = Readonly<{
  observer: Observer
  authorizeScope(target: RunObservationTarget): Promise<void>
  recorded?: Readonly<{
    authorizeScope(target: RecordedObservationTarget): Promise<void>
    read(target: RecordedObservationTarget): Promise<RecordedObservationPayload>
    readProject?(target: RecordedObservationTarget): Promise<RecordedProjectPayload>
    readBrowser?(target: RecordedObservationTarget): Promise<RecordedBrowserPayload>
    selectBrowserMoment?(
      target: RecordedObservationTarget,
      offsetMs: number
    ): Promise<BrowserRecordingMoment>
    selectFile?(
      target: RecordedObservationTarget,
      mediaKey: string,
      format?: RecordedEvidenceFormat
    ): Promise<RecordedObservationFileSelection>
  }>
  onRevoked?(viewerId: string, reason: RevokeReason): void | Promise<void>
  onCleanupError?(error: unknown): void
  now?: () => number
  limits?: Readonly<{ viewers?: number; lifetimeMs?: number; grantLifetimeMs?: number }>
}>
export class ObservationViewerError extends Error {
  readonly name = 'ObservationViewerError'
  constructor(
    readonly code: 'unauthorized' | 'unsupported-location' | 'unavailable' | 'capacity' | 'closed',
    message: string
  ) {
    super(message)
  }
}
type ViewerRecord = {
  descriptor: ObservationViewDescriptor
  caller: CallerContext
  selection?: RecordedRunObservationSelection
  fileSelection?: RecordedObservationFileSelection
  momentSelection?: BrowserRecordingMoment
  grants: Set<string>
  capabilities: Set<string>
  expiry: ReturnType<typeof setTimeout>
}
type GrantRecord = { viewerId: string; expiresAt: number }
const secretPattern = /^[a-f0-9]{64}$/
const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex')
const bounded = (value: number | undefined, fallback: number, maximum: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(maximum, value)
    : fallback
const sameTarget = (left: RunObservationTarget, right: RunObservationTarget): boolean =>
  (['projectId', 'sessionId', 'operationId', 'executionInvocationId', 'runId'] as const).every(
    (key) => left[key] === right[key]
  )
const sameCaller = (left: CallerContext, right: CallerContext): boolean =>
  (
    [
      'clientId',
      'leaseId',
      'lifecycleClientId',
      'surface',
      'location',
      'principalKind',
      'actionOrigin'
    ] as const
  ).every((key) => left[key] === right[key])
function assertLocalCaller(caller: CallerContext | undefined): asserts caller is CallerContext {
  let current = false
  try {
    current = !!caller?.isAuthorizationCurrent()
  } catch {
    /* A failing lease is not authority. */
  }
  if (!current)
    throw new ObservationViewerError('unauthorized', 'Current caller authorization is required.')
  if (caller?.location !== 'local')
    throw new ObservationViewerError(
      'unsupported-location',
      'Observation viewers are local to this device.'
    )
}
function pinCaller(caller: CallerContext): CallerContext {
  const isCurrent = caller.isAuthorizationCurrent.bind(caller)
  return Object.freeze({
    ...caller,
    authorities: Object.freeze([...caller.authorities]),
    isAuthorizationCurrent: isCurrent
  })
}

/** App-process-only viewer capabilities. No scope can be supplied through a browser credential. */
export class ObservationViewers {
  private readonly viewers = new Map<string, ViewerRecord>()
  private readonly grants = new Map<string, GrantRecord>()
  private readonly capabilities = new Map<string, string>()
  private readonly cleanups = new Map<string, Promise<void>>()
  private readonly failedCleanups = new Map<string, RevokeReason>()
  private readonly limit: number
  private readonly lifetime: number
  private readonly grantLifetime: number
  private pendingCreates = 0
  private closed = false

  constructor(private readonly dependencies: ObservationViewersDependencies) {
    this.limit = bounded(dependencies.limits?.viewers, 64, 128)
    this.lifetime = bounded(dependencies.limits?.lifetimeMs, 60 * 60 * 1000, 4 * 60 * 60 * 1000)
    this.grantLifetime = bounded(dependencies.limits?.grantLifetimeMs, 60 * 1000, 2 * 60 * 1000)
  }
  private now(): number {
    return (this.dependencies.now ?? Date.now)()
  }
  private assertOpen(): void {
    if (this.closed) throw new ObservationViewerError('closed', 'Observation viewers are closed.')
  }
  private descriptor(record: ViewerRecord): ObservationViewDescriptor {
    return structuredClone(record.descriptor)
  }
  private requireRecord(viewerId: string): ViewerRecord {
    this.assertOpen()
    const record = this.viewers.get(viewerId)
    if (!record)
      throw new ObservationViewerError('unavailable', 'The observation viewer is unavailable.')
    return record
  }
  private expireInBackground(viewerId: string, reason: RevokeReason): void {
    void this.remove(viewerId, reason).catch((error: unknown) => {
      try {
        this.dependencies.onCleanupError?.(error)
      } catch {
        /* Cleanup remains retryable at close. */
      }
    })
  }
  private remove(viewerId: string, reason: RevokeReason): Promise<void> {
    const record = this.viewers.get(viewerId)
    if (record) {
      this.viewers.delete(viewerId)
      clearTimeout(record.expiry)
      for (const digest of record.grants) this.grants.delete(digest)
      for (const digest of record.capabilities) this.capabilities.delete(digest)
    }
    const current = this.cleanups.get(viewerId)
    if (current) return current
    if (!record && !this.failedCleanups.has(viewerId)) return Promise.resolve()
    const cleanup = Promise.resolve()
      .then(() => this.dependencies.onRevoked?.(viewerId, reason))
      .then(() => {
        this.failedCleanups.delete(viewerId)
      })
      .catch((error: unknown) => {
        this.failedCleanups.set(viewerId, reason)
        throw error
      })
      .finally(() => {
        this.cleanups.delete(viewerId)
      })
    this.cleanups.set(viewerId, cleanup)
    return cleanup
  }
  private async assertRecord(record: ViewerRecord): Promise<void> {
    this.assertOpen()
    const { viewerId } = record.descriptor
    if (this.viewers.get(viewerId) !== record)
      throw new ObservationViewerError('unavailable', 'The observation viewer is unavailable.')
    if (this.now() >= record.descriptor.expiresAt) {
      this.expireInBackground(viewerId, 'expired')
      throw new ObservationViewerError('unavailable', 'The observation viewer has expired.')
    }
    try {
      assertLocalCaller(record.caller)
    } catch (error) {
      this.expireInBackground(viewerId, 'authorization-revoked')
      throw error
    }
    try {
      await this.authorizeDescriptor(record.descriptor)
    } catch {
      this.expireInBackground(viewerId, 'scope-unavailable')
      throw new ObservationViewerError('unavailable', 'The observed research is unavailable.')
    }
    this.assertOpen()
    if (this.now() >= record.descriptor.expiresAt) {
      this.expireInBackground(viewerId, 'expired')
      throw new ObservationViewerError('unavailable', 'The observation viewer has expired.')
    }
    if (this.viewers.get(viewerId) !== record)
      throw new ObservationViewerError('unavailable', 'The observation viewer is unavailable.')
    try {
      assertLocalCaller(record.caller)
    } catch (error) {
      this.expireInBackground(viewerId, 'authorization-revoked')
      throw error
    }
  }
  private assertAccess(record: ViewerRecord, auth: ObservationViewAuthorization): void {
    if (!auth || ('caller' in auth && 'capability' in auth))
      throw new ObservationViewerError(
        'unauthorized',
        'A single observation authorization is required.'
      )
    if ('caller' in auth) {
      assertLocalCaller(auth.caller)
      if (!sameCaller(record.caller, auth.caller))
        throw new ObservationViewerError('unauthorized', 'This viewer belongs to another caller.')
    } else {
      const credential = auth.capability
      if (
        !secretPattern.test(credential) ||
        this.capabilities.get(hash(credential)) !== record.descriptor.viewerId
      )
        throw new ObservationViewerError(
          'unauthorized',
          'The observation capability is unavailable.'
        )
    }
  }
  private async withViewer<T>(
    viewerId: string,
    auth: ObservationViewAuthorization,
    action: (record: ViewerRecord) => Promise<T>
  ): Promise<T> {
    const record = this.requireRecord(viewerId)
    this.assertAccess(record, auth)
    const pinned: ObservationViewAuthorization =
      'caller' in auth ? { caller: pinCaller(auth.caller!) } : { capability: auth.capability }
    await this.assertRecord(record)
    this.assertAccess(record, pinned)
    const value = await action(record)
    await this.assertRecord(record)
    this.assertAccess(record, pinned)
    return value
  }

  private async authorizeDescriptor(
    descriptor:
      | Pick<LiveObservationViewDescriptor, 'target' | 'mode'>
      | Pick<RecordedObservationViewDescriptor, 'target' | 'mode' | 'format'>
  ): Promise<void> {
    if (descriptor.mode === 'recorded') {
      if (!this.dependencies.recorded)
        throw new ObservationViewerError('unavailable', 'Recorded observations are unavailable.')
      await this.dependencies.recorded.authorizeScope(structuredClone(descriptor.target))
    } else await this.dependencies.authorizeScope(structuredClone(descriptor.target))
  }
  private liveTarget(record: ViewerRecord): RunObservationTarget {
    if (record.descriptor.mode === 'recorded')
      throw new ObservationViewerError('unavailable', 'A recording does not authorize a live Run.')
    return record.descriptor.target
  }
  private async readRecording(record: ViewerRecord): Promise<RecordedEvidencePayload> {
    if (record.descriptor.mode !== 'recorded' || !this.dependencies.recorded)
      throw new ObservationViewerError('unavailable', 'This viewer does not reference a recording.')
    if (record.descriptor.format === 'web-recording') {
      if (!this.dependencies.recorded.readBrowser)
        throw new ObservationViewerError('unavailable', 'Browser recordings are unavailable.')
      const payload = recordedBrowserPayloadSchema.parse(
        await this.dependencies.recorded.readBrowser(structuredClone(record.descriptor.target))
      )
      if (
        Object.entries(record.descriptor.target).some(
          ([key, value]) => payload.receiving[key as keyof RecordedObservationTarget] !== value
        )
      )
        throw new ObservationViewerError('unavailable', 'The recording identity changed.')
      return payload
    }
    const project = record.descriptor.format === 'project-recording'
    if (project && !this.dependencies.recorded.readProject)
      throw new ObservationViewerError('unavailable', 'Project recordings are unavailable.')
    const payload = project
      ? recordedProjectPayloadSchema.parse(
          await this.dependencies.recorded.readProject!(structuredClone(record.descriptor.target))
        )
      : recordedObservationPayloadSchema.parse(
          await this.dependencies.recorded.read(structuredClone(record.descriptor.target))
        )
    if (
      Object.entries(record.descriptor.target).some(
        ([key, value]) => payload.receiving[key as keyof RecordedObservationTarget] !== value
      )
    )
      throw new ObservationViewerError('unavailable', 'The recording identity changed.')
    return payload
  }
  async createRecorded(
    targetInput: RecordedObservationTarget,
    callerInput: CallerContext,
    format?: RecordedEvidenceFormat
  ): Promise<ObservationViewAccess> {
    const target = recordedObservationTargetSchema.parse(targetInput)
    return this.createBound(
      {
        mode: 'recorded',
        target,
        ...(format === undefined ? {} : { format: recordedEvidenceFormatSchema.parse(format) })
      },
      callerInput
    )
  }
  async create(
    targetInput: RunObservationTarget,
    callerInput: CallerContext
  ): Promise<ObservationViewAccess> {
    return this.createBound({ target: runObservationTargetSchema.parse(targetInput) }, callerInput)
  }
  private async createBound(
    descriptor:
      | Pick<LiveObservationViewDescriptor, 'target' | 'mode'>
      | Pick<RecordedObservationViewDescriptor, 'target' | 'mode' | 'format'>,
    callerInput: CallerContext
  ): Promise<ObservationViewAccess> {
    this.assertOpen()
    assertLocalCaller(callerInput)
    const caller = pinCaller(callerInput)
    if (
      this.viewers.size + this.pendingCreates + this.cleanups.size + this.failedCleanups.size >=
      this.limit
    )
      throw new ObservationViewerError('capacity', 'Too many observation viewers are open.')
    this.pendingCreates++
    try {
      await this.authorizeDescriptor(descriptor)
      this.assertOpen()
      assertLocalCaller(caller)
      const viewerId = randomUUID()
      const expiresAt = this.now() + this.lifetime
      const expiry = setTimeout(() => this.expireInBackground(viewerId, 'expired'), this.lifetime)
      expiry.unref?.()
      const record: ViewerRecord = {
        descriptor: { ...descriptor, viewerId, expiresAt },
        caller,
        expiry,
        grants: new Set(),
        capabilities: new Set()
      }
      try {
        if (descriptor.mode === 'recorded') await this.readRecording(record)
        this.assertOpen()
        assertLocalCaller(caller)
      } catch (error) {
        clearTimeout(expiry)
        throw error
      }
      this.viewers.set(viewerId, record)
      return this.newGrant(record)
    } finally {
      this.pendingCreates--
    }
  }
  private newGrant(record: ViewerRecord): ObservationViewAccess {
    // There is only one unredeemed bootstrap per viewer. Reissuing explicitly retires the old one.
    for (const previous of record.grants) this.grants.delete(previous)
    record.grants.clear()
    const grant = randomBytes(32).toString('hex')
    const grantExpiresAt = Math.min(this.now() + this.grantLifetime, record.descriptor.expiresAt)
    const digest = hash(grant)
    record.grants.add(digest)
    this.grants.set(digest, { viewerId: record.descriptor.viewerId, expiresAt: grantExpiresAt })
    return { ...this.descriptor(record), grant, grantExpiresAt }
  }
  async issueGrant(viewerId: string, caller: CallerContext): Promise<ObservationViewAccess> {
    return this.withViewer(viewerId, { caller }, async (record) => this.newGrant(record))
  }
  async authenticateGrant(grant: string): Promise<ObservationBrowserAccess> {
    this.assertOpen()
    if (!secretPattern.test(grant))
      throw new ObservationViewerError('unauthorized', 'The observation grant is unavailable.')
    const digest = hash(grant)
    const pending = this.grants.get(digest)
    this.grants.delete(digest)
    if (!pending)
      throw new ObservationViewerError('unauthorized', 'The observation grant is unavailable.')
    const record = this.requireRecord(pending.viewerId)
    record.grants.delete(digest)
    if (this.now() >= pending.expiresAt)
      throw new ObservationViewerError('unauthorized', 'The observation grant has expired.')
    await this.assertRecord(record)
    if (this.now() >= pending.expiresAt)
      throw new ObservationViewerError('unauthorized', 'The observation grant has expired.')
    const capability = randomBytes(32).toString('hex')
    const capabilityDigest = hash(capability)
    if (record.capabilities.size >= 4) {
      const oldest = record.capabilities.values().next().value!
      record.capabilities.delete(oldest)
      this.capabilities.delete(oldest)
    }
    record.capabilities.add(capabilityDigest)
    this.capabilities.set(capabilityDigest, record.descriptor.viewerId)
    return { ...this.descriptor(record), capability }
  }
  /** Inject into RunObservationOwner.authorize; it checks only this viewer's originally bound target. */
  async assertViewer(
    targetInput: RunObservationTarget,
    viewer: RunObservationViewer
  ): Promise<void> {
    const target = runObservationTargetSchema.parse(targetInput)
    const record = this.requireRecord(viewer.viewerId)
    if (!sameTarget(target, this.liveTarget(record)))
      throw new ObservationViewerError(
        'unauthorized',
        'The viewer does not authorize this execution.'
      )
    await this.assertRecord(record)
  }
  async snapshot(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): ReturnType<Observer['snapshot']> {
    return this.withViewer(viewerId, auth, (record) =>
      this.dependencies.observer.snapshot(this.liveTarget(record), { viewerId })
    )
  }
  async describe(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): Promise<ObservationViewDescriptor> {
    return this.withViewer(viewerId, auth, async (record) => this.descriptor(record))
  }
  async history(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): ReturnType<Observer['history']> {
    return this.withViewer(viewerId, auth, (record) =>
      this.dependencies.observer.history(this.liveTarget(record), { viewerId })
    )
  }
  async changes(
    viewerId: string,
    cursor: RunObservationCursor,
    auth: ObservationViewAuthorization
  ): ReturnType<Observer['changes']> {
    const parsed = runObservationCursorSchema.parse(cursor)
    return this.withViewer(viewerId, auth, (record) =>
      this.dependencies.observer.changes(
        { ...this.liveTarget(record), cursor: parsed },
        { viewerId }
      )
    )
  }
  async select(
    viewerId: string,
    input: { cursor: RunObservationCursor; stepId: string },
    auth: ObservationViewAuthorization
  ): ReturnType<Observer['select']> {
    const cursor = runObservationCursorSchema.parse(input.cursor)
    const stepId = input.stepId
    return this.withViewer(viewerId, auth, (record) =>
      this.dependencies.observer.select(
        { ...this.liveTarget(record), cursor, stepId },
        { viewerId }
      )
    )
  }
  async selection(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): ReturnType<Observer['selection']> {
    return this.withViewer(viewerId, auth, (record) =>
      this.dependencies.observer.selection(this.liveTarget(record), { viewerId })
    )
  }
  async recording(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): Promise<RecordedEvidencePayload> {
    return this.withViewer(viewerId, auth, (record) => this.readRecording(record))
  }
  async selectRecording(
    viewerId: string,
    stepKey: string,
    auth: ObservationViewAuthorization
  ): Promise<RecordedRunObservationSelection> {
    return this.withViewer(viewerId, auth, async (record) => {
      const payload = await this.readRecording(record)
      if (!('archive' in payload))
        throw new ObservationViewerError(
          'unavailable',
          'A project recording has no Notebook observation step.'
        )
      let selection: RecordedRunObservationSelection
      try {
        selection = captureRecordedObservationSelection(payload, stepKey, {
          selectionId: randomUUID(),
          selectedAt: this.now()
        })
      } catch {
        throw new ObservationViewerError('unavailable', 'The recorded step is unavailable.')
      }
      // Keep an independent server-owned cutoff. Consumer mutations cannot change later readback.
      record.selection = structuredClone(selection)
      return selection
    })
  }
  async recordingSelection(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): Promise<RecordedRunObservationSelection | null> {
    return this.withViewer(viewerId, auth, async (record) => {
      await this.readRecording(record)
      return record.selection ? structuredClone(record.selection) : null
    })
  }
  private async readFileSelection(
    record: ViewerRecord,
    mediaKey: string
  ): Promise<RecordedObservationFileSelection> {
    const payload = await this.readRecording(record)
    if ('indexChecksum' in payload)
      throw new ObservationViewerError('unavailable', 'Select a recorded browser moment instead.')
    if (!this.dependencies.recorded?.selectFile)
      throw new ObservationViewerError('unavailable', 'Recorded file selection is unavailable.')
    const expected = recordedFileSelectionForPayload(payload, mediaKey)
    const format = record.descriptor.mode === 'recorded' ? record.descriptor.format : undefined
    const selected = recordedFileSelectionSchema.parse(
      await (format === undefined
        ? this.dependencies.recorded.selectFile(payload.receiving, mediaKey)
        : this.dependencies.recorded.selectFile(payload.receiving, mediaKey, format))
    )
    const content = { ...selected }
    delete content.selectionId
    delete content.selectedAt
    if (JSON.stringify(content) !== JSON.stringify(expected))
      throw new ObservationViewerError(
        'unavailable',
        'Recorded file selection does not match the archive.'
      )
    return { ...selected, selectionId: randomUUID(), selectedAt: this.now() }
  }
  async selectRecordingFile(
    viewerId: string,
    mediaKey: string,
    auth: ObservationViewAuthorization
  ): Promise<RecordedObservationFileSelection> {
    return this.withViewer(viewerId, auth, async (record) => {
      const selected = await this.readFileSelection(record, mediaKey)
      record.fileSelection = structuredClone(selected)
      return selected
    })
  }
  async recordingFileSelection(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): Promise<RecordedObservationFileSelection | null> {
    return this.withViewer(viewerId, auth, async (record) => {
      await this.readRecording(record)
      if (!record.fileSelection) return null
      const current = await this.readFileSelection(record, record.fileSelection.mediaKey)
      if (JSON.stringify(current.resource) !== JSON.stringify(record.fileSelection.resource))
        throw new ObservationViewerError(
          'unavailable',
          'The selected immutable file is unavailable.'
        )
      return structuredClone(record.fileSelection)
    })
  }
  private async readMoment(
    record: ViewerRecord,
    offsetMs: number
  ): Promise<BrowserRecordingMoment> {
    const payload = await this.readRecording(record)
    if (!('indexChecksum' in payload) || !this.dependencies.recorded?.selectBrowserMoment)
      throw new ObservationViewerError('unavailable', 'Browser recording selection is unavailable.')
    const selected = browserRecordingMomentSchema.parse(
      await this.dependencies.recorded.selectBrowserMoment(payload.receiving, offsetMs)
    )
    const segment = payload.recording.segments.find((item) => item.segmentId === selected.segmentId)
    const media = payload.recording.media.find((item) => item.mediaKey === selected.mediaKey)
    const resolved = payload.media.find((item) => item.mediaKey === selected.mediaKey)
    if (
      !segment ||
      !media ||
      !resolved ||
      selected.offsetMs !== offsetMs ||
      selected.indexChecksum !== payload.indexChecksum ||
      selected.recordingId !== payload.recording.recordingId ||
      JSON.stringify(selected.receiving) !== JSON.stringify(payload.receiving) ||
      offsetMs < segment.startMs ||
      offsetMs >= segment.endMs ||
      selected.segmentOffsetMs !== offsetMs - segment.startMs ||
      segment.mediaKey !== media.mediaKey ||
      selected.resource.artifactId !== resolved.artifactId ||
      selected.resource.versionId !== resolved.versionId ||
      selected.resource.checksum !== media.checksum ||
      selected.resource.sizeBytes !== media.sizeBytes
    )
      throw new ObservationViewerError('unavailable', 'The recorded browser moment changed.')
    return selected
  }
  async selectBrowserMoment(
    viewerId: string,
    offsetMs: number,
    auth: ObservationViewAuthorization
  ): Promise<BrowserRecordingMoment> {
    return this.withViewer(viewerId, auth, async (record) => {
      const selected = await this.readMoment(record, offsetMs)
      record.momentSelection = structuredClone(selected)
      return selected
    })
  }
  async browserMomentSelection(
    viewerId: string,
    auth: ObservationViewAuthorization
  ): Promise<BrowserRecordingMoment | null> {
    return this.withViewer(viewerId, auth, async (record) => {
      await this.readRecording(record)
      if (!record.momentSelection) return null
      const current = await this.readMoment(record, record.momentSelection.offsetMs)
      if (
        current.indexChecksum !== record.momentSelection.indexChecksum ||
        JSON.stringify(current.resource) !== JSON.stringify(record.momentSelection.resource)
      )
        throw new ObservationViewerError(
          'unavailable',
          'The selected browser moment is unavailable.'
        )
      return structuredClone(record.momentSelection)
    })
  }
  async revoke(viewerId: string, auth: ObservationViewAuthorization): Promise<void> {
    const record = this.requireRecord(viewerId)
    this.assertAccess(record, auth)
    const pinned: ObservationViewAuthorization =
      'caller' in auth ? { caller: pinCaller(auth.caller!) } : { capability: auth.capability }
    await this.assertRecord(record)
    this.assertAccess(record, pinned)
    await this.remove(viewerId, 'revoked')
  }
  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.cleanups.values()]
    for (const viewerId of this.viewers.keys()) pending.push(this.remove(viewerId, 'shutdown'))
    for (const [viewerId, reason] of this.failedCleanups)
      pending.push(this.remove(viewerId, reason))
    const outcomes = await Promise.allSettled(pending)
    const errors = outcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason)
    if (errors.length) throw new AggregateError(errors, 'Observation viewer cleanup failed.')
  }
}
