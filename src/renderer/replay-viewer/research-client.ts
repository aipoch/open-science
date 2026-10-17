import { z } from 'zod'
import type { ReplayDocument, ReplayNotebookRunDetails, ReplayResource } from '../../shared/replay'
import {
  researchReplayPositionSchema,
  type ResearchReplayDocument,
  type ResearchReplayPosition,
  type ResearchReplayRecording,
  type ResearchReplaySelection,
  type ResearchReplayTarget
} from '../../shared/research-replay'
import {
  recordedEvidencePayloadSchema,
  recordedObservationTargetSchema,
  type RecordedEvidencePayload
} from '../../shared/run-observation-recorded'
import { ReplayViewerClient, ReplayViewerRequestError } from './client'
import { researchReplayObservationBindingSchema } from '../../shared/research-replay-observations'
import {
  equalRecordedEvidence,
  verifyRecordedObservationSelection
} from '../../shared/recorded-observation-selection'
import type { ReplayPreparedResource } from '../src/pages/workspace/replay/replay-resources'

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
const list = (value: unknown, max = 20000): value is unknown[] =>
  Array.isArray(value) && value.length <= max
const step = (value: unknown): boolean =>
  object(value) &&
  id(value.id) &&
  id(value.branchId) &&
  ['message', 'activity', 'notebook', 'artifact', 'review'].includes(String(value.kind)) &&
  list(value.activities) &&
  list(value.runs) &&
  list(value.evidence) &&
  list(value.resourceIds) &&
  list(value.issues) &&
  finite(value.startMs) &&
  finite(value.endMs) &&
  finite(value.durationMs)
const source = (value: unknown): boolean =>
  object(value) &&
  id(value.projectId) &&
  id(value.sessionId) &&
  typeof value.title === 'string' &&
  id(value.fingerprint)
const resource = (value: unknown): boolean =>
  object(value) &&
  id(value.id) &&
  id(value.projectId) &&
  id(value.sessionId) &&
  typeof value.name === 'string' &&
  ['recorded', 'unavailable'].includes(String(value.availability))
const documentSchema = z.custom<ReplayDocument>(
  (value) =>
    object(value) &&
    source(value.source) &&
    finite(value.generatorVersion) &&
    finite(value.presentationVersion) &&
    id(value.defaultBranchId) &&
    list(value.resources) &&
    value.resources.every(resource) &&
    list(value.issues) &&
    list(value.branches, 512) &&
    value.branches.every(
      (branch) =>
        object(branch) &&
        id(branch.id) &&
        finite(branch.durationMs) &&
        list(branch.steps) &&
        branch.steps.every(step)
    )
)
const recordingSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(['web-recording', 'project-recording', 'run-observation']),
    target: recordedObservationTargetSchema,
    name: z.string().max(4096)
  })
  .strict()
const recordedRangeSchema = z
  .object({
    startedAt: z.number().finite().nonnegative(),
    endedAt: z.number().finite().nonnegative()
  })
  .strict()
  .refine((range) => range.endedAt >= range.startedAt)
const timingSchema = z
  .object({
    recordedTimeOrigins: z.record(z.string().min(1).max(512), z.number().finite().nonnegative()),
    coverage: z.record(
      z.string().min(1).max(512),
      z
        .array(
          z
            .object({
              recordingId: z.string().min(1).max(256),
              target: recordedObservationTargetSchema,
              startedAt: z.number().finite().nonnegative(),
              endedAt: z.number().finite().nonnegative(),
              ranges: z.array(recordedRangeSchema).max(20000)
            })
            .strict()
        )
        .max(64)
    ),
    timelineCoverage: z.record(z.string().min(1).max(512), z.array(recordedRangeSchema).max(20000)),
    unalignedBranchIds: z.array(z.string().min(1).max(512)).max(512)
  })
  .strict()
const researchDocumentSchema: z.ZodType<ResearchReplayDocument> = z
  .object({
    document: documentSchema,
    timing: timingSchema,
    recordings: z.array(recordingSchema).max(64),
    recordingsTruncated: z.boolean(),
    unavailableRecordingIds: z.array(z.string().max(512)).max(512),
    observationBindings: z.array(researchReplayObservationBindingSchema).max(64).optional(),
    supportingResourceIds: z.array(z.string().max(512)).max(20000).optional()
  })
  .strict()
