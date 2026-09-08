import type {
  ArtifactExecutionSnapshot,
  PersistedArtifactExecutionSnapshot,
  ProvenanceExecutionInputFile
} from '../../shared/artifact-provenance'
import { projectArtifactReproducibility } from './provenance-reproducibility-projection'

export const projectPublicArtifactExecutionSnapshot = (
  persisted: PersistedArtifactExecutionSnapshot,
  inputFiles: ProvenanceExecutionInputFile[]
): ArtifactExecutionSnapshot => {
  const reproducibility = persisted.provenanceGraph
    ? projectArtifactReproducibility(persisted.provenanceGraph, persisted.runs)
    : undefined
  if (reproducibility) {
    const recipe = persisted.reproducibilityRecipe
    const captureCheckReasonCodes = recipe?.capture.reasonCodes ?? ['compute-recipe-unavailable']
    reproducibility.checkReasonCodes = captureCheckReasonCodes
    reproducibility.startFrontiers = reproducibility.startFrontiers.map((frontier) => {
      const recipeFrontier = recipe?.frontiers.find(
        (candidate) => candidate.frontierId === frontier.frontierId
      )
      const executable =
        recipe?.capture.state === 'sealed' &&
        recipeFrontier !== undefined &&
        recipeFrontier.reasonCodes.length === 0 &&
        recipeFrontier.stepIds.length > 0
      return {
        ...frontier,
        crossingEntityIds: [
          ...new Set([
            ...frontier.crossingEntityIds,
            ...(recipeFrontier?.crossingFiles.map((file) => file.entityId) ?? [])
          ])
        ],
        eligibility: executable ? 'available' : 'blocked',
        checkReasonCodes: recipeFrontier?.reasonCodes ?? captureCheckReasonCodes,
        ...(recipeFrontier
          ? {
              unavailableEntityIds: frontier.crossingEntityIds.filter(
                (entityId) =>
                  !recipeFrontier.crossingFiles.some((file) => file.entityId === entityId)
              )
            }
          : {})
      }
    })
  }
  return {
    schemaVersion: persisted.schemaVersion,
    rootFrameId: persisted.rootFrameId,
    agentFrameId: persisted.agentFrameId,
    messageBranchId: persisted.messageBranchId,
    terminalPromptMessageId: persisted.terminalPromptMessageId,
    producerRunId: persisted.producerRunId,
    producerRunIndex: persisted.producerRunIndex,
    createdAt: persisted.createdAt,
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
