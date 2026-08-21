// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

const streamdownHarness = vi.hoisted(() => ({
  shouldThrow: true,
  disallowedElements: undefined as readonly string[] | undefined,
  components: undefined as Record<string, unknown> | undefined,
  animated: undefined as unknown,
  caret: undefined as string | undefined,
  blockComponent: undefined as unknown
}))

vi.mock('@streamdown/code', () => ({ code: {} }))
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: {} }))
vi.mock('streamdown', () => ({
  Streamdown: ({
    children,
    animated,
    caret,
    components,
    disallowedElements,
    BlockComponent
  }: PropsWithChildren<{
    animated?: unknown
    caret?: string
    components?: Record<string, unknown>
    disallowedElements?: readonly string[]
    BlockComponent?: unknown
  }>): React.JSX.Element => {
    if (streamdownHarness.shouldThrow) throw new Error('optimized Markdown chunk failed to load')
    streamdownHarness.components = components
    streamdownHarness.disallowedElements = disallowedElements
    streamdownHarness.animated = animated
    streamdownHarness.caret = caret
    streamdownHarness.blockComponent = BlockComponent

    return <div data-testid="rich-markdown">{children}</div>
  }
}))

const { AgentMarkdown, SessionMessageLink } = await import('./AgentMarkdown')
const { StreamingBlock } = await import('./StreamingBlock')

