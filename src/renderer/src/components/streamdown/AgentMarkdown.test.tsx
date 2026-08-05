// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const streamdownHarness = vi.hoisted(() => ({
  shouldThrow: true,
  disallowedElements: undefined as readonly string[] | undefined,
  components: undefined as Record<string, unknown> | undefined
}))

vi.mock('@streamdown/code', () => ({ code: {} }))
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: {} }))
vi.mock('streamdown', () => ({
  Streamdown: ({
    children,
    components,
    disallowedElements
  }: PropsWithChildren<{
    components?: Record<string, unknown>
    disallowedElements?: readonly string[]
  }>): React.JSX.Element => {
    if (streamdownHarness.shouldThrow) throw new Error('optimized Markdown chunk failed to load')
    streamdownHarness.components = components
    streamdownHarness.disallowedElements = disallowedElements

    return <div data-testid="rich-markdown">{children}</div>
  }
}))

const { AgentMarkdown, SessionMessageLink } = await import('./AgentMarkdown')

describe('AgentMarkdown renderer recovery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    streamdownHarness.shouldThrow = true
    streamdownHarness.disallowedElements = undefined
    streamdownHarness.components = undefined
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.restoreAllMocks()
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
})
