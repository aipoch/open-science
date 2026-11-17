// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputeCellPreview } from './ComputeCellPreview'

const { highlight, useHighlighter } = vi.hoisted(() => {
  const highlight = vi.fn(({ code }: { code: string }) => ({
    tokens: [[{ content: code, color: 'red' }]]
  }))
  const plugin = {
    supportsLanguage: () => true,
    highlight,
    getThemes: () => ({ light: 'light', dark: 'dark' })
  }
  return { highlight, useHighlighter: vi.fn((enabled: boolean) => (enabled ? plugin : undefined)) }
})
vi.mock('@/components/streamdown/use-code-highlighter', () => ({
  useCodeHighlighter: useHighlighter
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const container = document.createElement('div')
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  container.replaceChildren()
  vi.clearAllMocks()
})

it('keeps highlighted R DOM and scroll position unchanged when the parent receives metrics', async () => {
  const root = createRoot(container)
  roots.push(root)
  const render = (): void =>
    root.render(<ComputeCellPreview code="values <- c(19, 23)" kind="r" truncated={false} />)
  await act(async () => render())
  const source = container.querySelector('code')!
  const region = container.querySelector('[role="region"]')!
  region.scrollTop = 80
  expect(source.textContent).toBe('values <- c(19, 23)')
  expect(highlight).toHaveBeenCalledOnce()
  await act(async () => render())
  expect(container.querySelector('code')).toBe(source)
  expect(region.scrollTop).toBe(80)
  expect(highlight).toHaveBeenCalledOnce()
})

it.each(['x'.repeat(8001), 'x\n'.repeat(201)])(
  'uses bounded plain text DOM above the highlighting budget',
  async (code) => {
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<ComputeCellPreview code={code} kind="python" truncated />))
    expect(highlight).not.toHaveBeenCalled()
    expect(useHighlighter).toHaveBeenCalledWith(false)
    expect(container.querySelector('code')!.textContent).toBe(code)
    expect(container.querySelector('code')!.childElementCount).toBe(0)
    expect(container.textContent).toContain('Preview limited to the first 32,000 characters.')
  }
)
