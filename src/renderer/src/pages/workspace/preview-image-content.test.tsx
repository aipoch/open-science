// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewUnsupportedContent } from './previews/PreviewFallback'
import { PreviewImageContent } from './previews/renderers/ImagePreview'

describe('PreviewUnsupportedContent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      artifacts: {
        openFile: vi.fn().mockResolvedValue(undefined),
        readPreview: vi.fn(),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('shows the fallback message and opens the file externally on request', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewUnsupportedContent path="/workspace/report.pdf" name="report.pdf" />)
    })

    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).toContain("This file type isn't supported for preview")

    const openButton = container.querySelector('button')
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.api.artifacts.openFile).toHaveBeenCalledWith({ path: '/workspace/report.pdf' })
  })
})

describe('PreviewImageContent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'resource-1',
          url: 'open-science-preview://resource-1/photo.png',
          size: 40 * 1024 * 1024,
          mimeType: 'image/png',
          version: 1
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        openFile: vi.fn().mockResolvedValue(undefined),
        readPreview: vi.fn(),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('shows a loading state before resource acquisition resolves', async () => {
    let resolveAcquire:
      | ((value: Awaited<ReturnType<Window['api']['previewResources']['acquire']>>) => void)
      | undefined
    vi.mocked(window.api.previewResources.acquire).mockReturnValue(
      new Promise((resolve) => {
        resolveAcquire = resolve
      })
    )

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    expect(container.querySelector('.animate-spin')).not.toBeNull()

    await act(async () => {
      resolveAcquire?.({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/photo.png',
        size: 40 * 1024 * 1024,
        mimeType: 'image/png',
        version: 1
      })
    })
  })

  it('renders an arbitrarily large image from the managed stream URL', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('open-science-preview://resource-1/photo.png')
    expect(image?.getAttribute('alt')).toBe('photo.png')
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
  })

  it('acquires upload-sourced images through the unified resource API', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PreviewImageContent
          source="upload"
          path="/Users/example/.open-science/uploads/default-project/session-1/photo.png"
          name="photo.png"
        />
      )
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'upload',
      path: '/Users/example/.open-science/uploads/default-project/session-1/photo.png'
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'open-science-preview://resource-1/photo.png'
    )
  })

  it('falls back to the error state when resource acquisition rejects', async () => {
    vi.mocked(window.api.previewResources.acquire).mockRejectedValue(new Error('read failed'))

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    expect(container.textContent).toContain("Image couldn't be loaded for preview")
  })

  it('falls back when the managed image URL cannot be decoded', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain("Image couldn't be loaded for preview")
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource-1'
    })
  })

  it('shows the missing-file message when the image no longer exists on disk', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    vi.mocked(window.api.previewResources.acquire).mockRejectedValue(enoent)

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/gone.png" name="gone.png" />)
    })

    expect(container.textContent).toContain('This file is no longer available')
    expect(container.textContent).not.toContain("couldn't be parsed for preview")
  })

  it('shows the outside-storage message when the path is outside the current storage root', async () => {
    vi.mocked(window.api.previewResources.acquire).mockRejectedValue(
      new Error('Artifact file is outside artifact storage.')
    )

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/elsewhere/photo.png" name="photo.png" />)
    })

    expect(container.textContent).toContain("isn't in your current storage location")
    expect(container.textContent).not.toContain('no longer available')
  })
})
