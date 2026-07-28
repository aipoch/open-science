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
      saveManagedFile: vi.fn().mockResolvedValue({ saved: false }),
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

  it('downloads an unsupported file from the primary action below its message', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <PreviewUnsupportedContent source="upload" path="/workspace/report.ppt" name="report.ppt" />
      )
    })

    const status = container.querySelector('[data-preview-status="unsupported"]')
    const description = Array.from(status?.querySelectorAll('p') ?? []).find((paragraph) =>
      paragraph.textContent?.includes("This file type isn't supported for preview")
    )
    const button = status?.querySelector<HTMLButtonElement>('button')

    expect(container.textContent).toContain('report.ppt')
    expect(container.textContent).toContain("This file type isn't supported for preview")
    expect(description?.parentElement?.contains(button ?? null)).toBe(true)
    expect(button?.dataset.variant).toBe('default')
    expect(button?.textContent).toBe('Download')
    expect(button?.querySelector('svg')).not.toBeNull()

    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'upload',
      path: '/workspace/report.ppt',
      suggestedName: 'report.ppt'
    })
    expect(window.api.artifacts.openFile).not.toHaveBeenCalled()
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

    expect(container.querySelector('[data-preview-status="loading"]')).not.toBeNull()

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

  it('renders accessible zoom controls alongside the image', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    expect(container.querySelector('[aria-label="Zoom in"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Zoom out"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Reset zoom"]')).not.toBeNull()
  })

  it('scales the transformed content when zooming in', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    const transformed = container.querySelector<HTMLElement>('.react-transform-component')
    const readScale = (): number =>
      Number.parseFloat(/scale\(([\d.]+)\)/.exec(transformed?.style.transform ?? '')?.[1] ?? 'NaN')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      const deadline = Date.now() + 2000
      let previous = Number.NaN
      while (Date.now() < deadline && !(readScale() > 1 && readScale() === previous)) {
        previous = readScale()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
    })

    expect(readScale()).toBeGreaterThan(1.2)
  })

  it('applies zoom instantly when the user prefers reduced motion', async () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
    vi.stubGlobal('matchMedia', matchMedia)

    try {
      root = createRoot(container)
      await act(async () => {
        root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
      })

      const transformed = container.querySelector<HTMLElement>('.react-transform-component')
      const readScale = (): number =>
        Number.parseFloat(
          /scale\(([\d.]+)\)/.exec(transformed?.style.transform ?? '')?.[1] ?? 'NaN'
        )

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })

      expect(readScale()).toBeGreaterThan(1.6)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves the decode-failure fallback behind the zoom wrapper', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })

    expect(container.querySelector('[aria-label="Zoom in"]')).toBeNull()
    expect(container.textContent).toContain("Image couldn't be loaded for preview")
    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
  })
})
