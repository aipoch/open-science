import { parseArtifactVersionLocator } from '../shared/artifact-provenance'

type SessionArtifactFileResolverDependencies = {
  compatibilityProjectName: string
  resolveVersionContent: (
    identity: NonNullable<ReturnType<typeof parseArtifactVersionLocator>>
  ) => Promise<{ path: string }>
  resolveLegacyArtifactPath: (
    projectName: string,
    sessionId: string,
    path: string
  ) => Promise<string>
}

type SessionArtifactFileResolver = (
  projectId: string,
  sessionId: string,
  path: string
) => Promise<string>

// Native versions carry their Project and Source Session identity. Legacy files may live under the
// active Project namespace or the pre-migration compatibility namespace; both remain Session-bound.
const createSessionArtifactFileResolver =
  (dependencies: SessionArtifactFileResolverDependencies): SessionArtifactFileResolver =>
  async (projectId, sessionId, path) => {
    const versionIdentity = parseArtifactVersionLocator(path)
    if (!versionIdentity) {
      try {
        return await dependencies.resolveLegacyArtifactPath(projectId, sessionId, path)
      } catch (projectError) {
        if (projectId === dependencies.compatibilityProjectName) throw projectError
        return dependencies.resolveLegacyArtifactPath(
          dependencies.compatibilityProjectName,
          sessionId,
          path
        )
      }
    }
    if (versionIdentity.projectId !== projectId || versionIdentity.appSessionId !== sessionId) {
      throw new Error('Artifact Version belongs to a different Source Session.')
    }
    return dependencies.resolveVersionContent(versionIdentity).then((resolved) => resolved.path)
  }

export { createSessionArtifactFileResolver }
export type { SessionArtifactFileResolver, SessionArtifactFileResolverDependencies }
