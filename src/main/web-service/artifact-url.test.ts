import { describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({
  loadOrCreateWebToken: vi.fn().mockResolvedValue('long-lived-token')
}))

import { loadOrCreateWebToken } from './auth'
import { buildAuthenticatedArtifactContentUrl } from './artifact-url'

describe('buildAuthenticatedArtifactContentUrl', () => {
  it('uses the current local Web service and existing token without project scope', async () => {
    const url = await buildAuthenticatedArtifactContentUrl('/config', 44123, {
      artifactId: 'artifact/html 1',
      projectId: 'project/1',
      versionNumber: 2
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('http://127.0.0.1:44123')
    expect(parsed.pathname).toBe('/api/v1/artifacts/artifact%2Fhtml%201/content')
    expect(parsed.searchParams.get('disposition')).toBe('inline')
    expect(parsed.searchParams.get('token')).toBe('long-lived-token')
    expect(parsed.searchParams.get('version')).toBe('2')
    expect(parsed.searchParams.get('projectId')).toBeNull()
    expect(parsed.searchParams.get('versionId')).toBeNull()
    expect(parsed.searchParams.get('binding')).toBeNull()
    expect(loadOrCreateWebToken).toHaveBeenCalledWith('/config')
  })

  it('omits versionId so the server resolves the latest version', async () => {
    const url = await buildAuthenticatedArtifactContentUrl('/config-latest', 44123, {
      artifactId: 'artifact-latest',
      projectId: 'project-latest'
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('version')).toBeNull()
    expect(parsed.searchParams.get('projectId')).toBeNull()
    expect(parsed.searchParams.get('versionId')).toBeNull()
    expect(parsed.searchParams.get('binding')).toBeNull()
  })
})
