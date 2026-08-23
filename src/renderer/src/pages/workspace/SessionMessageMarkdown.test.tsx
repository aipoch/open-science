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
  },
  SessionMessageLink: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a data-fallback-session-link="" href={href}>
      {children}
    </a>
  )
}))

vi.mock('./previews/useManagedPreviewResource', () => ({
  useManagedPreviewResource: () => ({
    status: 'ready',
    resource: { id: 'resource-1', url: 'preview-resource://sin-curve' }
  })
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
  mtimeMs: 1710000000000
}

describe('SessionMessageMarkdown', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    markdownHarness.href = 'sin_curve.png'
    markdownHarness.artifactRef = 'version-1'
    markdownHarness.renderedContent = ''
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('routes artifact links to the side preview and artifact images to the modal preview', async () => {
    const onPreviewArtifact = vi.fn()
    const onPreviewArtifactModal = vi.fn()

    await act(async () => {
      root.render(
        <SessionMessageMarkdown
          content="![Sine curve](sin_curve.png)"
          artifacts={[artifact]}
          onPreviewArtifact={onPreviewArtifact}
          onPreviewArtifactModal={onPreviewArtifactModal}
        />
      )
    })

    expect(markdownHarness.renderedContent).toContain(
      '<session-artifact-image artifact_ref="version-1"'
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
})
