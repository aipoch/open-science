// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ImagePreviewRenderer } from './ImagePreview'

describe('ImagePreviewRenderer', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'image-resource',
          url: 'open-science-preview://image-resource/chart.png',
          size: 10,
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
    container.remove()
  })

  it('acquires the current managed Artifact head when the item has no explicit version', async () => {
    await act(async () => {
      root.render(
        <ImagePreviewRenderer
          item={{
            id: 'artifact-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            title: 'chart.png',
            type: 'file',
            source: 'artifact',
            path: '/stale/projection/chart.png',
            name: 'chart.png',
            format: 'image',
            managedFileId: 'artifact-1'
          }}
        />
      )
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/stale/projection/chart.png',
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'artifact-1'
    })
  })
})
