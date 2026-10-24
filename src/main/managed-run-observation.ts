import type { RunObservationTarget, RunObservationPhase } from '../shared/run-observation'
import type {
  ManagedExecutionService,
  ManagedExecutionInspection
} from './notebook/managed-execution-service'
import type { RunObservationSource } from './run-observation/owner'
import { projectDemoViewing } from './run-observation/execution-context'

function phase(source: ManagedExecutionInspection): RunObservationPhase {
  const status = source.run?.status
  if (!status) return source.state === 'failed' ? 'failed' : 'preparing'
  if (status === 'queued' || status === 'running') return status
  if (source.state === 'running' || source.state === 'awaiting-publication') return 'collecting'
  if (source.state === 'failed' && status === 'completed') return 'failed'
  return status
}

/** Narrow read adapter. Admission journals and Notebook remain authoritative, not observer caches. */
export const createManagedRunObservationReader =
  (
    service: Pick<ManagedExecutionService, 'inspectExecution'>
  ): ((target: RunObservationTarget) => Promise<RunObservationSource | undefined>) =>
  async (target) => {
    const source = await service.inspectExecution(target)
    if (!source) return undefined
    return {
      identity: source.identity,
      phase: phase(source),
      run: source.run,
      secrets: source.secrets,
      executionContext: {
        purpose: source.purpose ?? 'unknown',
        ...(source.executionProfile ? { profileName: source.executionProfile.displayName } : {}),
        conditionChanges: source.executionProfile?.conditionChanges ?? [],
        ...(source.purpose === 'offline-demo' && source.demoViewing
          ? { demoViewing: projectDemoViewing(source.demoViewing, source.run) }
          : {})
      },
      artifacts: source.artifacts
        .filter(
          (artifact) => !artifact.producerRunId || artifact.producerRunId === source.run?.runId
        )
        .map((artifact) => ({
          artifactId: artifact.artifactId,
          versionId: artifact.versionId,
          name: artifact.name,
          mimeType: artifact.mimeType,
          checksum: artifact.checksum,
          sizeBytes: artifact.size,
          producerRunId: artifact.producerRunId
        }))
    }
  }
