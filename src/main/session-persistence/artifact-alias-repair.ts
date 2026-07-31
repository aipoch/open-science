import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'

const canonicalArtifactAliases = (artifacts: readonly PersistedArtifact[]): Map<string, string> => {
  const canonicalIdsByVersion = new Map<string, string>()
  for (const artifact of artifacts) {
    if (artifact.versionId && artifact.id === artifact.versionId) {
      canonicalIdsByVersion.set(artifact.versionId, artifact.id)
    }
  }

  const aliases = new Map<string, string>()
  for (const artifact of artifacts) {
    if (!artifact.versionId) continue
    const canonicalId = canonicalIdsByVersion.get(artifact.versionId)
    if (canonicalId && artifact.id !== canonicalId) aliases.set(artifact.id, canonicalId)
  }
  return aliases
}

const rewriteArtifactIds = (
  artifactIds: string[] | undefined,
  aliases: ReadonlyMap<string, string>
): string[] | undefined => {
  if (!artifactIds) return undefined

  const seen = new Set<string>()
  const rewritten: string[] = []
  let changed = false
  for (const artifactId of artifactIds) {
    const canonicalId = aliases.get(artifactId) ?? artifactId
    if (canonicalId !== artifactId || seen.has(canonicalId)) changed = true
    if (seen.has(canonicalId)) continue
    seen.add(canonicalId)
    rewritten.push(canonicalId)
  }
  return changed ? rewritten : artifactIds
}

// Repairs one historical projection bug: a message-scoped compatibility descriptor could be saved
// beside the native immutable Artifact Version descriptor. The Version is the authority, so the
// repair removes only its duplicate alias and rewrites references to the same Version id. Message
// content/timestamps and Artifact Version content/metadata are never recomputed or deleted.
const repairHistoricalArtifactAliases = (
  session: PersistedChatSession,
  options: { advanceFilesRevision?: boolean } = {}
): PersistedChatSession => {
  const artifacts = session.artifacts ?? []
  const aliases = canonicalArtifactAliases(artifacts)
  if (aliases.size === 0) return session

  const messages = session.messages.map((message) => {
    const artifactIds = rewriteArtifactIds(message.artifactIds, aliases)
    return artifactIds === message.artifactIds ? message : { ...message, artifactIds }
  })
  const conversationGraph = session.conversationGraph
    ? {
        ...session.conversationGraph,
        messages: session.conversationGraph.messages.map((message) => {
          const artifactIds = rewriteArtifactIds(message.artifactIds, aliases)
          return artifactIds === message.artifactIds ? message : { ...message, artifactIds }
        })
      }
    : undefined

  return {
    ...session,
    artifacts: artifacts.filter((artifact) => !aliases.has(artifact.id)),
    messages,
    conversationGraph,
    filesRevision:
      options.advanceFilesRevision === false
        ? session.filesRevision
        : (session.filesRevision ?? 0) + 1
  }
}

export { repairHistoricalArtifactAliases }