describe('AgentMarkdown renderer recovery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    streamdownHarness.shouldThrow = true
    streamdownHarness.disallowedElements = undefined
    streamdownHarness.components = undefined
    streamdownHarness.animated = undefined
    streamdownHarness.caret = undefined
    streamdownHarness.blockComponent = undefined
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('keeps the original message and sibling UI visible when rich Markdown rendering fails', async () => {
    await act(async () => {
      root.render(
        <section>
          <span data-testid="workspace-sibling">Workspace controls</span>
          <AgentMarkdown content={'Original message\n```ts\nconst value = 1\n```'} />
        </section>
      )
    })

    expect(container.querySelector('[data-testid="workspace-sibling"]')?.textContent).toBe(
      'Workspace controls'
    )
    expect(container.querySelector('[data-agent-markdown-fallback]')?.textContent).toBe(
      'Original message\n```ts\nconst value = 1\n```'
    )
  })

  it('retries rich rendering when the message content changes after a failure', async () => {
    await act(async () => {
      root.render(<AgentMarkdown content="Initial message" />)
    })

    streamdownHarness.shouldThrow = false
    await act(async () => {
      root.render(<AgentMarkdown content="Recovered message" />)
    })

    expect(container.querySelector('[data-agent-markdown-fallback]')).toBeNull()
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe(
      'Recovered message'
    )
  })

  it('blocks network-fetching media elements when media is disabled', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="Untrusted preview" allowMedia={false} />)
    })

    expect(streamdownHarness.disallowedElements).toEqual(
      expect.arrayContaining(['img', 'video', 'audio', 'source', 'track', 'use'])
    )
  })

  it('opts into the session link renderer without changing default AgentMarkdown callers', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="Plain shared markdown" />)
    })
    expect(streamdownHarness.components).toBeUndefined()

    await act(async () => {
      root.render(<AgentMarkdown content="Session markdown" sessionLinks />)
    })
    expect(streamdownHarness.components?.a).toBe(SessionMessageLink)
  })

  it('defers highlighting of the trailing unclosed code fence via the streaming block', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content={'```ts\nconst value = 1'} isAnimating />)
    })

    expect(streamdownHarness.blockComponent).toBe(StreamingBlock)
  })

  it('reveals a buffered segment across frames without any caret at the visible tail', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false
    const content = 'flow'.repeat(13)

    await act(async () => {
      root.render(<AgentMarkdown content={content} isAnimating />)
    })
    expect(streamdownHarness.caret).toBeUndefined()
    expect(streamdownHarness.animated).toBe(false)
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('')

    await act(async () => vi.advanceTimersByTimeAsync(512))
    const firstFrame = container.querySelector('[data-testid="rich-markdown"]')?.textContent ?? ''
    expect(firstFrame).toBe('f')

    for (let expectedLength = 2; expectedLength <= 12; expectedLength += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(16))
      expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent?.length).toBe(
        expectedLength
      )
    }

    await act(async () => vi.advanceTimersByTimeAsync(900))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe(content)

    await act(async () => {
      root.render(<AgentMarkdown content={content} />)
    })
    expect(streamdownHarness.caret).toBeUndefined()
  })

  it('drains a large backlog with catch-up frames instead of trailing seconds behind', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false
    const content = 'y'.repeat(3000)

    await act(async () => {
      root.render(<AgentMarkdown content={content} isAnimating />)
    })
    // Prebuffer, then the backlog (3000 > 600) drains at remaining/30 per frame.
    await act(async () => vi.advanceTimersByTimeAsync(512))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    // Without catch-up, ~94 frames at <=3 graphemes would reveal under 300 graphemes.
    expect(
      container.querySelector('[data-testid="rich-markdown"]')?.textContent?.length ?? 0
    ).toBeGreaterThan(2000)
  })

  it('keeps revealing while faster stream updates extend the target between frames', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="x" isAnimating />)
    })

    for (let length = 2; length <= 70; length += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(8))
      await act(async () => {
        root.render(<AgentMarkdown content={'x'.repeat(length)} isAnimating />)
      })
    }

    const visible = container.querySelector('[data-testid="rich-markdown"]')?.textContent ?? ''
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(70)
    expect(streamdownHarness.caret).toBeUndefined()
  })

  it('prebuffers a small segment instead of exposing source jitter directly', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content={'x'.repeat(12)} isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(480))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('')
    expect(streamdownHarness.caret).toBeUndefined()

    await act(async () => {
      root.render(<AgentMarkdown content={'x'.repeat(40)} isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(32))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('x')
  })

  it('starts a slow stream after the bounded prebuffer delay', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content={'x'.repeat(12)} isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(496))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('')

    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('x')
  })

  it('flushes a non-append correction that preserves the visible prefix', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="abcdef" isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(544))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('abc')

    await act(async () => {
      root.render(<AgentMarkdown content="abcXYZ" isAnimating />)
    })

    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('abcXYZ')
  })

  it('uses one lazy, no-referrer favicon source per hostname and falls back on failure', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://pubmed.ncbi.nlm.nih.gov/123?view=full">
          Paper
        </SessionMessageLink>
      )
    })

    let favicon = container.querySelector<HTMLImageElement>('[data-session-link-favicon] img')
    expect(favicon?.getAttribute('src')).toBe('https://pubmed.ncbi.nlm.nih.gov/favicon.ico')
    expect(favicon?.getAttribute('loading')).toBe('lazy')
    expect(favicon?.getAttribute('referrerpolicy')).toBe('no-referrer')

    await act(async () => {
      root.render(
        <SessionMessageLink href="https://pubmed.ncbi.nlm.nih.gov/456">Paper</SessionMessageLink>
      )
    })
    favicon = container.querySelector<HTMLImageElement>('[data-session-link-favicon] img')
    expect(favicon?.getAttribute('src')).toBe('https://pubmed.ncbi.nlm.nih.gov/favicon.ico')

    await act(async () => {
      favicon?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('[data-session-link-favicon]')?.getAttribute('data-state')).toBe(
      'error'
    )
    expect(container.querySelector('[data-session-link-favicon] img')).toBeNull()
    expect(container.querySelector('[data-session-link-favicon-fallback]')).not.toBeNull()

    await act(async () => {
      root.render(
        <SessionMessageLink href="mailto:researcher@example.com">Email</SessionMessageLink>
      )
    })
    expect(container.querySelector('[data-session-link-favicon]')).toBeNull()
  })

  it('keeps the external-link safety confirmation before opening a session link', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await act(async () => {
      root.render(<SessionMessageLink href="https://example.com/paper">Paper</SessionMessageLink>)
    })

    const link = container.querySelector<HTMLButtonElement>('[data-session-message-link]')
    await act(async () => {
      link?.click()
    })
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Open external link?"]'
    )
    expect(dialog).not.toBeNull()

    const openLink = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Open link'
    )
    await act(async () => {
      openLink?.click()
    })

    expect(open).toHaveBeenCalledWith('https://example.com/paper', '_blank', 'noreferrer')
  })

  it('renders a numeric HTTPS link as a citation marker and opens a reusable source preview', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/paper#results" title="Genome study">
          1
        </SessionMessageLink>
      )
    })

    const citation = container.querySelector<HTMLAnchorElement>('[data-citation-marker]')
    expect(citation?.tagName).toBe('A')
    expect(citation?.getAttribute('href')).toBe('https://example.com/paper#results')
    expect(citation?.getAttribute('role')).toBe('doc-noteref')
    expect(citation?.getAttribute('aria-label')).toBe('Source 1: Genome study')
    expect(citation?.className).toContain('rounded-full')
    expect(citation?.className).toContain('text-primary')

    await act(async () => {
      citation?.click()
    })

    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Open external link?"]'
    )
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('You are about to preview an external website.')
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])

    const openPreview = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.trim() === 'Open source preview')
    await act(async () => {
      openPreview?.click()
    })

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'open',
      activeItemId: 'source:https://example.com/paper#results',
      items: [
        expect.objectContaining({
          id: 'source:https://example.com/paper#results',
          type: 'source',
          title: 'Genome study',
          url: 'https://example.com/paper#results'
        })
      ]
    })
  })

  it('keeps a numeric non-HTTPS link on the external-link safety path', async () => {
    await act(async () => {
      root.render(<SessionMessageLink href="http://example.com/paper">1</SessionMessageLink>)
    })

    expect(container.querySelector('[data-citation-marker]')).toBeNull()
    expect(container.querySelector('[data-session-message-link]')).not.toBeNull()
  })

  it('routes middle-click citation activation through the safety confirmation', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/paper" title="Genome study">
          1
        </SessionMessageLink>
      )
    })

    const citation = container.querySelector<HTMLAnchorElement>('[data-citation-marker]')
    const auxClick = new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })
    await act(async () => {
      citation?.dispatchEvent(auxClick)
    })
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    expect(auxClick.defaultPrevented).toBe(true)
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
    ).not.toBeNull()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })
})