const selectionSchema = z.custom<ResearchReplaySelection>(
  (value) =>
    object(value) &&
    id(value.selectionId) &&
    id(value.viewerId) &&
    finite(value.selectedAt) &&
    source(value.source) &&
    researchReplayPositionSchema.safeParse(value.position).success &&
    step(value.step) &&
    typeof value.excerpt === 'string' &&
    value.excerpt.length <= 65536 &&
    list(value.evidence) &&
    typeof value.truncated === 'boolean' &&
    ['input', 'activity', 'result'].includes(String(value.phase))
)
const notebookSchema = z.custom<ReplayNotebookRunDetails>(
  (value) =>
    object(value) &&
    (value.status === 'unavailable' ||
      (value.status === 'ready' && object(value.run) && id(value.run.runId) && finite(value.bytes)))
)

/** Research-scoped, passive reads only. Viewer grants choose the source; callers never supply paths. */
export class ResearchReplayClient extends ReplayViewerClient {
  private research?: ResearchReplayDocument
  private readonly recordingPayloads = new Map<string, RecordedEvidencePayload>()
  private readonly connectionListeners = new Set<(error: ReplayViewerRequestError) => void>()

  /** Observe scoped transport failures without changing or extending the viewer's authority. */
  onConnectionFailure(listener: (error: ReplayViewerRequestError) => void): () => void {
    this.connectionListeners.add(listener)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  protected override async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      return await super.request(path, body, signal)
    } catch (error) {
      if (
        !signal?.aborted &&
        error instanceof ReplayViewerRequestError &&
        (error.kind === 'authorization' || error.kind === 'network' || (error.status ?? 0) >= 500)
      ) {
        for (const listener of this.connectionListeners) listener(error)
      }
      throw error
    }
  }

  async document(
    target: ResearchReplayTarget,
    signal?: AbortSignal
  ): Promise<ResearchReplayDocument> {
    const result = await this.json('/api/research/document', researchDocumentSchema, {}, signal)
    if (
      result.document.source.projectId !== target.projectId ||
      result.document.source.sessionId !== target.sessionId ||
      result.recordings.some(
        (recording) =>
          recording.target.projectId !== target.projectId ||
          recording.target.sessionId !== target.sessionId
      )
    )
      throw new ReplayViewerRequestError('invalid-response')
    this.research = structuredClone(result)
    this.recordingPayloads.clear()
    return result
  }
  async notebook(runId: string, signal?: AbortSignal): Promise<ReplayNotebookRunDetails> {
    const value = await this.json(
      '/api/research/read',
      z.object({ runs: z.record(z.string(), notebookSchema) }).strict(),
      { kind: 'notebook', runIds: [runId] },
      signal
    )
    const result = value.runs[runId]
    if (!result || (result.status === 'ready' && result.run.runId !== runId))
      throw new ReplayViewerRequestError('invalid-response')
    return result
  }
  async researchRecording(
    recording: ResearchReplayRecording,
    signal?: AbortSignal
  ): Promise<RecordedEvidencePayload> {
    const result = await this.json(
      '/api/research/read',
      recordedEvidencePayloadSchema,
      { kind: 'recording', recordingId: recording.id },
      signal
    )
    if (
      (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).some(
        (key) => result.receiving[key] !== recording.target[key]
      ) ||
      (recording.kind === 'web-recording') !== 'indexChecksum' in result ||
      (recording.kind === 'run-observation') !== 'archive' in result
    )
      throw new ReplayViewerRequestError('invalid-response')
    this.recordingPayloads.set(recording.id, structuredClone(result))
    return result
  }
  private verifySelection(value: ResearchReplaySelection, document: ReplayDocument): void {
    if (
      value.source.projectId !== document.source.projectId ||
      value.source.sessionId !== document.source.sessionId ||
      value.source.fingerprint !== document.source.fingerprint ||
      value.step.id !== value.position.stepId ||
      value.step.branchId !== value.position.branchId ||
      !document.branches.some(
        (branch) =>
          branch.id === value.position.branchId &&
          branch.steps.some((step) => step.id === value.position.stepId)
      )
    )
      throw new ReplayViewerRequestError('invalid-response')
  }
  private async verifyObservation(
    value: ResearchReplaySelection,
    document: ReplayDocument,
    signal?: AbortSignal
  ): Promise<void> {
    const selector = value.position.observation
    if (!selector && !value.observation && value.inspection !== 'recorded-observation') return
    const research = this.research
    const descriptor = research?.recordings.find((item) => item.id === selector?.recordingId)
    const origin = research?.timing.recordedTimeOrigins[value.position.branchId]
    if (
      !selector ||
      !value.observation ||
      value.inspection !== 'recorded-observation' ||
      !research ||
      research.document.source.fingerprint !== document.source.fingerprint ||
      !descriptor ||
      descriptor.kind !== 'run-observation' ||
      origin === undefined
    )
      throw new ReplayViewerRequestError('invalid-response')
    const payload =
      this.recordingPayloads.get(descriptor.id) ??
      (await this.researchRecording(descriptor, signal))
    if (!('archive' in payload)) throw new ReplayViewerRequestError('invalid-response')
    try {
      const observation = verifyRecordedObservationSelection(
        value.observation,
        payload,
        selector.stepKey
      )
      const binding = research.observationBindings?.find(
        (item) =>
          equalRecordedEvidence(item.target, descriptor.target) &&
          item.recordingId === payload.archive.recordingId &&
          item.branchIds.includes(value.position.branchId)
      )
      const step = document.branches
        .find((item) => item.id === value.position.branchId)
        ?.steps.find((item) => item.id === value.position.stepId)
      if (
        !binding ||
        !step?.runs.some((run) => run.runId === binding.runId) ||
        research.document.resources.find((item) => item.id === descriptor.id)?.checksum !==
          binding.archiveChecksum ||
        observation.selectionId !== value.selectionId ||
        observation.selectedAt !== value.selectedAt ||
        observation.record.observedAt < origin ||
        observation.record.observedAt > origin + value.position.timeMs
      )
        throw new Error('Invalid observation scope.')
    } catch {
      throw new ReplayViewerRequestError('invalid-response')
    }
  }
  async selectResearch(
    document: ReplayDocument,
    position: ResearchReplayPosition,
    signal?: AbortSignal
  ): Promise<ResearchReplaySelection> {
    const requested = researchReplayPositionSchema.parse(position)
    const result = await this.json('/api/research/select', selectionSchema, requested, signal)
    this.verifySelection(result, document)
    // Optional UI hints may be explicitly undefined; JSON transport omits those keys.
    const serializedPosition = Object.fromEntries(
      Object.entries(requested).filter(([, value]) => value !== undefined)
    )
    if (!equalRecordedEvidence(result.position, serializedPosition))
      throw new ReplayViewerRequestError('invalid-response')
    await this.verifyObservation(result, document, signal)
    return result
  }
  async researchSelection(
    document: ReplayDocument,
    signal?: AbortSignal
  ): Promise<ResearchReplaySelection | null> {
    const result = await this.json(
      '/api/research/selection',
      selectionSchema.nullable(),
      {},
      signal
    )
    if (result) {
      this.verifySelection(result, document)
      await this.verifyObservation(result, document, signal)
    }
    return result
  }
  researchMediaUrl(
    recordingId: string,
    payload: RecordedEvidencePayload,
    mediaKey: string
  ): string | null {
    const declared = ('archive' in payload ? payload.archive : payload.recording).media.find(
      (item) => item.mediaKey === mediaKey
    )
    const resolved = payload.media.find((item) => item.mediaKey === mediaKey)
    if (
      !declared ||
      !resolved ||
      declared.checksum !== resolved.checksum ||
      declared.sizeBytes !== resolved.sizeBytes
    )
      return null
    return `/api/research/media?recordingId=${encodeURIComponent(recordingId)}&mediaKey=${encodeURIComponent(mediaKey)}`
  }
  async researchArtifact(
    resource: ReplayResource,
    signal?: AbortSignal
  ): Promise<{ content: string; mimeType: string; truncated: boolean }> {
    if (!resource.versionId || resource.availability !== 'recorded')
      throw new ReplayViewerRequestError('unavailable')
    const response = await this.request(
      `/api/research/resource?resourceId=${encodeURIComponent(resource.id)}`,
      undefined,
      signal
    )
    return this.resourceBytes(response, resource)
  }
  async researchMedia(
    recordingId: string,
    payload: RecordedEvidencePayload,
    resource: ReplayResource,
    signal?: AbortSignal
  ): Promise<{ content: string; mimeType: string; truncated: boolean }> {
    const media = payload.media.find(
      (item) =>
        item.artifactId === resource.artifactId &&
        item.versionId === resource.versionId &&
        item.checksum === resource.checksum
    )
    const url = media && this.researchMediaUrl(recordingId, payload, media.mediaKey)
    if (
      !url ||
      resource.projectId !== payload.receiving.projectId ||
      resource.sessionId !== payload.receiving.sessionId
    )
      throw new ReplayViewerRequestError('unavailable')
    return this.resourceBytes(await this.request(url, undefined, signal), resource)
  }
  prepareResearchResource(
    resource: ReplayResource,
    read: () => Promise<{ content: string; mimeType: string; truncated: boolean }>
  ): Promise<ReplayPreparedResource> {
    return this.prepareResource(resource, read)
  }
}
