export type ArtifactVersionIdentity = {
  projectId: string
  appSessionId: string
  artifactId: string
  versionId: string
  cursor?: string
}

const ARTIFACT_VERSION_LOCATOR_PREFIX = 'artifact-version:'

// Renderer state persists this opaque, root-independent identity instead of a local filesystem path.
// Main parses it and resolves the immutable Version through SQLite after every data-root migration.
export const createArtifactVersionLocator = (identity: ArtifactVersionIdentity): string =>
  `${ARTIFACT_VERSION_LOCATOR_PREFIX}${[
    identity.projectId,
    identity.appSessionId,
    identity.artifactId,
    identity.versionId
  ]
    .map(encodeURIComponent)
    .join('/')}`

export const parseArtifactVersionLocator = (value: string): ArtifactVersionIdentity | undefined => {
  if (!value.startsWith(ARTIFACT_VERSION_LOCATOR_PREFIX)) return undefined
  const parts = value.slice(ARTIFACT_VERSION_LOCATOR_PREFIX.length).split('/')
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) return undefined

  try {
    const [projectId, appSessionId, artifactId, versionId] = parts.map(decodeURIComponent)
    if (!projectId || !appSessionId || !artifactId || !versionId) return undefined
    return { projectId, appSessionId, artifactId, versionId }
  } catch {
    return undefined
  }
}
