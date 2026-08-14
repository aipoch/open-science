type AgentArtifactVersionProvenance = {
  originKind: 'agent_generated'
  artifactRunId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  evidenceStorageKey: string
  evidenceJson: string
  evidenceChecksum: string
  evidenceSchemaVersion: number
}

type ArtifactVersionWithNullableAgentProvenance = {
  originKind: string
  artifactRunId: string | null
  rootFrameId: string | null
  agentFrameId: string | null
  messageBranchId: string | null
  runtimeSegmentId: string | null
  promptMessageId: string | null
  evidenceStorageKey: string | null
  evidenceJson: string | null
  evidenceChecksum: string | null
  evidenceSchemaVersion: number | null
}

const requireAgentArtifactVersion = <T extends ArtifactVersionWithNullableAgentProvenance>(
  version: T
): T & AgentArtifactVersionProvenance => {
  if (
    version.originKind !== 'agent_generated' ||
    !version.artifactRunId ||
    !version.rootFrameId ||
    !version.agentFrameId ||
    !version.messageBranchId ||
    !version.runtimeSegmentId ||
    !version.promptMessageId ||
    !version.evidenceStorageKey ||
    !version.evidenceJson ||
    !version.evidenceChecksum ||
    version.evidenceSchemaVersion === null
  ) {
    throw new Error('Artifact Version does not contain complete Agent provenance.')
  }
  return version as T & AgentArtifactVersionProvenance
}

export {
  requireAgentArtifactVersion,
  type AgentArtifactVersionProvenance,
  type ArtifactVersionWithNullableAgentProvenance
}
