import type { OpenArtifactInBrowserRequest } from '../../shared/artifacts'
import { loadOrCreateWebToken } from './auth'

const ARTIFACT_BROWSER_BINDING_TTL_MS = 10 * 60 * 1_000

type ArtifactBrowserBinding = Pick<OpenArtifactInBrowserRequest, 'projectId' | 'versionId'>

const artifactBrowserBindings = new Map<
  string,
  { binding: ArtifactBrowserBinding; expiresAt: number }
>()

const artifactBrowserBindingKey = (configRoot: string, token: string, artifactId: string): string =>
  `${configRoot}\u0000${token}\u0000${artifactId}`

export const registerAuthenticatedArtifactBrowserBinding = (
  configRoot: string,
  token: string,
  request: OpenArtifactInBrowserRequest
): void => {
  artifactBrowserBindings.set(artifactBrowserBindingKey(configRoot, token, request.artifactId), {
    binding: { projectId: request.projectId, versionId: request.versionId },
    expiresAt: Date.now() + ARTIFACT_BROWSER_BINDING_TTL_MS
  })
}

export const resolveAuthenticatedArtifactBrowserBinding = (
  configRoot: string,
  token: string,
  artifactId: string
): ArtifactBrowserBinding | undefined => {
  const key = artifactBrowserBindingKey(configRoot, token, artifactId)
  const entry = artifactBrowserBindings.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    artifactBrowserBindings.delete(key)
    return undefined
  }
  return entry.binding
}

export const buildAuthenticatedArtifactContentUrl = async (
  configRoot: string,
  port: number,
  { artifactId, projectId, versionId }: OpenArtifactInBrowserRequest
): Promise<string> => {
  const token = await loadOrCreateWebToken(configRoot)
  registerAuthenticatedArtifactBrowserBinding(configRoot, token, {
    artifactId,
    projectId,
    versionId
  })
  return `http://127.0.0.1:${port}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content?disposition=inline&token=${encodeURIComponent(token)}`
}
