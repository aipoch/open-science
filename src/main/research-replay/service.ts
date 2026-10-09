import type { ResearchReplayObservationBinding } from '../../shared/research-replay-observations'
import type { RecordedObservationPayload } from '../../shared/run-observation-recorded'
import type { ReplayDocument } from '../../shared/replay'
import {
  projectReplayNotebookInspection,
  projectReplayStepInspection
} from '../../renderer/src/lib/replay/inspection'
import { projectReplayScene } from '../../renderer/src/lib/replay/scene'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { captureRecordedObservationSelection } from '../../shared/recorded-observation-selection'
import type { CallerContext } from '../caller-context'
import type { ReplayReaderApi } from '../../renderer/src/lib/replay/source'
import { loadReplayDocument } from '../../renderer/src/lib/replay/source'
import { createResearchReplayTimeline } from '../../renderer/src/lib/replay/recorded-time'
import type { RecordedObservationReader } from '../run-observation/recorded-reader'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { ReplayStep, ReplayResource, ReplayScene } from '../../shared/replay'
import {
  MAX_BROWSER_RECORDING_INDEX_BYTES,
  MAX_BROWSER_RECORDING_SEGMENT_BYTES,
  parseBrowserRecording,
  type BrowserRecording,
  type RecordedBrowserPayload
} from '../../shared/browser-recording'
import {
  researchReplayPositionSchema,
  researchReplayReadSchema,
  researchReplayTargetSchema,
  type ResearchReplayTarget,
  type ResearchReplayDocument,
  type ResearchReplaySelection,
  type ResearchReplayRecordingPayload,
  type ResearchReplayNotebook
} from '../../shared/research-replay'

export class ResearchReplayError extends Error {
  constructor(
    readonly code:
      'unauthorized' | 'unavailable' | 'invalid' | 'forbidden' | 'oversized' | 'not-found',
    readonly status = 400
  ) {
    super(code)
  }
}
export type ResearchReplayDependencies = {
  reader: ReplayReaderApi
  observationBindings?(
    document: ReplayDocument,
    payloads: readonly RecordedObservationPayload[]
  ): Promise<ResearchReplayObservationBinding[]>
  recordings: RecordedObservationReader
  immutable: Pick<ImmutableInputAuthority, 'resolveVersion' | 'openContent'>
  authorize(target: ResearchReplayTarget): Promise<void>
  readRun(target: ResearchReplayTarget, runId: string): Promise<NotebookRunRecord | undefined>
  now?: () => number
}
type Snapshot = {
  viewerId: string
  target: ResearchReplayTarget
  expiresAt: number
  caller: CallerContext
  data: ResearchReplayDocument
  payloads: Map<string, ResearchReplayRecordingPayload>
  origins: Readonly<Record<string, number>>
  coverage: ReturnType<typeof createResearchReplayTimeline>['coverage']
  selection?: ResearchReplaySelection
  selections: Map<string, ResearchReplaySelection>
}
const MAX_RESOURCE = 32 * 1024 * 1024
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

function hasCompleteBrowserMedia(payload: RecordedBrowserPayload): boolean {
  const resolved = new Map(payload.media.map((media) => [media.mediaKey, media]))
  return payload.recording.media.every((media) => {
    const receiving = resolved.get(media.mediaKey)
    return receiving?.checksum === media.checksum && receiving.sizeBytes === media.sizeBytes
  })
}

function isCoveredBrowserCheckpoint(
  checkpoint: BrowserRecording,
  final: BrowserRecording
): boolean {
  const prefix = <T>(part: readonly T[], whole: readonly T[]): boolean =>
    part.length <= whole.length &&
    part.every((item, index) => isDeepStrictEqual(item, whole[index]))
  return (
    checkpoint.coverage.stopReason === 'interrupted' &&
    checkpoint.recordingId === final.recordingId &&
    checkpoint.startedAt === final.startedAt &&
    checkpoint.title === final.title &&
    !!checkpoint.source?.projectId &&
    !!checkpoint.source.sessionId &&
    isDeepStrictEqual(checkpoint.source, final.source) &&
    checkpoint.durationMs <= final.durationMs &&
    checkpoint.coverage.droppedFrames <= final.coverage.droppedFrames &&
    prefix(checkpoint.media, final.media) &&
    prefix(checkpoint.segments, final.segments) &&
    prefix(checkpoint.events, final.events) &&
    prefix(checkpoint.coverage.gaps, final.coverage.gaps)
  )
}

