import type { OpenArtifactInBrowserRequest } from '../../shared/artifacts'
import { loadOrCreateWebToken } from './auth'

export const buildAuthenticatedArtifactContentUrl = async (
  configRoot: string,
  port: number,
  { artifactId, versionNumber }: OpenArtifactInBrowserRequest
): Promise<string> => {
  const token = await loadOrCreateWebToken(configRoot)
  const params = new URLSearchParams({ disposition: 'inline', token })
  if (versionNumber !== undefined) params.set('version', String(versionNumber))
  return `http://127.0.0.1:${port}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content?${params.toString()}`
}
