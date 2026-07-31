import { describe, expect, it, vi } from 'vitest'

import { createArtifactVersionLocator } from '../shared/artifact-provenance'
import { createSessionArtifactFileResolver } from './session-artifact-file-resolver'

describe('Session Artifact file resolver', () => {
  it('rejects an Artifact Version locator owned by a different Source Session', async () => {
    const resolveVersionContent = vi.fn().mockResolvedValue({ path: '/managed/report.csv' })
    const resolveLegacyArtifactPath = vi.fn().mockResolvedValue('/managed/legacy.csv')
    const resolve = createSessionArtifactFileResolver({
      compatibilityProjectName: 'default-project',
      resolveVersionContent,
      resolveLegacyArtifactPath
    })
    const locator = createArtifactVersionLocator({
      projectId: 'project-1',
      appSessionId: 'session-2',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    })

    await expect(resolve('project-1', 'session-1', locator)).rejects.toThrow(
      'Artifact Version belongs to a different Source Session.'
    )
    expect(resolveVersionContent).not.toHaveBeenCalled()
    expect(resolveLegacyArtifactPath).not.toHaveBeenCalled()
  })

  it('resolves a matching immutable Artifact Version', async () => {
    const resolveVersionContent = vi.fn().mockResolvedValue({ path: '/managed/report.csv' })
    const resolveLegacyArtifactPath = vi.fn()
    const resolve = createSessionArtifactFileResolver({
      compatibilityProjectName: 'default-project',
      resolveVersionContent,
      resolveLegacyArtifactPath
    })
    const locator = createArtifactVersionLocator({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    })

    await expect(resolve('project-1', 'session-1', locator)).resolves.toBe('/managed/report.csv')
    expect(resolveVersionContent).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    })
    expect(resolveLegacyArtifactPath).not.toHaveBeenCalled()
  })

  it('delegates a legacy Artifact path to the Session-scoped repository resolver', async () => {
    const resolveVersionContent = vi.fn()
    const resolveLegacyArtifactPath = vi.fn().mockResolvedValue('/managed/legacy.csv')
    const resolve = createSessionArtifactFileResolver({
      compatibilityProjectName: 'default-project',
      resolveVersionContent,
      resolveLegacyArtifactPath
    })

    await expect(
      resolve('project-1', 'session-1', '/managed/project-1/session-1/legacy.csv')
    ).resolves.toBe('/managed/legacy.csv')
    expect(resolveLegacyArtifactPath).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      '/managed/project-1/session-1/legacy.csv'
    )
    expect(resolveVersionContent).not.toHaveBeenCalled()
  })

  it('falls back to the compatibility Project namespace for migrated legacy Artifacts', async () => {
    const resolveVersionContent = vi.fn()
    const resolveLegacyArtifactPath = vi
      .fn()
      .mockRejectedValueOnce(new Error('outside requested Project'))
      .mockResolvedValueOnce('/managed/default-project/session-1/legacy.csv')
    const resolve = createSessionArtifactFileResolver({
      compatibilityProjectName: 'default-project',
      resolveVersionContent,
      resolveLegacyArtifactPath
    })
    const path = '/managed/default-project/session-1/legacy.csv'

    await expect(resolve('project-1', 'session-1', path)).resolves.toBe(path)
    expect(resolveLegacyArtifactPath.mock.calls).toEqual([
      ['project-1', 'session-1', path],
      ['default-project', 'session-1', path]
    ])
    expect(resolveVersionContent).not.toHaveBeenCalled()
  })
})
