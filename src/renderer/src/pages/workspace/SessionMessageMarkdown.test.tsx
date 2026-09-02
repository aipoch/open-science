// @vitest-environment jsdom
import { act, type ElementType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessageArtifact } from './session-message-artifact-reference'

const markdownHarness = vi.hoisted(() => ({
  href: 'sin_curve.png',
  artifactRef: 'version-1',
  renderedContent: ''
}))
const previewResourceHarness = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'error',
  enabled: undefined as boolean | undefined,
  dimensions: undefined as { width: number; height: number } | undefined
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  PresentedAgentMarkdown: ({
    content,
    components
  }: {
    content: string
    components?: Record<string, ElementType>
  }) => {
    markdownHarness.renderedContent = content
    const Link = components?.a
    const ArtifactImage = components?.['session-artifact-image']

    return (
      <div>
        {Link ? <Link href={markdownHarness.href}>sin_curve.png</Link> : null}
        {ArtifactImage ? (
          <ArtifactImage artifact_ref={markdownHarness.artifactRef} alt_text="Sine curve" />
        ) : null}
      </div>
    )
  }
}))

vi.mock('@/components/streamdown/SessionMessageLink', () => ({
  SessionMessageLink: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a data-fallback-session-link="" href={href}>
      {children}
    </a>
  )
}))

vi.mock('./artifact-preview', () => ({
  ArtifactPreview: () => <span data-artifact-preview="" />
}))

vi.mock('./previews/useManagedPreviewResource', () => ({
  useManagedPreviewResource: (_request: unknown, enabled = true) => {
    previewResourceHarness.enabled = enabled
    return !enabled
      ? { status: 'idle' }
      : previewResourceHarness.status === 'ready'
        ? {
            status: 'ready',
            resource: {
              id: 'resource-1',
              url: 'preview-resource://sin-curve',
              ...(previewResourceHarness.dimensions ?? {})
            }
          }
        : { status: 'error', error: new Error('Preview unavailable') }
  }
}))

const { SessionMessageMarkdown } = await import('./SessionMessageMarkdown')

const artifact: MessageArtifact = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  kind: 'managed-file',
  path: '/managed/session/sin_curve.png',
  name: 'sin_curve.png',
  mimeType: 'image/png',
  size: 1024,
  mtimeMs: 1710000000000,
  resolvedProjectId: 'project-1',
  resolvedSessionId: 'session-1'
}
const tiffArtifact: MessageArtifact = {
  ...artifact,
  id: 'version-tiff',
  versionId: 'version-tiff',
  path: '/managed/session/scan.tiff',
  name: 'scan.tiff',
  mimeType: 'image/tiff'
}
// A distinct path/size so its preview request key (and geometry cache entry) is unique per test.
const chartArtifact: MessageArtifact = {
  ...artifact,
  id: 'version-chart',
  versionId: 'version-chart',
  path: '/managed/session/chart.png',
  name: 'chart.png',
  size: 2048
}
const photoArtifact: MessageArtifact = {
  ...artifact,
  id: 'version-photo',
  versionId: 'version-photo',
  path: '/managed/session/photo.jpg',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 4096
}

