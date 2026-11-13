import { describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({
  loadOrCreateWebToken: vi.fn().mockResolvedValue('long-lived-token')
}))

import { loadOrCreateWebToken } from './auth'
import {
  buildAuthenticatedArtifactContentUrl,
  resolveAuthenticatedArtifactBrowserBinding
} from './artifact-url'

describe('buildAuthenticatedArtifactContentUrl', () => {
  it('uses the current local Web service and the existing token', async () => {
    await expect(
      buildAuthenticatedArtifactContentUrl('/config', 44123, {
        artifactId: 'artifact/html 1',
        projectId: 'project/1',
        versionId: 'version 2'
      })
    ).resolves.toBe(
      'http://127.0.0.1:44123/api/v1/artifacts/artifact%2Fhtml%201/content?disposition=inline&token=long-lived-token'
    )
    expect(loadOrCreateWebToken).toHaveBeenCalledWith('/config')
    expect(
      resolveAuthenticatedArtifactBrowserBinding('/config', 'long-lived-token', 'artifact/html 1')
    ).toEqual({
      projectId: 'project/1',
      versionId: 'version 2'
    })
  })

  it('allows the server to resolve the latest version when no version is selected', async () => {
    await expect(
      buildAuthenticatedArtifactContentUrl('/config-latest', 44123, {
        artifactId: 'artifact-latest',
        projectId: 'project-latest'
      })
    ).resolves.toBe(
      'http://127.0.0.1:44123/api/v1/artifacts/artifact-latest/content?disposition=inline&token=long-lived-token'
    )
    expect(
      resolveAuthenticatedArtifactBrowserBinding(
        '/config-latest',
        'long-lived-token',
        'artifact-latest'
      )
    ).toEqual({ projectId: 'project-latest' })
  })
})
