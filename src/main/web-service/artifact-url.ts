import type { OpenArtifactInBrowserRequest } from '../../shared/artifacts'
import { loadOrCreateWebToken } from './auth'

export const buildAuthenticatedArtifactContentUrl = async (
  configRoot: string,
  port: number,
  { artifactId, projectId, versionId }: OpenArtifactInBrowserRequest
): Promise<string> => {
  const token = await loadOrCreateWebToken(configRoot)
  return `http://127.0.0.1:${port}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content?disposition=inline&projectId=${encodeURIComponent(projectId)}&versionId=${encodeURIComponent(versionId)}&token=${encodeURIComponent(token)}`
}