describe('SessionMessageMarkdown', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    markdownHarness.href = 'sin_curve.png'
    markdownHarness.artifactRef = 'version-1'
    markdownHarness.renderedContent = ''
    previewResourceHarness.status = 'ready'
    previewResourceHarness.enabled = undefined
    previewResourceHarness.dimensions = undefined
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('routes artifact links to the side preview and artifact images to the modal preview', async () => {
    const onPreviewArtifact = vi.fn()
    const onPreviewArtifactModal = vi.fn()

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content={'![Sine curve](sin_curve.png)\n\n[sin_curve.png](sin_curve.png)'}
          artifacts={[artifact]}
          onPreviewArtifact={onPreviewArtifact}
          onPreviewArtifactModal={onPreviewArtifactModal}
        />
      )
    })

    expect(markdownHarness.renderedContent).toContain(
      '<session-artifact-image artifact_ref="version-1"'
    )
    expect(markdownHarness.renderedContent).toContain(
      '[sin_curve.png](/.open-science/artifact/version-1)'
    )
    const artifactLink = container.querySelector<HTMLButtonElement>('[data-session-artifact-link]')
    const artifactImage = container.querySelector<HTMLButtonElement>(
      '[data-session-artifact-image]'
    )
    expect(artifactLink).not.toBeNull()
    expect(artifactImage?.querySelector('img')?.getAttribute('src')).toBe(
      'preview-resource://sin-curve'
    )

    await act(async () => {
      artifactLink?.click()
      artifactImage?.click()
    })

    expect(onPreviewArtifact).toHaveBeenCalledWith(artifact)
    expect(onPreviewArtifactModal).toHaveBeenCalledWith(artifact)
  })

  it('keeps unpublished artifact links and inline images inert until publication', async () => {
    const onPreviewArtifact = vi.fn()
    const onPreviewArtifactModal = vi.fn()
    const pendingArtifact = {
      ...artifact,
      path: '/managed/session/.pending/run-1/sin_curve.png'
    }

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content={'![Sine curve](sin_curve.png)\n\n[sin_curve.png](sin_curve.png)'}
          artifacts={[pendingArtifact]}
          onPreviewArtifact={onPreviewArtifact}
          onPreviewArtifactModal={onPreviewArtifactModal}
        />
      )
    })

    const artifactLink = container.querySelector<HTMLButtonElement>('[data-session-artifact-link]')
    expect(artifactLink?.disabled).toBe(true)
    expect(previewResourceHarness.enabled).toBe(false)
    expect(container.querySelector('[data-session-artifact-image]')).toBeNull()

    await act(async () => artifactLink?.click())
    expect(onPreviewArtifact).not.toHaveBeenCalled()
    expect(onPreviewArtifactModal).not.toHaveBeenCalled()
  })

  it('retains the existing safe-link component for external links', async () => {
    markdownHarness.href = 'https://example.com/sin_curve.png'

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="[External](https://example.com/sin_curve.png)"
          artifacts={[artifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-fallback-session-link]')).not.toBeNull()
    expect(container.querySelector('[data-session-artifact-link]')).toBeNull()
  })

  it('shows an error state when the artifact preview resource cannot be acquired', async () => {
    previewResourceHarness.status = 'error'

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Sine curve](sin_curve.png)"
          artifacts={[artifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-session-artifact-image]')).toBeNull()
    expect(
      container.querySelector('[data-session-artifact-image-status]')?.getAttribute('data-state')
    ).toBe('error')
  })

  it('degrades to the alt text for artifacts without a logical identity', async () => {
    // Artifacts persisted before editable versions may lack resolvedProjectId/artifactId; the
    // acquire request builder throws for those, so the image must fall back instead.
    const legacyArtifact: MessageArtifact = {
      ...artifact,
      resolvedProjectId: undefined,
      resolvedSessionId: undefined
    }

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Sine curve](sin_curve.png)"
          artifacts={[legacyArtifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-session-artifact-image]')).toBeNull()
    expect(container.querySelector('[data-session-artifact-image-status]')).toBeNull()
    expect(previewResourceHarness.enabled).toBeUndefined()
  })

  it('keeps the image resource mounted after it has been near the viewport', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }

        observe = vi.fn()
        disconnect = vi.fn()
      }
    )

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Sine curve](sin_curve.png)"
          artifacts={[artifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    expect(previewResourceHarness.enabled).toBe(false)
    expect(container.querySelector('[data-session-artifact-image]')).toBeNull()

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(previewResourceHarness.enabled).toBe(true)
    expect(container.querySelector('[data-session-artifact-image]')).not.toBeNull()

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    // Leaving the viewport must not unload the image: the placeholder is much shorter than the
    // loaded image, so an unload/remount cycle at the viewport edge fights the scroll anchoring
    // compensation and produces per-frame jitter.
    expect(previewResourceHarness.enabled).toBe(true)
    expect(container.querySelector('[data-session-artifact-image]')).not.toBeNull()
  })

  it('reserves the loaded image geometry for the placeholder after a remount', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }

        observe = vi.fn()
        disconnect = vi.fn()
      }
    )

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Sine curve](sin_curve.png)"
          artifacts={[artifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    const img = container.querySelector<HTMLImageElement>('[data-session-artifact-image] img')
    expect(img).not.toBeNull()
    Object.defineProperty(img, 'naturalWidth', { value: 800 })
    Object.defineProperty(img, 'naturalHeight', { value: 400 })
    await act(async () => {
      img?.dispatchEvent(new Event('load'))
    })

    // A fresh instance (e.g. the transcript window recycling an offscreen message) starts away
    // from the viewport and shows the placeholder, sized to the cached image geometry.
    const remountContainer = document.createElement('div')
    document.body.appendChild(remountContainer)
    const remountRoot = createRoot(remountContainer)
    await act(async () => {
      remountRoot.render(
        <SessionMessageMarkdown
          content="![Sine curve](sin_curve.png)"
          artifacts={[artifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    const placeholder = remountContainer.querySelector<HTMLElement>(
      '[data-session-artifact-image-status]'
    )
    expect(placeholder).not.toBeNull()
    expect(placeholder?.style.width).toBe('800px')
    expect(placeholder?.style.maxWidth).toBe('100%')
    expect(placeholder?.style.aspectRatio).toBe('2 / 1')

    await act(async () => remountRoot.unmount())
    remountContainer.remove()
  })

  it('sizes the image and the remounted placeholder from header-probed metadata', async () => {
    previewResourceHarness.dimensions = { width: 1000, height: 500 }
    markdownHarness.artifactRef = 'version-chart'
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }

        observe = vi.fn()
        disconnect = vi.fn()
      }
    )

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Chart](chart.png)"
          artifacts={[chartArtifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    // The metadata dimensions land on the <img> attributes so the browser reserves the exact
    // box before decoding. No load event is dispatched: the placeholder lock must come from the
    // metadata-seeded cache, not from measured natural sizes.
    const img = container.querySelector<HTMLImageElement>('[data-session-artifact-image] img')
    expect(img?.getAttribute('width')).toBe('1000')
    expect(img?.getAttribute('height')).toBe('500')

    const remountContainer = document.createElement('div')
    document.body.appendChild(remountContainer)
    const remountRoot = createRoot(remountContainer)
    await act(async () => {
      remountRoot.render(
        <SessionMessageMarkdown
          content="![Chart](chart.png)"
          artifacts={[chartArtifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    const placeholder = remountContainer.querySelector<HTMLElement>(
      '[data-session-artifact-image-status]'
    )
    expect(placeholder).not.toBeNull()
    expect(placeholder?.style.width).toBe('1000px')
    expect(placeholder?.style.maxWidth).toBe('100%')
    expect(placeholder?.style.aspectRatio).toBe('2 / 1')

    await act(async () => remountRoot.unmount())
    remountContainer.remove()
  })

  it('lets the measured natural size win over header metadata (EXIF-transposed JPEG)', async () => {
    // The header stores pre-rotation dimensions (1000x500); the browser applies EXIF orientation
    // and the decoded natural size is transposed (500x1000). The cache must end up holding the
    // displayed size so remounts lock the box the image actually occupies.
    previewResourceHarness.dimensions = { width: 1000, height: 500 }
    markdownHarness.artifactRef = 'version-photo'
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }

        observe = vi.fn()
        disconnect = vi.fn()
      }
    )

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Photo](photo.jpg)"
          artifacts={[photoArtifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    const img = container.querySelector<HTMLImageElement>('[data-session-artifact-image] img')
    expect(img).not.toBeNull()
    Object.defineProperty(img, 'naturalWidth', { value: 500 })
    Object.defineProperty(img, 'naturalHeight', { value: 1000 })
    await act(async () => {
      img?.dispatchEvent(new Event('load'))
    })

    const remountContainer = document.createElement('div')
    document.body.appendChild(remountContainer)
    const remountRoot = createRoot(remountContainer)
    await act(async () => {
      remountRoot.render(
        <SessionMessageMarkdown
          content="![Photo](photo.jpg)"
          artifacts={[photoArtifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    })

    const placeholder = remountContainer.querySelector<HTMLElement>(
      '[data-session-artifact-image-status]'
    )
    expect(placeholder?.style.width).toBe('500px')
    expect(placeholder?.style.aspectRatio).toBe('0.5 / 1')

    await act(async () => remountRoot.unmount())
    remountContainer.remove()
  })

  it('routes TIFF images through the existing artifact thumbnail and modal', async () => {
    const onPreviewArtifactModal = vi.fn()
    markdownHarness.artifactRef = 'version-tiff'

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Scan](scan.tiff)"
          artifacts={[tiffArtifact]}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={onPreviewArtifactModal}
        />
      )
    })

    const artifactImage = container.querySelector<HTMLButtonElement>(
      '[data-session-artifact-image]'
    )
    expect(container.querySelector('[data-session-artifact-tiff-preview]')).not.toBeNull()
    expect(container.querySelector('[data-artifact-preview]')).not.toBeNull()
    expect(previewResourceHarness.enabled).toBe(false)

    await act(async () => artifactImage?.click())
    expect(onPreviewArtifactModal).toHaveBeenCalledWith(tiffArtifact)
  })
})