export class ResearchReplayService {
  private readonly snapshots = new Map<string, Snapshot>()
  private opening = 0
  constructor(private readonly dependencies: ResearchReplayDependencies) {}
  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }
  private assertCaller(caller: CallerContext): void {
    if (!caller.isAuthorizationCurrent()) throw new ResearchReplayError('unauthorized', 401)
    if (caller.location !== 'local') throw new ResearchReplayError('forbidden', 403)
  }
  async open(
    value: unknown,
    caller: CallerContext
  ): Promise<{ viewerId: string; target: ResearchReplayTarget; expiresAt: number }> {
    this.assertCaller(caller)
    const target = researchReplayTargetSchema.parse(value)
    await this.dependencies.authorize(target)
    for (const [id, row] of this.snapshots)
      if (row.expiresAt <= this.now() || !row.caller.isAuthorizationCurrent())
        this.snapshots.delete(id)
    if (this.snapshots.size + this.opening >= 16) throw new ResearchReplayError('unavailable', 429)
    this.opening++
    try {
      const document = structuredClone(await loadReplayDocument(this.dependencies.reader, target))
      if (bytes(document) > 16 * 1024 * 1024) throw new ResearchReplayError('oversized', 413)
      const candidates = document.resources
        .filter(
          (resource) =>
            (resource.source ?? 'artifact') === 'artifact' &&
            resource.projectId === target.projectId &&
            resource.sessionId === target.sessionId &&
            resource.artifactId &&
            resource.versionId &&
            (!resource.mimeType ||
              resource.mimeType.includes('json') ||
              resource.mimeType.startsWith('text/') ||
              /\.json$/i.test(resource.name))
        )
        .sort((a, b) => {
          const priority = (name: string): number =>
            /^web-recording-[a-f0-9-]+\.json$/.test(name)
              ? Infinity
              : Number(/-checkpoint-(\d+)\.json$/.exec(name)?.[1] ?? 0)
          const left = priority(a.name),
            right = priority(b.name)
          return left === right
            ? (b.versionNumber ?? 0) - (a.versionNumber ?? 0)
            : left > right
              ? -1
              : 1
        })
        .map((resource) => ({
          resource,
          target: { ...target, artifactId: resource.artifactId!, versionId: resource.versionId! }
        }))
      const recordings: ResearchReplayDocument['recordings'] = []
      const unavailableRecordingIds: string[] = []
      const payloads = new Map<string, ResearchReplayRecordingPayload>()
      const browserGroups = new Set<string>()
      const verifiedBrowserFinals = new Map<string, BrowserRecording>()
      const supportingResourceIds = new Set<string>()
      // Candidate metadata is never authority; verify the exact saved index and all source mappings.
      for (const candidate of candidates.slice(0, 512)) {
        if (recordings.length >= 64) break
        if ((candidate.resource.size ?? MAX_RESOURCE) > 4 * 1024 * 1024) continue
        let kind: 'web-recording' | 'project-recording' | 'run-observation' | undefined
        try {
          const asset = await this.resourceBytes(candidate.resource)
          const index = JSON.parse(Buffer.from(asset.body).toString('utf8'))
          kind =
            index.format === 'open-science-web-recording'
              ? 'web-recording'
              : index.format === 'open-science-project-recording'
                ? 'project-recording'
                : index.format === 'open-science-run-observation'
                  ? 'run-observation'
                  : undefined
          if (!kind) continue
          const final =
            kind === 'web-recording' ? verifiedBrowserFinals.get(index.recordingId) : undefined
          if (final) {
            // Verify each immutable index and its strict schema even when its filename looks
            // like an old checkpoint. Only reuse a fully mapped final from this same open.
            const checkpoint = parseBrowserRecording(
              new TextDecoder('utf-8', { fatal: true }).decode(asset.body)
            )
            if (isCoveredBrowserCheckpoint(checkpoint, final)) {
              // All of its exact media declarations already belong to the selected final.
              // Hide the redundant index without granting a new playback target or mapping.
              supportingResourceIds.add(candidate.resource.id)
              continue
            }
          }
          const payload =
            kind === 'web-recording'
              ? await this.dependencies.recordings.readBrowser(candidate.target)
              : kind === 'project-recording'
                ? await this.dependencies.recordings.readProject(candidate.target)
                : await this.dependencies.recordings.read(candidate.target)
          supportingResourceIds.add(candidate.resource.id)
          const frameKeys =
            'indexChecksum' in payload
              ? new Set(payload.recording.media.map((media) => media.mediaKey))
              : 'archive' in payload
                ? new Set(
                    payload.archive.media
                      .filter((media) => media.capture)
                      .map((media) => media.mediaKey)
                  )
                : new Set(payload.recording.frames.map((frame) => frame.mediaKey))
          for (const media of payload.media) {
            if (media.versionId && frameKeys.has(media.mediaKey)) {
              const resource = document.resources.find(
                (item) =>
                  item.versionId === media.versionId &&
                  item.projectId === target.projectId &&
                  item.sessionId === target.sessionId
              )
              if (resource) supportingResourceIds.add(resource.id)
            }
          }
          if (kind === 'web-recording') {
            const browser = payload as RecordedBrowserPayload
            const group = browser.recording.recordingId
            if (browserGroups.has(group)) continue
            browserGroups.add(group)
            if (
              browser.recording.coverage.stopReason !== 'interrupted' &&
              hasCompleteBrowserMedia(browser)
            )
              verifiedBrowserFinals.set(group, structuredClone(browser.recording))
          }
          payloads.set(candidate.resource.id, structuredClone(payload))
          recordings.push({
            id: candidate.resource.id,
            kind,
            target: candidate.target,
            name: candidate.resource.name
          })
        } catch {
          if (kind) unavailableRecordingIds.push(candidate.resource.id)
        }
      }
      const timeline = createResearchReplayTimeline(
        document,
        [...payloads.values()].filter(
          (value): value is RecordedBrowserPayload =>
            'recording' in value && value.recording.format === 'open-science-web-recording'
        ),
        [...supportingResourceIds]
      )
      let observationBindings: ResearchReplayObservationBinding[] = []
      try {
        observationBindings =
          (await this.dependencies.observationBindings?.(
            document,
            [...payloads.values()].filter(
              (payload): payload is RecordedObservationPayload => 'archive' in payload
            )
          )) ?? []
      } catch {
        /* Optional historical association must not prevent ordinary Replay. */
      }
      const snapshot: Snapshot = {
        viewerId: randomUUID(),
        target,
        expiresAt: this.now() + 2 * 60 * 60 * 1000,
        caller,
        data: {
          document: timeline.document,
          observationBindings: structuredClone(observationBindings),
          timing: {
            recordedTimeOrigins: timeline.recordedTimeOrigins,
            coverage: timeline.coverage,
            timelineCoverage: timeline.timelineCoverage,
            unalignedBranchIds: timeline.unalignedBranchIds
          },
          supportingResourceIds: [...supportingResourceIds],
          recordings,
          recordingsTruncated: candidates.length > 512 || recordings.length >= 64,
          unavailableRecordingIds
        },
        payloads,
        selections: new Map(),
        origins: timeline.recordedTimeOrigins,
        coverage: timeline.coverage
      }
      await this.dependencies.authorize(target)
      this.assertCaller(caller)
      this.snapshots.set(snapshot.viewerId, snapshot)
      return { viewerId: snapshot.viewerId, target, expiresAt: snapshot.expiresAt }
    } finally {
      this.opening--
    }
  }
  private async get(viewerId: string, caller: CallerContext): Promise<Snapshot> {
    this.assertCaller(caller)
    const row = this.snapshots.get(viewerId)
    if (!row || row.expiresAt <= this.now()) {
      this.snapshots.delete(viewerId)
      throw new ResearchReplayError('unavailable', 410)
    }
    if (
      row.caller.leaseId !== caller.leaseId ||
      row.caller.lifecycleClientId !== caller.lifecycleClientId ||
      !row.caller.isAuthorizationCurrent()
    )
      throw new ResearchReplayError('unauthorized', 401)
    await this.dependencies.authorize(row.target)
    this.assertCaller(caller)
    if (this.snapshots.get(viewerId) !== row) throw new ResearchReplayError('unavailable', 410)
    return row
  }
  async document(viewerId: string, caller: CallerContext): Promise<ResearchReplayDocument> {
    return structuredClone((await this.get(viewerId, caller)).data)
  }
  async read(viewerId: string, value: unknown, caller: CallerContext): Promise<unknown> {
    const query = researchReplayReadSchema.parse(value),
      row = await this.get(viewerId, caller),
      doc = row.data.document
    let result: unknown
    if (query.kind === 'overview')
      result = {
        source: doc.source,
        branches: doc.branches.map((branch) => ({
          id: branch.id,
          label: branch.label,
          kind: branch.kind,
          durationMs: branch.durationMs,
          stepCount: branch.steps.length
        })),
        recordings: row.data.recordings,
        observationBindings: row.data.observationBindings,
        recordingsTruncated: row.data.recordingsTruncated,
        issues: doc.issues
      }
    else if (query.kind === 'steps') {
      const branch = doc.branches.find(
        (item) => item.id === (query.branchId ?? doc.defaultBranchId)
      )
      if (!branch) throw new ResearchReplayError('not-found', 404)
      const offset = query.offset ?? 0,
        limit = query.limit ?? 20
      if (offset > branch.steps.length) throw new ResearchReplayError('invalid')
      result = {
        branchId: branch.id,
        total: branch.steps.length,
        offset,
        steps: branch.steps
          .slice(offset, offset + limit)
          .map(
            ({ id, kind, title, status, startMs, endMs, recordedAt, evidence, resourceIds }) => ({
              id,
              kind,
              title,
              status,
              startMs,
              endMs,
              recordedAt,
              evidence,
              resourceIds
            })
          ),
        ...(offset + limit < branch.steps.length ? { nextOffset: offset + limit } : {})
      }
    } else if (query.kind === 'step' || query.kind === 'step-content') {
      const branch = doc.branches.find((item) => item.id === query.branchId),
        index = branch?.steps.findIndex((item) => item.id === query.stepId) ?? -1
      if (!branch || index < 0) throw new ResearchReplayError('not-found', 404)
      const step = branch.steps[index]
      if (query.kind === 'step-content') {
        const serialized = JSON.stringify(step),
          offset = query.offset ?? 0
        if (offset > serialized.length) throw new ResearchReplayError('invalid')
        const end = Math.min(serialized.length, offset + (query.length ?? 16384))
        result = {
          encoding: 'json',
          offset,
          totalCharacters: serialized.length,
          text: serialized.slice(offset, end),
          ...(end < serialized.length ? { nextOffset: end } : {})
        }
      } else {
        const full = {
          source: doc.source,
          branchId: branch.id,
          step,
          context: branch.steps
            .slice(Math.max(0, index - 2), index)
            .filter((item) => item.message)
            .map((item) => ({ id: item.id, message: item.message })),
          resources: doc.resources.filter((resource) => step.resourceIds.includes(resource.id))
        }
        result =
          bytes(full) <= 128 * 1024
            ? { ...full, contentTruncated: false }
            : {
                source: doc.source,
                branchId: branch.id,
                step: null,
                context: [],
                resources: [],
                contentTruncated: true,
                contentQuery: { kind: 'step-content', branchId: branch.id, stepId: step.id }
              }
      }
    } else if (query.kind === 'notebook') {
      const allowed = new Map(
        doc.branches.flatMap((branch) =>
          branch.steps.flatMap((step) => step.runs.map((run) => [run.runId, run] as const))
        )
      )
      const runs: ResearchReplayNotebook['runs'] = {}
      for (const runId of query.runIds) {
        if (!allowed.has(runId)) throw new ResearchReplayError('forbidden', 403)
        const run = await this.dependencies.readRun(row.target, runId)
        const index = allowed.get(runId)!
        runs[runId] =
          run && (run.status === 'queued' || run.status === 'running')
            ? { status: 'unavailable', reason: 'identity-mismatch' }
            : run &&
                (run.runId !== runId ||
                  run.startedAt !== index.startedAt ||
                  run.endedAt !== index.endedAt ||
                  run.status !== index.status)
              ? { status: 'unavailable', reason: 'identity-mismatch' }
              : !run
                ? { status: 'unavailable', reason: 'not-recorded' }
                : bytes(run) > 2 * 1024 * 1024
                  ? { status: 'unavailable', reason: 'too-large' }
                  : { status: 'ready', run, bytes: bytes(run) }
      }
      result = { runs }
    } else if (query.kind === 'recording') {
      result = row.payloads.get(query.recordingId)
      if (!result) throw new ResearchReplayError('not-found', 404)
    } else {
      const asset = await this.resource(viewerId, query.resourceId, caller),
        offset = query.offset ?? 0
      if (offset > asset.body.byteLength) throw new ResearchReplayError('invalid')
      const end = Math.min(asset.body.byteLength, offset + (query.length ?? 262144))
      result = {
        resourceId: query.resourceId,
        mimeType: asset.mimeType,
        sizeBytes: asset.body.byteLength,
        offset,
        dataBase64: Buffer.from(asset.body.subarray(offset, end)).toString('base64'),
        ...(end < asset.body.byteLength ? { nextOffset: end } : {})
      }
    }
    await this.get(viewerId, caller)
    if (bytes(result) > 4 * 1024 * 1024) throw new ResearchReplayError('oversized', 413)
    return structuredClone(result)
  }
  async select(
    viewerId: string,
    value: unknown,
    caller: CallerContext
  ): Promise<ResearchReplaySelection> {
    const position = researchReplayPositionSchema.parse(value),
      row = await this.get(viewerId, caller)
    const branch = row.data.document.branches.find((item) => item.id === position.branchId),
      originalStep = branch?.steps.find((item) => item.id === position.stepId)
    if (!branch || !originalStep || position.timeMs > branch.durationMs)
      throw new ResearchReplayError('invalid')
    const origin = row.origins[position.branchId]
    let observation: ResearchReplaySelection['observation']
    let observationRunId: string | undefined
    let observationTimeMs: number | undefined
    if (position.observation) {
      if (
        position.scope === 'session' ||
        position.notebookRunId ||
        position.inspectStep ||
        position.resourceId ||
        position.recordingId ||
        position.offsetMs !== undefined ||
        origin === undefined
      )
        throw new ResearchReplayError('invalid')
      const descriptor = row.data.recordings.find(
        (item) => item.id === position.observation!.recordingId
      )
      const payload = descriptor && row.payloads.get(descriptor.id)
      if (
        !descriptor ||
        descriptor.kind !== 'run-observation' ||
        !payload ||
        !('archive' in payload)
      )
        throw new ResearchReplayError('forbidden', 403)
      const binding = row.data.observationBindings?.find(
        (item) =>
          item.recordingId === payload.archive.recordingId &&
          item.branchIds.includes(position.branchId) &&
          (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
            (key) => item.target[key] === descriptor.target[key]
          )
      )
      const record = payload.archive.records.find(
        (item) => item.stepKey === position.observation!.stepKey
      )
      const resource = row.data.document.resources.find((item) => item.id === descriptor.id)
      if (
        !binding ||
        !record ||
        resource?.checksum !== binding.archiveChecksum ||
        !originalStep.runs.some((run) => run.runId === binding.runId) ||
        record.observedAt < origin ||
        record.observedAt > origin + position.timeMs
      )
        throw new ResearchReplayError('invalid')
      observation = captureRecordedObservationSelection(payload, record.stepKey)
      observationRunId = binding.runId
      observationTimeMs = record.observedAt - origin
    }
    if (
      (position.notebookRunId || position.inspectStep) &&
      (Boolean(position.notebookRunId && position.inspectStep) ||
        position.scope === 'session' ||
        position.resourceId ||
        position.recordingId ||
        position.offsetMs !== undefined)
    )
      throw new ResearchReplayError('invalid')
    const observedRun = originalStep.runs.find((run) => run.runId === observationRunId)
    // An operation may have a saved preparing state before its eventual Notebook run exists.
    // Keep the actual evidence cutoff and only identify the owning research step; do not seek
    // forward to the run's start or attach the code/results that became available later.
    const beforeRun =
      observationTimeMs !== undefined &&
      observedRun &&
      (observationTimeMs < originalStep.startMs ||
        observation!.record.observedAt < observedRun.startedAt)
    const earlyObservationScene: ReplayScene | undefined = beforeRun
      ? {
          ...projectReplayScene(row.data.document, position.branchId, observationTimeMs!, origin),
          step: {
            id: originalStep.id,
            branchId: originalStep.branchId,
            kind: originalStep.kind,
            startMs: originalStep.startMs,
            endMs: originalStep.endMs,
            durationMs: originalStep.durationMs,
            activities: [],
            runs: [],
            resourceIds: [],
            evidence: [],
            issues: []
          },
          stepIndex: branch.steps.indexOf(originalStep),
          phase: 'activity',
          showResults: false,
          messageCharacters: 0,
          visibleEvidence: [],
          visibleResourceIds: []
        }
      : undefined
    const scene =
      earlyObservationScene ??
      (observationRunId
        ? projectReplayNotebookInspection(
            row.data.document,
            position.branchId,
            position.stepId,
            observationRunId,
            observationTimeMs!,
            origin
          )
        : position.notebookRunId
          ? projectReplayNotebookInspection(
              row.data.document,
              position.branchId,
              position.stepId,
              position.notebookRunId,
              position.timeMs,
              origin
            )
          : position.inspectStep
            ? projectReplayStepInspection(
                row.data.document,
                position.branchId,
                position.stepId,
                position.timeMs,
                origin,
                position.inspectStep === 'saved-history'
              )
            : projectReplayScene(row.data.document, position.branchId, position.timeMs, origin))
    if (!scene?.step || scene.step.id !== originalStep.id) throw new ResearchReplayError('invalid')
    const step = scene.step
    if (
      position.recordedAt !== undefined &&
      (origin === undefined || Math.abs(position.recordedAt - origin - position.timeMs) > 1)
    )
      throw new ResearchReplayError('invalid')
    const resource = position.resourceId
      ? row.data.document.resources.find((item) => item.id === position.resourceId)
      : undefined
    if (position.resourceId && !resource) throw new ResearchReplayError('forbidden', 403)
    let moment: ResearchReplaySelection['moment']
    if (position.recordingId) {
      const recording = row.data.recordings.find((item) => item.id === position.recordingId)
      if (!recording || recording.kind !== 'web-recording' || position.offsetMs === undefined)
        throw new ResearchReplayError('invalid')
      const payload = row.payloads.get(recording.id) as RecordedBrowserPayload
      if (
        origin === undefined ||
        !row.coverage[position.branchId]?.some(
          (item) =>
            item.recordingId === payload.recording.recordingId &&
            item.target.versionId === recording.target.versionId
        ) ||
        Math.abs(origin + position.timeMs - payload.recording.startedAt - position.offsetMs) > 1
      )
        throw new ResearchReplayError('invalid')
      moment = await this.dependencies.recordings.selectBrowserMoment(
        recording.target,
        position.offsetMs
      )
    } else if (position.offsetMs !== undefined) throw new ResearchReplayError('invalid')
    const visibleStep: ReplayStep = {
      ...structuredClone(step),
      evidence: scene.visibleEvidence.filter((reference) =>
        step.evidence.some((item) => item.id === reference.id && item.kind === reference.kind)
      ),
      ...(step.message
        ? {
            message: {
              ...step.message,
              content: step.message.content.slice(0, scene.messageCharacters)
            }
          }
        : {}),
      activities: step.activities.slice(0, 8).map((activity) =>
        scene.showResults
          ? structuredClone(activity)
          : {
              id: activity.id,
              kind: activity.kind,
              title: activity.title,
              status: 'in_progress',
              sortIndex: activity.sortIndex,
              eventIds: activity.eventIds,
              createdAt: activity.createdAt,
              updatedAt: activity.createdAt,
              rawInput: structuredClone(activity.rawInput),
              providerToolName: activity.providerToolName
            }
      ),
      ...(scene.showResults
        ? {}
        : {
            review: undefined,
            resourceIds: [],
            status: undefined,
            runs: step.runs.map((run) => ({
              ...run,
              status: 'running' as const,
              endedAt: undefined,
              hasOutput: undefined
            }))
          })
    }
    const serialized = JSON.stringify(visibleStep),
      truncated = serialized.length > 12000
    const selectionId = randomUUID()
    const selectedAt = this.now()
    const selected: ResearchReplaySelection = {
      selectionId,
      viewerId,
      selectedAt,
      source: row.data.document.source,
      position,
      step: visibleStep,
      excerpt: serialized.slice(0, 12000),
      evidence: visibleStep.evidence,
      phase: scene.phase,
      ...(resource ? { resource, inspection: 'saved-resource' as const } : {}),
      ...(moment ? { moment, inspection: 'recorded-moment' as const } : {}),
      ...(observation
        ? {
            observation: { ...observation, selectionId, selectedAt },
            inspection: 'recorded-observation' as const
          }
        : {}),
      truncated
    }
    if (bytes(selected) > 512 * 1024) throw new ResearchReplayError('oversized', 413)
    await this.get(viewerId, caller)
    row.selection = selected
    row.selections.set(selected.selectionId, selected)
    while (row.selections.size > 16) row.selections.delete(row.selections.keys().next().value!)
    return structuredClone(selected)
  }
  async selection(
    viewerId: string,
    caller: CallerContext,
    selectionId?: string
  ): Promise<ResearchReplaySelection | null> {
    const row = await this.get(viewerId, caller)
    const selected = selectionId ? row.selections.get(selectionId) : row.selection
    if (selectionId && !selected) throw new ResearchReplayError('not-found', 404)
    return selected ? structuredClone(selected) : null
  }
  async resource(
    viewerId: string,
    resourceId: string,
    caller: CallerContext
  ): Promise<{ body: Uint8Array; mimeType: string }> {
    const row = await this.get(viewerId, caller),
      resource = row.data.document.resources.find((item) => item.id === resourceId)
    if (
      !resource ||
      resource.projectId !== row.target.projectId ||
      resource.sessionId !== row.target.sessionId
    )
      throw new ResearchReplayError('forbidden', 403)
    const asset = await this.resourceBytes(resource)
    await this.get(viewerId, caller)
    return asset
  }
  private async resourceBytes(
    resource: ReplayResource,
    maxBytes = MAX_RESOURCE,
    expectedSize?: number
  ): Promise<{ body: Uint8Array; mimeType: string }> {
    if (!resource.versionId || resource.availability !== 'recorded')
      throw new ResearchReplayError('not-found', 404)
    const input = await this.dependencies.immutable.resolveVersion({
      projectId: resource.projectId,
      sourceKind: resource.source === 'upload' ? 'upload-version' : 'artifact-version',
      inputFileVersionId: resource.versionId,
      expectedSourceFileId: resource.source === 'upload' ? resource.fileId : resource.artifactId
    })
    if (
      !input ||
      input.sourceKind !== (resource.source === 'upload' ? 'upload-version' : 'artifact-version') ||
      input.inputFileVersionId !== resource.versionId ||
      input.sourceFileId !==
        (resource.source === 'upload' ? resource.fileId : resource.artifactId) ||
      input.sourceSessionId !== resource.sessionId ||
      input.sourceProjectId !== resource.projectId ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > maxBytes ||
      (expectedSize !== undefined && input.sizeBytes !== expectedSize) ||
      (resource.checksum && resource.checksum !== input.checksum)
    )
      throw new ResearchReplayError('not-found', 404)
    const lease = await this.dependencies.immutable.openContent(input)
    try {
      const body = await lease.readRange(0, input.sizeBytes)
      await lease.verifyUnchanged()
      if (
        body.byteLength !== input.sizeBytes ||
        createHash('sha256').update(body).digest('hex') !== input.checksum
      )
        throw new ResearchReplayError('unavailable', 410)
      const current = await this.dependencies.immutable.resolveVersion({
        projectId: resource.projectId,
        sourceKind: resource.source === 'upload' ? 'upload-version' : 'artifact-version',
        inputFileVersionId: resource.versionId,
        expectedSourceFileId: resource.source === 'upload' ? resource.fileId : resource.artifactId
      })
      if (
        !current ||
        current.sourceKind !== input.sourceKind ||
        current.inputFileVersionId !== input.inputFileVersionId ||
        current.sourceFileId !== input.sourceFileId ||
        current.sourceSessionId !== input.sourceSessionId ||
        current.sourceProjectId !== input.sourceProjectId ||
        current.sizeBytes !== input.sizeBytes ||
        current.storageKey !== input.storageKey ||
        current.checksum !== input.checksum
      )
        throw new ResearchReplayError('unavailable', 410)
      return {
        body,
        mimeType: input.contentType ?? resource.mimeType ?? 'application/octet-stream'
      }
    } finally {
      await lease.close()
    }
  }
  async media(
    viewerId: string,
    recordingId: string,
    mediaKey: string,
    caller: CallerContext
  ): Promise<{ body: Uint8Array; mimeType: string }> {
    const row = await this.get(viewerId, caller),
      recording = row.data.recordings.find((item) => item.id === recordingId)
    if (!recording) throw new ResearchReplayError('forbidden', 403)
    let asset: { body: Uint8Array; mimeType: string }
    if (recording.kind === 'web-recording') {
      // The private viewer snapshot owns this mapping, verified by readBrowser during open.
      // Requests can select a key but cannot supply a payload, Version, checksum or path.
      const payload = row.payloads.get(recordingId)
      if (
        !payload ||
        !('indexChecksum' in payload) ||
        !(['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
          (key) => payload.receiving[key] === recording.target[key]
        )
      )
        throw new ResearchReplayError('unavailable', 410)
      const declared = payload.recording.media.find((item) => item.mediaKey === mediaKey)
      const resolved = payload.media.find((item) => item.mediaKey === mediaKey)
      if (
        !declared ||
        !resolved ||
        resolved.checksum !== declared.checksum ||
        resolved.sizeBytes !== declared.sizeBytes
      )
        throw new ResearchReplayError('not-found', 404)
      const indexResource: ReplayResource = {
        id: recordingId,
        name: recording.name,
        ...recording.target,
        source: 'artifact',
        checksum: payload.indexChecksum,
        availability: 'recorded'
      }
      // Recheck the exact saved index on both sides of the selected media read. Reusing its
      // mapping never keeps an unpublished, rebound, changed or revoked resource readable.
      await this.resourceBytes(indexResource, MAX_BROWSER_RECORDING_INDEX_BYTES)
      const media = await this.resourceBytes(
        {
          ...indexResource,
          artifactId: resolved.artifactId,
          versionId: resolved.versionId,
          checksum: declared.checksum,
          name: declared.name,
          mimeType: declared.mimeType
        },
        MAX_BROWSER_RECORDING_SEGMENT_BYTES,
        declared.sizeBytes
      )
      await this.resourceBytes(indexResource, MAX_BROWSER_RECORDING_INDEX_BYTES)
      asset = { body: media.body, mimeType: declared.mimeType }
    } else {
      asset =
        recording.kind === 'project-recording'
          ? await this.dependencies.recordings.readProjectMedia(recording.target, mediaKey)
          : await this.dependencies.recordings.readMedia(recording.target, mediaKey)
    }
    await this.get(viewerId, caller)
    return asset
  }
  async revoke(viewerId: string, caller: CallerContext): Promise<void> {
    await this.get(viewerId, caller)
    this.snapshots.delete(viewerId)
  }
  discard(viewerId: string): void {
    this.snapshots.delete(viewerId)
  }
  close(): void {
    this.snapshots.clear()
  }
}
