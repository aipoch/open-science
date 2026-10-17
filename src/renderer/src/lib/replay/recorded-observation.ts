import type { ReactNode } from 'react'
import type { RunObservationArchive } from '../../../../shared/run-observation-archive'
import type { RunObservationSnapshot } from '../../../../shared/run-observation'
import type { ReplayResource } from '../../../../shared/replay'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'
import type { ReplayResourceReader } from '../../pages/workspace/replay/replay-resources'

import type {
  RecordedObservationReceivingScope,
  ResolvedObservationMedia,
  RecordedRunObservationSelection
} from '../../../../shared/run-observation-recorded'
export type {
  RecordedObservationReceivingScope,
  ResolvedObservationMedia,
  RecordedRunObservationSelection
} from '../../../../shared/run-observation-recorded'

export type RecordedObservationResourceRenderer = (
  resource: ReplayResource,
  onClose: () => void
) => ReactNode

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry)
    Object.freeze(value)
  }
  return value
}
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
// This is a UI identity, never a Notebook Run locator or execution authority. The complete
// receiver Artifact Version identity is retained separately in sourceIdentity and selections.
const localIdentity = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return `recording-local-${(hash >>> 0).toString(16)}`
}

/** Input has already passed the shared archive validator. Resolved media come only from the
 * receiving host's scope/hash authorization; archive source IDs never authorize receiver reads. */
