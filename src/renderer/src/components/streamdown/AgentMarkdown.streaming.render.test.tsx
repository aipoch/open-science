// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMarkdown, PresentedAgentMarkdown } from './AgentMarkdown'

describe('AgentMarkdown streaming presentation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('continues painting while target content grows faster than animation frames', async () => {
    await act(async () => {
      root.render(<AgentMarkdown content="流" isAnimating />)
    })

    for (let length = 2; length <= 70; length += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(8))
      await act(async () => {
        root.render(<AgentMarkdown content={'流'.repeat(length)} isAnimating />)
      })
    }

    const visible = container.querySelector('.agent-markdown')?.textContent ?? ''
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(70)
  })

  it('keeps completed Markdown blocks mounted when streaming settles', async () => {
    vi.useRealTimers()

    const content = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index + 1} with **formatted content**.`
    ).join('\n\n')

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={content} isAnimating />)
    })

    const firstParagraph = container.querySelector('p')
    expect(firstParagraph).not.toBeNull()

    const createElement = document.createElement.bind(document) as typeof document.createElement
    let createdParagraphs = 0
    vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions
    ) => {
      if (tagName === 'p') {
        createdParagraphs += 1
      }
      return createElement(tagName, options)
    }) as typeof document.createElement)

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={content} />)
    })

    expect(createdParagraphs).toBe(0)
    expect(container.querySelector('p')).toBe(firstParagraph)
  })

  it('renders the allowed session artifact image element through a supplied component', async () => {
    vi.useRealTimers()
    const ArtifactImage = ({
      artifact_ref: artifactRef
    }: Record<string, unknown>): React.JSX.Element => (
      <button data-testid="artifact-image">
        {typeof artifactRef === 'string' ? artifactRef : null}
      </button>
    )

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown
          content={'<session-artifact-image artifact_ref="version-1"></session-artifact-image>'}
          components={{ 'session-artifact-image': ArtifactImage }}
        />
      )
    })

    expect(container.querySelector('[data-testid="artifact-image"]')?.textContent).toBe('version-1')
  })

  it('passes a normalized artifact target to a supplied link component', async () => {
    vi.useRealTimers()
    const Link = ({ href }: React.ComponentProps<'a'>): React.JSX.Element => (
      <button data-testid="managed-file-link">{href}</button>
    )

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown
          content="[report](/.open-science/artifact/version-1)"
          components={{ a: Link }}
        />
      )
    })

    expect(container.querySelector('[data-testid="managed-file-link"]')?.textContent).toBe(
      '/.open-science/artifact/version-1'
    )
  })
})
