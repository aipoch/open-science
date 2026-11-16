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
    const url = await buildAuthenticatedArtifactContentUrl('/config', 44123, {
      artifactId: 'artifact/html 1',
      projectId: 'project/1',
      versionId: 'version 2'
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe('http://127.0.0.1:44123')
    expect(parsed.pathname).toBe('/api/v1/artifacts/artifact%2Fhtml%201/content')
    expect(parsed.searchParams.get('disposition')).toBe('inline')
    expect(parsed.searchParams.get('token')).toBe('long-lived-token')
    const bindingId = parsed.searchParams.get('binding')
    expect(bindingId).toBeTruthy()
    expect(
      resolveAuthenticatedArtifactBrowserBinding('/config', 'long-lived-token', bindingId!)
    ).toEqual({
      artifactId: 'artifact/html 1',
      projectId: 'project/1',
      versionId: 'version 2'
    })
    expect(
      resolveAuthenticatedArtifactBrowserBinding('/config', 'long-lived-token', 'different')
    ).toBeUndefined()
    expect(loadOrCreateWebToken).toHaveBeenCalledWith('/config')
  })

  it('keeps bindings independent for multiple versions of one artifact', async () => {
    const first = new URL(
      await buildAuthenticatedArtifactContentUrl('/config-multi', 44123, {
        artifactId: 'artifact-1',
        projectId: 'project-1',
        versionId: 'version-1'
      })
    )
    const second = new URL(
      await buildAuthenticatedArtifactContentUrl('/config-multi', 44123, {
        artifactId: 'artifact-1',
        projectId: 'project-1',
        versionId: 'version-2'
      })
    )

    expect(first.searchParams.get('binding')).not.toBe(second.searchParams.get('binding'))
    expect(
      resolveAuthenticatedArtifactBrowserBinding(
        '/config-multi',
        'long-lived-token',
        first.searchParams.get('binding')!
      )
    ).toMatchObject({ versionId: 'version-1' })
    expect(
      resolveAuthenticatedArtifactBrowserBinding(
        '/config-multi',
        'long-lived-token',
        second.searchParams.get('binding')!
      )
    ).toMatchObject({ versionId: 'version-2' })
  })

  it('expires bindings instead of falling back to the latest version', async () => {
    vi.useFakeTimers()
    try {
      const url = new URL(
        await buildAuthenticatedArtifactContentUrl('/config-expiry', 44123, {
          artifactId: 'artifact-expiry',
          projectId: 'project-expiry',
          versionId: 'version-expiry'
        })
      )
      vi.advanceTimersByTime(10 * 60 * 1_000)
      expect(
        resolveAuthenticatedArtifactBrowserBinding(
          '/config-expiry',
          'long-lived-token',
          url.searchParams.get('binding')!
        )
      ).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows the server to resolve the latest version when no version is selected', async () => {
    const url = await buildAuthenticatedArtifactContentUrl('/config-latest', 44123, {
      artifactId: 'artifact-latest',
      projectId: 'project-latest'
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('versionId')).toBeNull()
    expect(
      resolveAuthenticatedArtifactBrowserBinding(
        '/config-latest',
        'long-lived-token',
        parsed.searchParams.get('binding')!
      )
    ).toEqual({ artifactId: 'artifact-latest', projectId: 'project-latest' })
  })
})