export const projectRecordedObservation = (
  archive: RunObservationArchive,
  receiving: RecordedObservationReceivingScope,
  resolvedMedia: readonly ResolvedObservationMedia[]
): {
  snapshots: readonly RunObservationSnapshot[]
  sourceIdentity: string
  unresolvedMediaKeys: readonly string[]
  unlinkedSourceFiles: boolean
  resources: ReadonlyMap<string, ReplayResource>
  resolveResource: (resource: ReplayResource) => ReplayResource | undefined
  select: (snapshot: RunObservationSnapshot) => RecordedRunObservationSelection
} => {
  const recording = freeze(structuredClone(archive))
  receiving = freeze({ ...receiving })
  if (
    !(['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
      (key) => typeof receiving[key] === 'string' && id.test(receiving[key])
    )
  )
    throw new Error('Invalid receiving recording identity.')
  const declarations = new Map(recording.media.map((media) => [media.mediaKey, media]))
  const resolved = new Map<string, ResolvedObservationMedia>()
  const resources = new Map<string, ReplayResource>()
  for (const item of resolvedMedia) {
    const declaration = declarations.get(item.mediaKey)
    if (
      !declaration ||
      resolved.has(item.mediaKey) ||
      !id.test(item.artifactId) ||
      !id.test(item.versionId) ||
      item.checksum !== declaration.checksum ||
      item.sizeBytes !== declaration.sizeBytes
    )
      throw new Error('Recorded media resolution does not match the declared content.')
    const resource: ReplayResource = freeze({
      source: 'artifact',
      id: item.versionId,
      name: declaration.name,
      projectId: receiving.projectId,
      sessionId: receiving.sessionId,
      artifactId: item.artifactId,
      versionId: item.versionId,
      locator: createArtifactVersionLocator({
        projectId: receiving.projectId,
        appSessionId: receiving.sessionId,
        artifactId: item.artifactId,
        versionId: item.versionId
      }),
      mimeType: declaration.mimeType,
      size: item.sizeBytes,
      checksum: item.checksum,
      availability: 'recorded'
    })
    const previous = resources.get(item.versionId)
    if (
      previous &&
      (previous.artifactId !== resource.artifactId ||
        previous.checksum !== resource.checksum ||
        previous.size !== resource.size)
    )
      throw new Error('Recorded media resolution aliases different local Versions.')
    resolved.set(item.mediaKey, item)
    resources.set(item.versionId, resource)
  }
  // Index media links once. A durable archive can contain thousands of records; rescanning
  // every media.stepKeys array for every record would turn projection into a quadratic walk.
  const mediaByStep = new Map<string, RunObservationArchive['media']>()
  for (const media of recording.media) {
    for (const stepKey of new Set(media.stepKeys)) {
      const entries = mediaByStep.get(stepKey)
      if (entries) entries.push(media)
      else mediaByStep.set(stepKey, [media])
    }
  }
  const sourceIdentity = JSON.stringify([
    'recorded-observation',
    receiving.projectId,
    receiving.sessionId,
    receiving.artifactId,
    receiving.versionId,
    recording.recordingId
  ])
  const syntheticId = localIdentity(sourceIdentity)
  const snapshots = recording.records.map((record, index): RunObservationSnapshot =>
    freeze({
      identity: {
        projectId: receiving.projectId,
        sessionId: receiving.sessionId,
        operationId: syntheticId,
        ...(record.run ? { runId: syntheticId } : {})
      },
      cursor: { epoch: syntheticId, sequence: index },
      observedAt: record.observedAt,
      // Publication happens after the Run ends. An immutable recording may therefore end
      // with a terminal Run and a still-collecting operation. Present the recorded Run's
      // outcome; selections below retain the exact original record and publication phase.
      phase:
        record.phase === 'collecting' &&
        record.run &&
        record.run.status !== 'queued' &&
        record.run.status !== 'running'
          ? record.run.status
          : record.phase,
      stepId: record.stepKey,
      // The archive clone already owns and freezes these logs; reuse them across projections.
      run: record.run ? { ...record.run, runId: syntheticId } : null,
      artifacts: [
        ...new Map(
          (mediaByStep.get(record.stepKey) ?? []).flatMap((media) => {
            const match = resolved.get(media.mediaKey)
            if (!match) return []
            return [
              [
                match.versionId,
                {
                  artifactId: match.artifactId,
                  versionId: match.versionId,
                  name: media.name,
                  mimeType: media.mimeType,
                  checksum: media.checksum,
                  sizeBytes: media.sizeBytes
                }
              ] as const
            ]
          })
        ).values()
      ],
      artifactsTruncated: record.artifactsTruncated
    })
  )
  const sourceVersions = new Set(
    recording.media.map((media) => media.sourceVersionId).filter(Boolean)
  )
  const resolveResource = (resource: ReplayResource): ReplayResource | undefined => {
    const authorized = resource.versionId ? resources.get(resource.versionId) : undefined
    return authorized &&
      resource.projectId === receiving.projectId &&
      resource.sessionId === receiving.sessionId &&
      resource.artifactId === authorized.artifactId &&
      resource.locator === authorized.locator
      ? authorized
      : undefined
  }
  return {
    snapshots: Object.freeze(snapshots),
    sourceIdentity,
    unresolvedMediaKeys: Object.freeze([
      ...new Set([
        ...recording.coverage.missingMediaKeys,
        ...recording.media
          .filter((media) => !resolved.has(media.mediaKey))
          .map((media) => media.mediaKey)
      ])
    ]),
    unlinkedSourceFiles: recording.records.some((record) =>
      record.artifactEvidence.some((evidence) => !sourceVersions.has(evidence.sourceVersionId))
    ),
    resources,
    resolveResource,
    select: (snapshot) => {
      const selected = snapshots[snapshot.cursor.sequence]
      if (
        !selected ||
        snapshot.cursor.epoch !== syntheticId ||
        snapshot.stepId !== selected.stepId ||
        snapshot.identity.projectId !== receiving.projectId ||
        snapshot.identity.sessionId !== receiving.sessionId ||
        snapshot.identity.operationId !== syntheticId
      )
        throw new Error('This step is outside the recorded observation.')
      const record = recording.records[snapshot.cursor.sequence]
      return freeze(
        structuredClone({
          kind: 'recorded-run-observation' as const,
          recordingId: recording.recordingId,
          receiving,
          stepKey: record.stepKey,
          record,
          mediaKeys: (mediaByStep.get(record.stepKey) ?? []).map((media) => media.mediaKey)
        })
      )
    }
  }
}

export const authorizedRecordedResourceReader =
  (
    resolveResource: (resource: ReplayResource) => ReplayResource | undefined,
    read: ReplayResourceReader
  ): ReplayResourceReader =>
  async (resource) => {
    const authorized = resolveResource(resource)
    return authorized ? read(authorized) : { status: 'unavailable', reason: 'not-recorded' }
  }
