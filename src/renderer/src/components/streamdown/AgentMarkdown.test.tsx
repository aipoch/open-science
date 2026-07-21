// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const streamdownHarness = vi.hoisted(() => ({
  shouldThrow: true
}))

vi.mock('@streamdown/code', () => ({ code: {} }))
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: {} }))
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: PropsWithChildren): React.JSX.Element => {
    if (streamdownHarness.shouldThrow) throw new Error('optimized Markdown chunk failed to load')

    return <div data-testid="rich-markdown">{children}</div>
  }
}))

const { AgentMarkdown } = await import('./AgentMarkdown')

describe('AgentMarkdown renderer recovery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    streamdownHarness.shouldThrow = true
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
})
