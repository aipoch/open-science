import type {
  ArtifactExecutionSnapshot,
  PersistedArtifactExecutionSnapshot,
  ProvenanceExecutionInputFile
} from '../../shared/artifact-provenance'
import { projectCapturedArtifactReproducibility } from '@aipoch/reproducibility'

export const projectPublicArtifactExecutionSnapshot = (
  persisted: PersistedArtifactExecutionSnapshot,
  inputFiles: ProvenanceExecutionInputFile[]
): ArtifactExecutionSnapshot => {
  const capture =
    persisted.workflowCapture?.state === 'available' ? persisted.workflowCapture.capture : undefined
  const notebookRunIds = new Set(capture?.runs.map((run) => run.runId) ?? [])
  const boundaryIds = new Set(
    capture?.graph.edges.flatMap((edge) =>
      edge.kind === 'used' &&
      edge.authority === 'authoritative' &&
      notebookRunIds.has(edge.activityId)
        ? [edge.entityId]
        : []
    ) ?? []
  )
  // A frozen file-set is an indivisible boundary even when the consumer reads one member.
  let expanded = true
  while (expanded) {
    expanded = false
    for (const group of capture?.graph.outputGroups ?? []) {
      if (!group.memberEntityIds.some((id) => boundaryIds.has(id))) continue
      for (const id of group.memberEntityIds) {
        if (!boundaryIds.has(id)) {
          boundaryIds.add(id)
          expanded = true
        }
      }
    }
  }
  const reproducibility = projectCapturedArtifactReproducibility(persisted)
  return {
    schemaVersion: persisted.schemaVersion,
    rootFrameId: persisted.rootFrameId,
    agentFrameId: persisted.agentFrameId,
    messageBranchId: persisted.messageBranchId,
    terminalPromptMessageId: persisted.terminalPromptMessageId,
    producerRunId: persisted.producerRunId,
    producerRunIndex: persisted.producerRunIndex,
    createdAt: persisted.createdAt,
    ...(persisted.analysisRevision ? { analysisRevision: persisted.analysisRevision } : {}),
    inputFiles,
    runs: persisted.runs,
    ...(reproducibility ? { reproducibility } : {}),
    ...(persisted.workflowCapture
      ? {
          workflow:
            persisted.workflowCapture.state === 'unavailable'
              ? persisted.workflowCapture
              : {
                  state: 'available' as const,
                  captureId: persisted.workflowCapture.capture.captureId,
                  stages: persisted.workflowCapture.capture.runs.map((run) => ({
                    runId: run.runId,
                    runIndex: run.runIndex,
                    kernelKind: run.kernelKind,
                    outputCount:
                      capture?.graph.edges.filter(
                        (edge) => edge.kind === 'generated' && edge.activityId === run.runId
                      ).length ?? 0
                  })),
                  boundaries: persisted.workflowCapture.capture.graph.entities.flatMap((entity) =>
                    entity.kind === 'file-generation' &&
                    entity.pathPortability === 'relative' &&
                    boundaryIds.has(entity.entityId)
                      ? [
                          {
                            entityId: entity.entityId,
                            relativePath: entity.relativePath,
                            checksum: entity.checksum,
                            sizeBytes: entity.sizeBytes
                          }
                        ]
                      : []
                  )
                }
        }
      : {}),
    ...(persisted.helperModules
      ? {
          helperModules: persisted.helperModules.map((helper) => ({
            helperId: helper.helperId,
            skillIdentity: helper.skillIdentity,
            packageOrigin: helper.packageOrigin,
            interfaceRevision: helper.interfaceRevision,
            registeredGeneration: helper.registeredGeneration,
            exports: [...helper.exports],
            sourceDigest: helper.sourceDigest,
            sourceAvailable: true
          }))
        }
      : {}),
    ...(persisted.helperEvidenceStatus
      ? { helperEvidenceStatus: persisted.helperEvidenceStatus }
      : {}),
    ...(persisted.truncation ? { truncation: persisted.truncation } : {})
  }
}
