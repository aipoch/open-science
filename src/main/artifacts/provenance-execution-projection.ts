import type {
  ArtifactExecutionSnapshot,
  PersistedArtifactExecutionSnapshot,
  ProvenanceExecutionInputFile
} from '../../shared/artifact-provenance'

export const projectPublicArtifactExecutionSnapshot = (
  persisted: PersistedArtifactExecutionSnapshot,
  inputFiles: ProvenanceExecutionInputFile[]
): ArtifactExecutionSnapshot => {
  const { helperModules, ...withoutPrivateHelpers } = persisted
  return {
    ...withoutPrivateHelpers,
    inputFiles,
    ...(helperModules
      ? {
          helperModules: helperModules.map((helper) => ({
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
      : {})
  }
}
