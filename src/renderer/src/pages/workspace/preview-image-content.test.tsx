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
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  it('shows a loading state before the read resolves', async () => {
    let resolveRead: ((value: unknown) => void) | undefined
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            resolveRead = resolve
          })
        ),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    expect(container.querySelector('.animate-spin')).not.toBeNull()

    await act(async () => {
      resolveRead?.({ content: 'aGVsbG8=', encoding: 'base64', size: 6, truncated: false })
    })
  })

  it('renders the image once the read resolves with base64 content', async () => {
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn().mockResolvedValue({
          content: 'aGVsbG8=',
          encoding: 'base64',
          size: 6,
          truncated: false
        }),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
    expect(image?.getAttribute('alt')).toBe('photo.png')
  })

  it('reads upload-sourced image previews through the uploads API', async () => {
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn(),
        finalizeRunArtifacts: vi.fn()
      },
      uploads: {
        stageFiles: vi.fn(),
        deleteUpload: vi.fn(),
        finalizeSession: vi.fn(),
        readPreview: vi.fn().mockResolvedValue({
          content: 'aGVsbG8=',
          encoding: 'base64',
          size: 6,
          truncated: false
        })
      }
    } as unknown as Window['api']

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

    expect(window.api.uploads.readPreview).toHaveBeenCalledWith({
      path: '/Users/example/.open-science/uploads/default-project/session-1/photo.png',
      maxBytes: 10 * 1024 * 1024,
      encoding: 'base64'
    })
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,aGVsbG8='
    )
  })

  it('falls back to the error state when the read is truncated', async () => {
    window.api = {
      artifacts: {
        openFile: vi.fn().mockResolvedValue(undefined),
        readPreview: vi
          .fn()
          .mockResolvedValue({ content: 'aGVsbG8=', encoding: 'base64', size: 6, truncated: true }),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain("File is too large or couldn't be parsed for preview")

    const openButton = container.querySelector('button')
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.api.artifacts.openFile).toHaveBeenCalledWith({ path: '/workspace/photo.png' })
  })

  it('falls back to the error state when the read rejects', async () => {
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn().mockRejectedValue(new Error('read failed')),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/photo.png" name="photo.png" />)
    })

    expect(container.textContent).toContain("File is too large or couldn't be parsed for preview")
  })

  it('shows the missing-file message when the image no longer exists on disk', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi.fn().mockRejectedValue(enoent),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/workspace/gone.png" name="gone.png" />)
    })

    expect(container.textContent).toContain('This file is no longer available')
    expect(container.textContent).not.toContain("couldn't be parsed for preview")
  })

  it('shows the outside-storage message when the path is outside the current storage root', async () => {
    window.api = {
      artifacts: {
        openFile: vi.fn(),
        readPreview: vi
          .fn()
          .mockRejectedValue(new Error('Artifact file is outside artifact storage.')),
        finalizeRunArtifacts: vi.fn()
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => {
      root.render(<PreviewImageContent path="/elsewhere/photo.png" name="photo.png" />)
    })

    expect(container.textContent).toContain("isn't in your current storage location")
    expect(container.textContent).not.toContain('no longer available')
  })
})
