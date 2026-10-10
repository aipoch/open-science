import { projectReplayScene } from '../src/lib/replay/scene'
import type { ReplayMaterialPlayback } from '../src/pages/workspace/replay/ReplayStage'
import type { ReplayDocument, ReplayResource } from '../../shared/replay'
import type { ResearchReplayPosition, ResearchReplayRecording } from '../../shared/research-replay'
import type { RecordedEvidencePayload } from '../../shared/run-observation-recorded'
import type { ReplayResultEntry } from '../src/pages/workspace/replay/results/ResultsPanel'
import { recordedResults } from '../src/lib/replay/recorded-results'

export type ResearchRecordingMaterial = {
  descriptor: ResearchReplayRecording
  payload: RecordedEvidencePayload
}
const resourceIdentity = (resource: ReplayResource): string =>
  JSON.stringify([
    resource.projectId,
    resource.sessionId,
    resource.artifactId ?? resource.fileId,
    resource.versionId
  ])

/** Media containers and chunks remain inspectable attachments, not dozens of scientific results. */
export function researchResults(
  document: ReplayDocument,
  recordings: readonly ResearchRecordingMaterial[],
  supportingResourceIds: readonly string[] = []
): ReplayResultEntry[] {
  const technical = new Set<string>()
  const supporting = new Set(supportingResourceIds)
  for (const { descriptor, payload } of recordings) {
    technical.add(descriptor.target.versionId)
    const frameKeys =
      'indexChecksum' in payload
        ? new Set(payload.recording.media.map((media) => media.mediaKey))
        : 'archive' in payload
          ? new Set(
              payload.archive.media.filter((media) => media.capture).map((media) => media.mediaKey)
            )
          : new Set(payload.recording.frames.map((frame) => frame.mediaKey))
    for (const media of payload.media)
      if (frameKeys.has(media.mediaKey)) technical.add(media.versionId)
  }
  const declared = recordings.flatMap(({ payload }) =>
    'indexChecksum' in payload ? [] : recordedResults(payload)
  )
  const entries = document.resources.map<ReplayResultEntry>((resource) => {
    const saved = declared.find(
      (entry) => resourceIdentity(entry.resource) === resourceIdentity(resource)
    )
    return {
      ...(saved ?? {
        source: { kind: 'session-history' as const, id: document.source.sessionId },
        scope: { kind: 'recording' as const },
        stage: 'unspecified' as const
      }),
      resource,
      availableAt: resource.createdAt,
      technical:
        supporting.has(resource.id) ||
        Boolean(resource.versionId && technical.has(resource.versionId))
    }
  })
  const known = new Set(entries.map((entry) => resourceIdentity(entry.resource)))
  // Archive attachments absent from the session material list are still exact saved versions.
  for (const entry of declared)
    if (!known.has(resourceIdentity(entry.resource))) {
      entries.push(entry)
      known.add(resourceIdentity(entry.resource))
    }
  return entries
}

/** Match a click to the owning branch's clock, rather than a periodically saved view position. */
export function researchPosition(
  document: ReplayDocument,
  origins: Readonly<Record<string, number>>,
  playback: ReplayMaterialPlayback | undefined,
  at?: number
): ResearchReplayPosition | undefined {
  const branchId = playback?.branchId
  if (!branchId) return undefined
  const origin = origins[branchId]
  const recordedAt = at ?? playback?.recordedAt
  const timeMs = at !== undefined && origin !== undefined ? at - origin : playback?.positionMs
  if (timeMs === undefined || !Number.isFinite(timeMs) || timeMs < 0) return undefined
  const scene = projectReplayScene(document, branchId, timeMs)
  return scene.step
    ? {
        branchId,
        stepId: scene.step.id,
        timeMs,
        ...(recordedAt === undefined ? {} : { recordedAt })
      }
    : undefined
}

/** A saved file is anchored to its publication, independently of the current watching position. */
export function researchResourcePosition(
  document: ReplayDocument,
  origins: Readonly<Record<string, number>>,
  resource: ReplayResource,
  playback?: ReplayMaterialPlayback,
  recordedAt = resource.createdAt
): ResearchReplayPosition | undefined {
  const owner = document.branches.find((branch) =>
    branch.steps.some((step) => step.resourceIds.includes(resource.id))
  )
  const branch = owner ?? document.branches.find((branch) => branch.id === playback?.branchId)
  if (!branch) return undefined
  const origin = origins[branch.id]
  const timeMs = recordedAt !== undefined && origin !== undefined ? recordedAt - origin : undefined
  if (timeMs !== undefined && Number.isFinite(timeMs) && timeMs >= 0 && timeMs <= branch.durationMs)
    return researchPosition(
      document,
      origins,
      { ...playback, branchId: branch.id } as ReplayMaterialPlayback,
      recordedAt
    )
  const step = branch.steps.find((step) => step.resourceIds.includes(resource.id))
  if (step) {
    const at = Math.max(step.startMs, step.endMs - 1)
    const scene = projectReplayScene(document, branch.id, at)
    if (scene.step) return { branchId: branch.id, stepId: scene.step.id, timeMs: at }
  }
  // Legacy files may lack publication evidence; preserve exact file identity without inventing it.
  return researchPosition(document, origins, playback)
}
