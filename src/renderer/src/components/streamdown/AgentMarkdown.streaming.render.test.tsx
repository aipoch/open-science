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
    const Link = ({ href }: React.ComponentProps<'a'> & { node?: unknown }): React.JSX.Element => (
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

  it('hides an unclosed trailing blockquote while streaming, without CSS :has()', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'Intro paragraph\n\n>'} isAnimating />)
    })

    const quote = container.querySelector('blockquote')
    expect(quote).not.toBeNull()
    expect(quote?.textContent?.trim()).toBe('')
    expect(quote?.className).toContain('hidden')
  })

  it('shows only the blockquotes that have paragraph content while streaming', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'> quoted text\n\n>'} isAnimating />)
    })

    const quotes = container.querySelectorAll('blockquote')
    expect(quotes).toHaveLength(2)
    expect(quotes[0].className).not.toContain('hidden')
    expect(quotes[0].textContent).toContain('quoted text')
    expect(quotes[1].className).toContain('hidden')
  })

  it('keeps nested blockquotes visible when an inner paragraph has text', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'> > nested text'} isAnimating />)
    })

    const quotes = container.querySelectorAll('blockquote')
    expect(quotes.length).toBeGreaterThan(0)
    for (const quote of quotes) {
      expect(quote.className).not.toContain('hidden')
    }
  })

  it('hides an image-only blockquote while streaming, matching the old :has(p) rule', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown content="> ![alt](https://example.com/x.png)" isAnimating />
      )
    })

    const quote = container.querySelector('blockquote')
    expect(quote).not.toBeNull()
    // Streamdown's paragraph unwraps the lone image, so no <p> reaches the DOM — the old
    // blockquote:not(:has(p:not(:empty))) selector hid this quote too.
    expect(quote?.querySelector('p')).toBeNull()
    expect(quote?.className).toContain('hidden')
  })

  it('shows the same empty blockquote once streaming settles', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'Intro paragraph\n\n>'} isAnimating />)
    })
    expect(container.querySelector('blockquote')?.className).toContain('hidden')

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'Intro paragraph\n\n>'} />)
    })

    const quote = container.querySelector('blockquote')
    expect(quote).not.toBeNull()
    expect(quote?.className).not.toContain('hidden')
  })

  it('keeps a supplied blockquote component in charge of chrome while toggling hidden', async () => {
    vi.useRealTimers()
    const CustomQuote = ({
      children,
      className
    }: React.ComponentProps<'blockquote'> & { node?: unknown }): React.JSX.Element => (
      <aside className={className} data-testid="custom-quote">
        {children}
      </aside>
    )

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown
          content={'> visible text\n\n>'}
          components={{ blockquote: CustomQuote }}
          isAnimating
        />
      )
    })

    const quotes = container.querySelectorAll('[data-testid="custom-quote"]')
    expect(quotes).toHaveLength(2)
    expect(quotes[0].className).not.toContain('hidden')
    expect(quotes[1].className).toContain('hidden')
  })
})
