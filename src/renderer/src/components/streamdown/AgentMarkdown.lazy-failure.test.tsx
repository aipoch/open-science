// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  plugins: undefined as Record<string, unknown> | undefined
}))

vi.mock('./code-highlighter-runtime', () => ({ code: { name: 'shiki' } }))
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }))
vi.mock('./mermaid-runtime', () => {
  throw new Error('Mermaid chunk unavailable')
})
vi.mock('streamdown', () => ({
  Streamdown: ({
    children,
    plugins
  }: PropsWithChildren<{ plugins?: Record<string, unknown> }>): React.JSX.Element => {
    harness.plugins = plugins
    return <div data-testid="markdown-source">{children}</div>
  }
}))

const { PresentedAgentMarkdown } = await import('./AgentMarkdown')

describe('AgentMarkdown optional plugin failures', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('keeps Mermaid source readable when the Mermaid chunk fails to load', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const content = '```mermaid\ngraph TD\n  A --> B\n```'

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={content} />)
    })

    expect(container.querySelector('[data-testid="markdown-source"]')?.textContent).toBe(content)
    expect(harness.plugins?.mermaid).toBeUndefined()
    expect(
      consoleError.mock.calls.some(([message]) => message === 'Failed to load Mermaid rendering.')
    ).toBe(true)

    act(() => root.unmount())
  })
})
