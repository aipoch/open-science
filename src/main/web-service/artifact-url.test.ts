import { describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({
  loadOrCreateWebToken: vi.fn().mockResolvedValue('long-lived-token')
}))

import { loadOrCreateWebToken } from './auth'
import { buildAuthenticatedArtifactContentUrl } from './artifact-url'

describe('buildAuthenticatedArtifactContentUrl', () => {
  it('uses the current local Web service and the existing token', async () => {
    await expect(
      buildAuthenticatedArtifactContentUrl('/config', 44123, {
        artifactId: 'artifact/html 1',
        projectId: 'project/1',
        versionId: 'version 2'
      })
    ).resolves.toBe(
      'http://127.0.0.1:44123/api/v1/artifacts/artifact%2Fhtml%201/content?disposition=inline&projectId=project%2F1&versionId=version%202&token=long-lived-token'
    )
    expect(loadOrCreateWebToken).toHaveBeenCalledWith('/config')
  })
})
