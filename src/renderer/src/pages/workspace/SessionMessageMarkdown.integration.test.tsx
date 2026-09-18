// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

import { SessionMessageMarkdown } from './SessionMessageMarkdown'
import { createCachedImageFetchResponse } from './previews/cached-preview-image.test-support'
import type { MessageArtifact } from './session-message-artifact-reference'

const artifact: MessageArtifact = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 1,
  isPublished: true,
  kind: 'managed-file',
  path: '/managed/session/chart.png',
  name: 'chart.png',
  mimeType: 'image/png',
  size: 1024,
  mtimeMs: 1710000000000,
  resolvedProjectId: 'project-1',
  resolvedSessionId: 'session-1'
}

describe('SessionMessageMarkdown integration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createCachedImageFetchResponse()))
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:inline-chart')
        static revokeObjectURL = vi.fn()
      }
    )
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      isLoaded: true,
      notebookNetwork: {
        allowedDomains: ['example.com'],
        disabledOpenScienceDomainGroups: [],
        disabledOpenScienceDomains: []
      }
    })
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-1',
          url: 'open-science-preview://resource-1/chart.png',
          size: 1024,
          mimeType: 'image/png',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('preserves an HTTPS source title through the message artifact link renderer', async () => {
    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content={
            'The evidence supports this claim ([Torre et al. 2026](https://example.com/paper "Genome study")).'
          }
          artifacts={[]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    expect(sourceLink?.textContent).toContain('Torre et al. 2026')

    await act(async () => {
      sourceLink?.click()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      title: 'Genome study',
      url: 'https://example.com/paper'
    })
  })

  it('renders a message Artifact image instead of exposing its custom tag', async () => {
    const content =
      'Created the chart.\n\n<session-artifact-image artifact_ref="version-1" alt_text="Chart"></session-artifact-image>'

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content={content}
          artifacts={[artifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Created the chart.')
    expect(container.textContent).not.toContain('<session-artifact-image')
    expect(container.querySelector('[data-session-artifact-image] img')?.getAttribute('src')).toBe(
      'blob:inline-chart'
    )
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'version-1',
      mimeType: 'image/png'
    })
  })

  it('updates an unchanged Markdown image and link when its Artifact is published', async () => {
    const content = '![Chart](chart.png)\n\n[chart.png](chart.png)'
    const onPreview = vi.fn()
    const render = async (isPublished: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          <SessionMessageMarkdown
            content={content}
            artifacts={[{ ...artifact, isPublished }]}
            onPreviewArtifact={onPreview}
            onPreviewArtifactModal={onPreview}
          />
        )
      })
    }
    await render(false)
    expect(container.querySelector('[data-session-artifact-image-status]')).not.toBeNull()
    expect(
      container.querySelector<HTMLButtonElement>('[data-session-artifact-link]')?.disabled
    ).toBe(true)
    await render(true)
    expect(
      container.querySelector<HTMLButtonElement>('[data-session-artifact-link]')?.disabled
    ).toBe(false)
    expect(container.querySelector('[data-session-artifact-image] img')).not.toBeNull()
  })

  it('uses current preview handlers without remounting an unchanged image', async () => {
    const artifacts = [artifact]
    const previousPreview = vi.fn()
    const currentPreview = vi.fn()
    const render = async (onPreview: typeof currentPreview): Promise<void> => {
      await act(async () => {
        root.render(
          <SessionMessageMarkdown
            content={'![Chart](chart.png)\n\n[chart.png](chart.png)'}
            artifacts={artifacts}
            onPreviewArtifact={onPreview}
            onPreviewArtifactModal={onPreview}
          />
        )
      })
    }
    await render(previousPreview)
    const image = container.querySelector('[data-session-artifact-image] img')
    expect(image).not.toBeNull()
    await render(currentPreview)
    expect(container.querySelector('[data-session-artifact-image] img')).toBe(image)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-session-artifact-link]')?.click()
      container.querySelector<HTMLButtonElement>('[data-session-artifact-image]')?.click()
    })
    expect(previousPreview).not.toHaveBeenCalled()
    expect(currentPreview).toHaveBeenCalledTimes(2)
    expect(currentPreview).toHaveBeenLastCalledWith(artifact)
  })
})
