// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mimic dual-theme Shiki output: colors live in htmlStyle, not token.color.
vi.mock('@/components/streamdown/code-highlighter-runtime', () => ({
  code: {
    supportsLanguage: () => true,
    getThemes: () => ['github-light', 'github-dark'],
    highlight: (
      _options: unknown,
      callback?: (result: { tokens: Array<Array<Record<string, unknown>>> }) => void
    ) => {
      callback?.({
        tokens: [
          [{ content: 'import', htmlStyle: { color: '#D73A49', '--shiki-dark': '#F97583' } }]
        ]
      })
      return null
    }
  }
}))

const { WorkspaceToolCodeBlock } = await import('./WorkspaceToolCodeBlock')

describe('WorkspaceToolCodeBlock', () => {
  let container: HTMLDivElement
  let root: Root
  const writeText = vi.fn<() => Promise<void>>()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    writeText.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.documentElement.classList.remove('dark')
    vi.clearAllMocks()
  })

  it('applies the Shiki htmlStyle color to highlighted tokens', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspaceToolCodeBlock code="import" language="python" />)
    })

    const token = container.querySelector('span[style]')

    expect(token?.textContent).toBe('import')
    // The htmlStyle color must reach the DOM; jsdom normalizes the hex to rgb.
    expect((token as HTMLElement | null)?.style.color).toBe('rgb(215, 58, 73)')
    expect((token as HTMLElement | null)?.style.getPropertyValue('--shiki-dark')).toBe('#F97583')
  })

  it('uses the Shiki dark token color when the app is in dark mode', async () => {
    document.documentElement.classList.add('dark')
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspaceToolCodeBlock code="import" language="python" />)
    })

    const token = container.querySelector('span[style]')

    // Shiki leaves the light color inline, so the dark utility must override it with !important.
    expect(token?.className).toContain('dark:[color:var(--shiki-dark)]!')
  })

  it('does not report a successful copy when the Clipboard API rejects the request', async () => {
    writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspaceToolCodeBlock code="import" language="python" copyable />)
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="code-copy-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(writeText).toHaveBeenCalledWith('import')
    expect(container.querySelector('[aria-label="Copied"]')).toBeNull()
  })

  it('pins the copy button outside the scrollable code area', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<WorkspaceToolCodeBlock code="import" language="python" copyable />)
    })

    const codeBlock = container.querySelector('[data-testid="tool-code-block"]')
    const copyButton = container.querySelector('[data-testid="code-copy-button"]')

    expect(codeBlock?.tagName).toBe('PRE')
    expect(codeBlock?.className).toContain('overflow-auto')
    expect(codeBlock?.parentElement?.className).toContain('relative')
    expect(copyButton?.parentElement).toBe(codeBlock?.parentElement)
    expect(copyButton?.className).toContain('z-10')
  })
})
