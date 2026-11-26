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

// Independent image tasks have a real Session/branch owner, but no chat prompt or runtime segment.
const requireGeneratedArtifactVersion = <T extends ArtifactVersionWithNullableAgentProvenance>(
  version: T
): T & Omit<AgentArtifactVersionProvenance, 'promptMessageId' | 'runtimeSegmentId'> => {
  if (version.promptMessageId || version.runtimeSegmentId)
    return requireAgentArtifactVersion(version)
  const evidence = version.evidenceJson ? JSON.parse(version.evidenceJson) : undefined
  if (
    version.originKind !== 'agent_generated' ||
    !version.artifactRunId ||
    !version.rootFrameId ||
    !version.agentFrameId ||
    !version.messageBranchId ||
    !version.evidenceStorageKey ||
    !version.evidenceChecksum ||
    version.evidenceSchemaVersion !== 1 ||
    typeof evidence?.image_task_id !== 'string' ||
    evidence.image_task_id !== version.artifactRunId ||
    evidence?.producer?.kind !== 'connector' ||
    evidence.producer.connector_id !== 'image-model'
  )
    throw new Error('Artifact Version does not contain complete image task provenance.')
  return version as T & Omit<AgentArtifactVersionProvenance, 'promptMessageId' | 'runtimeSegmentId'>
}
export { requireGeneratedArtifactVersion }
