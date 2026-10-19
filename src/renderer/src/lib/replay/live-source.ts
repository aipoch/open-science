import {
  REPLAY_GENERATOR_VERSION,
  REPLAY_PRESENTATION_VERSION,
  type ReplayDocument
} from '../../../../shared/replay'
import type {
  RunObservationSnapshot,
  RunObservationTarget
} from '../../../../shared/run-observation'
import { createArtifactVersionLocator } from '../../../../shared/artifact-provenance'

export type ReplayObservationMode = 'follow' | 'inspect' | 'history'

export const observationRecordId = (snapshot: RunObservationSnapshot): string =>
  `observation:${snapshot.cursor.epoch}:${snapshot.cursor.sequence}`

export const isObservationTerminal = (snapshot: RunObservationSnapshot): boolean =>
  !['preparing', 'queued', 'running', 'collecting'].includes(snapshot.phase)

/** The admission identity stays stable when an operation first acquires a Notebook Run. */
export const observationSourceIdentity = (target: RunObservationTarget): string => {
  const { projectId, sessionId, operationId, executionInvocationId, runId } = target
  return JSON.stringify([
    projectId,
    sessionId,
    operationId
      ? ['operation', operationId]
      : executionInvocationId
        ? ['invocation', executionInvocationId]
        : ['run', runId]
  ])
}

/** Retain real order and gaps. A repeated cursor cannot change its already observed evidence. */
export const normalizeObservationHistory = (
  snapshot: RunObservationSnapshot,
  history: readonly RunObservationSnapshot[] = []
): readonly RunObservationSnapshot[] => {
  const records: RunObservationSnapshot[] = []
  for (const record of [...history, snapshot]) {
    if (
      record.identity.projectId !== snapshot.identity.projectId ||
      record.identity.sessionId !== snapshot.identity.sessionId ||
      record.cursor.epoch !== snapshot.cursor.epoch ||
      !Number.isSafeInteger(record.cursor.sequence) ||
      record.cursor.sequence < 0 ||
      !Number.isFinite(record.observedAt)
    )
      throw new Error('Observation history must belong to one execution and epoch.')
    let matched = false
    for (const key of ['operationId', 'executionInvocationId', 'runId'] as const) {
      if (!record.identity[key] || !snapshot.identity[key]) continue
      if (record.identity[key] !== snapshot.identity[key])
        throw new Error('Observation execution identity changed.')
      matched = true
    }
    if (!matched || (record.run && record.run.runId !== record.identity.runId))
      throw new Error('Observation history has no matching execution identity.')
    const previous = records.at(-1)
    if (previous && record.cursor.sequence < previous.cursor.sequence)
      throw new Error('Observation history is out of order.')
    if (previous && record.cursor.sequence === previous.cursor.sequence) {
      if (previous !== record && JSON.stringify(previous) !== JSON.stringify(record))
        throw new Error('Observation evidence changed at an existing cursor.')
      continue
    }
    records.push(record)
  }
  return records
}

/**
 * Observation records are navigation points, not invented execution durations. The panel uses
 * record navigation (no percentage, speed or presentation clock) for this projection. Each
 * record is an actual immutable snapshot; absent history is never synthesized.
 */
export const buildObservationReplayDocument = (
  snapshots: readonly RunObservationSnapshot[],
  title: string
): ReplayDocument => {
  if (!snapshots.length) throw new Error('An observation snapshot is required.')
  const latest = snapshots[snapshots.length - 1]
  const records = normalizeObservationHistory(latest, snapshots)
  const resources = [
    ...new Map(
      records.flatMap((snapshot) =>
        snapshot.artifacts.map(
          (artifact) =>
            [
              artifact.versionId,
              {
                id: artifact.versionId,
                name: artifact.name,
                projectId: snapshot.identity.projectId,
                sessionId: snapshot.identity.sessionId,
                artifactId: artifact.artifactId,
                versionId: artifact.versionId,
                locator: artifact.artifactId
                  ? createArtifactVersionLocator({
                      projectId: snapshot.identity.projectId,
                      appSessionId: snapshot.identity.sessionId,
                      artifactId: artifact.artifactId,
                      versionId: artifact.versionId
                    })
                  : undefined,
                mimeType: artifact.mimeType,
                size: artifact.sizeBytes,
                checksum: artifact.checksum,
                producerRunId: artifact.producerRunId,
                availability: 'recorded' as const
              }
            ] as const
        )
      )
    ).values()
  ]
  return {
    generatorVersion: REPLAY_GENERATOR_VERSION,
    presentationVersion: REPLAY_PRESENTATION_VERSION,
    source: {
      projectId: latest.identity.projectId,
      sessionId: latest.identity.sessionId,
      title,
      fingerprint: observationRecordId(latest)
    },
    defaultBranchId: 'observation',
    branches: [
      {
        id: 'observation',
        kind: 'unattributed',
        durationMs: records.length,
        steps: records.map((snapshot, index) => ({
          id: observationRecordId(snapshot),
          kind: 'notebook',
          branchId: 'observation',
          status: snapshot.phase,
          startMs: index,
          durationMs: 1,
          endMs: index + 1,
          recordedAt: snapshot.observedAt,
          title: new Date(snapshot.observedAt).toISOString(),
          activities: [],
          runs: [],
          resourceIds: snapshot.artifacts.map((artifact) => artifact.versionId),
          evidence: [
            ...(snapshot.run
              ? [
                  {
                    kind: 'notebook-run' as const,
                    id: snapshot.run.runId,
                    projectId: snapshot.identity.projectId,
                    sessionId: snapshot.identity.sessionId
                  }
                ]
              : []),
            ...snapshot.artifacts.map((artifact) => ({
              kind: 'artifact-version' as const,
              id: artifact.versionId,
              versionId: artifact.versionId,
              projectId: snapshot.identity.projectId,
              sessionId: snapshot.identity.sessionId
            }))
          ],
          issues: []
        }))
      }
    ],
    resources,
    issues: []
  }
}
