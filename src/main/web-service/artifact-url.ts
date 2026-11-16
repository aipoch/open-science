import type { OpenArtifactInBrowserRequest } from '../../shared/artifacts'
import { randomUUID } from 'node:crypto'
import { loadOrCreateWebToken } from './auth'

const ARTIFACT_BROWSER_BINDING_TTL_MS = 10 * 60 * 1_000

export type ArtifactBrowserBinding = Pick<
  OpenArtifactInBrowserRequest,
  'artifactId' | 'projectId' | 'versionId'
>

const artifactBrowserBindings = new Map<
  string,
  { binding: ArtifactBrowserBinding; expiresAt: number }
>()

const artifactBrowserBindingKey = (configRoot: string, token: string, bindingId: string): string =>
  `${configRoot}\u0000${token}\u0000${bindingId}`

export const registerAuthenticatedArtifactBrowserBinding = (
  configRoot: string,
  token: string,
  request: OpenArtifactInBrowserRequest,
  bindingId = randomUUID()
): string => {
  artifactBrowserBindings.set(artifactBrowserBindingKey(configRoot, token, bindingId), {
    binding: {
      artifactId: request.artifactId,
      projectId: request.projectId,
      versionId: request.versionId
    },
    expiresAt: Date.now() + ARTIFACT_BROWSER_BINDING_TTL_MS
  })
  return bindingId
}

export const resolveAuthenticatedArtifactBrowserBinding = (
  configRoot: string,
  token: string,
  bindingId: string
): ArtifactBrowserBinding | undefined => {
  const key = artifactBrowserBindingKey(configRoot, token, bindingId)
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
  const bindingId = registerAuthenticatedArtifactBrowserBinding(configRoot, token, {
    artifactId,
    projectId,
    versionId
  })
  return `http://127.0.0.1:${port}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content?disposition=inline&token=${encodeURIComponent(token)}&binding=${encodeURIComponent(bindingId)}`
}
