// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mimic dual-theme Shiki output: colors live in htmlStyle, not token.color.
vi.mock('@streamdown/code', () => ({
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

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
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
})
