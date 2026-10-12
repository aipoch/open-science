import type { ManagedObservationResult } from '../../shared/managed-execution'
import { runObservationTargetSchema } from '../../shared/run-observation'
import type { RunObservationTarget } from '../../shared/run-observation'
import type { RunObservationRecordingStatus } from '../../shared/run-observation-recording-status'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { ManagedRunObservationCoordinator } from './managed-coordinator'
import type { RunObservationRecorder } from './recorder'

/** Optional recording status is owned here, not by the execution service. The exact execution
 * inspection is still authoritative for admission and identity; a viewer cannot supply it. */
export function createManagedRecordingStatusReader(dependencies: {
  inspect(target: RunObservationTarget): Promise<
    | {
        identity: {
          projectId: string
          sessionId: string
          operationId: string
          executionInvocationId: string
          runId?: string
        }
        recordObservation?: boolean
        observation?: ManagedObservationResult
      }
    | undefined
  >
  coordinator: Pick<ManagedRunObservationCoordinator, 'confirm'>
  recorder: Pick<RunObservationRecorder, 'load'>
  artifacts: Pick<ArtifactProvenanceRepository, 'resolveVersionDescriptors'>
}): (value: unknown) => Promise<RunObservationRecordingStatus> {
  return async (value) => {
    const target = runObservationTargetSchema.parse(value)
    const inspected = await dependencies.inspect(target)
    if (!inspected) throw new Error('The exact managed execution is unavailable.')
    for (const key of [
      'projectId',
      'sessionId',
      'operationId',
      'executionInvocationId',
      'runId'
    ] as const)
      if (target[key] !== undefined && target[key] !== inspected.identity[key])
        throw new Error('The recording inspection belongs to another execution.')
    if (!inspected.recordObservation) return { target, state: 'not-recorded' }
    const canonical: RunObservationTarget = {
      projectId: inspected.identity.projectId,
      sessionId: inspected.identity.sessionId,
      operationId: inspected.identity.operationId,
      executionInvocationId: inspected.identity.executionInvocationId
    }
    // Confirm only an original exact publication; a status read never executes or writes an Artifact.
    await dependencies.coordinator.confirm(canonical)
    const recorded = await dependencies.recorder.load(canonical)
    const publication = recorded?.publication
    const versionId = publication?.state !== 'unpublished' ? publication?.versionId : undefined
    let archive: RunObservationRecordingStatus['archive']
    if (versionId && publication && publication.state !== 'unpublished') {
      const versions = await dependencies.artifacts.resolveVersionDescriptors({
        projectId: target.projectId,
        appSessionId: target.sessionId,
        versionIds: [versionId]
      })
      const exact = versions.filter(
        (version) =>
          version.versionId === versionId &&
          version.projectId === target.projectId &&
          version.sessionId === target.sessionId &&
          (!publication.artifactId || version.artifactId === publication.artifactId) &&
          version.checksum === publication.checksum &&
          version.size === publication.sizeBytes &&
          version.state === 'finalized' &&
          version.isPublished === true
      )
      if (exact.length === 1)
        archive = {
          projectId: target.projectId,
          sessionId: target.sessionId,
          artifactId: exact[0].artifactId,
          versionId
        }
    }
    const capacityLimit = recorded?.capacityLimit ?? recorded?.archive?.coverage.capacityLimit
    const state: RunObservationRecordingStatus['state'] = archive
      ? 'saved'
      : capacityLimit
        ? 'capacity'
        : recorded?.status === 'recording' && !recorded.recovered
          ? 'recording'
          : inspected.observation?.status === 'failed' ||
              inspected.observation?.status === 'unavailable'
            ? 'failed'
            : !recorded && inspected.observation?.status === 'recording'
              ? 'recording'
              : 'saving'
    // Keep the caller's validated selector; canonical recorder identities are not viewer selectors.
    return {
      target,
      state,
      ...(archive ? { archive } : {}),
      ...(capacityLimit ? { capacityLimit } : {})
    }
  }
}
