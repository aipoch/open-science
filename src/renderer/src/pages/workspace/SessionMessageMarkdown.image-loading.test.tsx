// @vitest-environment jsdom
import { act, type ElementType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionMessageMarkdown } from './SessionMessageMarkdown'
import { createCachedImageFetchResponse } from './previews/cached-preview-image.test-support'
import type { MessageArtifact } from './session-message-artifact-reference'

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  PresentedAgentMarkdown: ({ components }: { components: Record<string, ElementType> }) => {
    const Image = components['session-artifact-image']
    return <Image artifact_ref="version-1" alt_text="Group distribution" />
  }
}))
vi.mock('./artifact-preview', () => ({ ArtifactPreview: () => null }))

const artifact: MessageArtifact = {
  id: 'version-1',
  versionId: 'version-1',
  artifactId: 'inline-publication-image',
  kind: 'managed-file',
  isPublished: true,
  path: '/managed/group_bar_r.png',
  name: 'group_bar_r.png',
  mimeType: 'image/png',
  size: 1024,
  resolvedProjectId: 'project-1',
  resolvedSessionId: 'session-1'
}

describe('message image resource loading', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createCachedImageFetchResponse()))
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:message-image')
        static revokeObjectURL = vi.fn()
      }
    )
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'inline-resource',
          url: 'open-science-preview://inline-resource/group_bar_r.png',
          size: 1024,
          mimeType: 'image/png',
          version: 1,
          width: 600,
          height: 450
        }),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const render = async (image: MessageArtifact): Promise<void> => {
    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Group distribution](group_bar_r.png)"
          artifacts={[image]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })
  }

  it('recovers from a publication race without a metadata change or remount', async () => {
    vi.mocked(window.api.previewResources.acquire).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'preview-resources:acquire': Managed file has no published version."
      )
    )
    await render(artifact)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy()
    expect(container.querySelector('[data-state="error"]')).toBeNull()
    expect(window.api.previewResources.acquire).toHaveBeenLastCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: artifact.artifactId,
      versionId: 'version-1',
      mimeType: 'image/png'
    })
  })

  it('reuses loaded image bytes on transcript remount and preserves header dimensions', async () => {
    await render({ ...artifact, artifactId: 'inline-remount-image' })
    const image = container.querySelector('img')!
    expect(image?.getAttribute('src')).toBe('blob:message-image')
    expect(image.getAttribute('width')).toBe('600')
    expect(image.getAttribute('height')).toBe('450')
    await act(async () => {
      root.render(null)
    })
    await render({ ...artifact, artifactId: 'inline-remount-image' })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:message-image')
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'inline-resource'
    })
  })

  it('does not retry missing files as publication delays', async () => {
    vi.mocked(window.api.previewResources.acquire).mockRejectedValue(
      new Error('ENOENT: no such file')
    )
    await render({ ...artifact, artifactId: 'inline-missing-image' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
  })
})
