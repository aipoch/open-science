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
