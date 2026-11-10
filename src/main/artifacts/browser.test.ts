import { describe, expect, it, vi } from 'vitest'

import { createArtifactBrowserOpener } from './browser'

describe('createArtifactBrowserOpener', () => {
  it('opens the authenticated URL for the selected artifact on the current service port', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const buildUrl = vi
      .fn()
      .mockResolvedValue(
        'http://127.0.0.1:44123/api/v1/artifacts/artifact-1/content?disposition=inline&projectId=project-1&versionId=version-2&token=token'
      )
    const opener = createArtifactBrowserOpener({
      resolveConfigRoot: () => '/isolated/config',
      readWebServiceState: vi.fn().mockResolvedValue({ port: 44123 }),
      buildUrl,
      openExternal
    })

    await opener({ artifactId: 'artifact-1', projectId: 'project-1', versionId: 'version-2' })

    expect(buildUrl).toHaveBeenCalledWith('/isolated/config', 44123, {
      artifactId: 'artifact-1',
      projectId: 'project-1',
      versionId: 'version-2'
    })
    expect(openExternal).toHaveBeenCalledWith(
      'http://127.0.0.1:44123/api/v1/artifacts/artifact-1/content?disposition=inline&projectId=project-1&versionId=version-2&token=token'
    )
  })

  it('reports a stopped local Web service without invoking the browser', async () => {
    const openExternal = vi.fn()
    const opener = createArtifactBrowserOpener({
      resolveConfigRoot: () => '/isolated/config',
      readWebServiceState: vi.fn().mockResolvedValue(undefined),
      openExternal
    })

    await expect(
      opener({ artifactId: 'artifact-1', projectId: 'project-1', versionId: 'version-2' })
    ).rejects.toThrow('local Web service is not running')
    expect(openExternal).not.toHaveBeenCalled()
  })
})
