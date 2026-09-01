// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactPreview } from './artifact-preview'
import { createCachedImageFetchResponse } from './previews/cached-preview-image.test-support'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type PreviewArtifact = React.ComponentProps<typeof ArtifactPreview>['artifact']

const imageArtifact: PreviewArtifact = {
  id: 'artifact-chart',
  kind: 'managed-file',
  path: '/workspace/chart.png',
  fileUrl: 'file:///workspace/chart.png',
  name: 'chart.png',
  mimeType: 'image/png',
  size: 2048,
  mtimeMs: 1710000000100
}

describe('ArtifactPreview image lifecycle', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createCachedImageFetchResponse()))
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:cached-transcript-chart')
        static revokeObjectURL = vi.fn()
      }
    )
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-chart',
          url: 'open-science-preview://resource/resource-chart',
          size: 2048,
          mimeType: 'image/png',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
    container.remove()
  })

  it('reuses a transcript image after its Session is switched away and back', async () => {
    const renderImage = async (): Promise<void> => {
      await act(async () => {
        root.render(
          <ArtifactPreview
            artifact={imageArtifact}
            projectId="project-1"
            sessionId="session-1"
            managedFileId="artifact-chart"
          />
        )
      })
      await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    }

    root = createRoot(container)
    await renderImage()
    await act(async () => {
      root.render(
        <ArtifactPreview
          artifact={imageArtifact}
          projectId="project-1"
          sessionId="session-1"
          managedFileId="artifact-chart"
          isVisible={false}
        />
      )
    })
    await act(async () => root.render(<div />))
    await renderImage()

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
  })
})
