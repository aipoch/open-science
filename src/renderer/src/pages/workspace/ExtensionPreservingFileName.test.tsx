// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'

describe('ExtensionPreservingFileName', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    container.remove()
  })

  const renderName = (name: string): void => {
    act(() => root.render(<ExtensionPreservingFileName name={name} />))
  }

  it('keeps the basename tail and final extension visible for a long filename', () => {
    renderName('very_long_experiment_analysis_result_2025.csv')

    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe(
      'very_long_experiment_analysis_result'
    )
    expect(container.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe('_2025')
    expect(container.querySelector('[data-testid="file-name-ellipsis"]')).toBeNull()
    expect(container.querySelector('[data-testid="file-name-extension"]')?.textContent).toBe('.csv')
  })

  it.each(['README', '.env'])('truncates %s as one name without an extension suffix', (name) => {
    renderName(name)

    expect(container.textContent).toBe(name)
    expect(container.querySelector('[data-testid="file-name-extension"]')).toBeNull()
  })

  it('keeps a short filename complete', () => {
    renderName('note.md')

    expect(container.textContent).toBe('note.md')
  })

  const mockWidths = (available: () => number, measured = vi.fn()): (() => void) => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const measureText = (text: string): { width: number } => {
      measured()
      return { width: Array.from(segmenter.segment(text)).length * 8 }
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width: available() }) as DOMRect
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText
    } as unknown as CanvasRenderingContext2D)
    let notify: () => void
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element): void {
          notify = () =>
            this.callback(
              [{ target, contentRect: { width: available() } } as ResizeObserverEntry],
              this as unknown as ResizeObserver
            )
          notify()
        }
        disconnect = vi.fn()
      }
    )
    return () => notify()
  }

  it('preserves whole filename words instead of cutting into the final word', () => {
    mockWidths(() => 144)
    renderName('report_analysis_results.csv')
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe('report')
    expect(container.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe('results')
  })

  it('uses the whole first word when both endpoint words cannot fit', () => {
    mockWidths(() => 128)
    renderName('report_analysis_results.csv')
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe('report')
    expect(container.querySelector('[data-testid="file-name-tail"]')).toBeNull()
  })

  it('falls back to graphemes for a single word wider than the label', () => {
    mockWidths(() => 80)
    renderName('Supercalifragilisticexpialidocious.csv')
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe('Super')
    expect(container.querySelector('[data-testid="file-name-tail"]')).toBeNull()
  })

  it('reserves a readable prefix before retaining a short ending', () => {
    mockWidths(() => 72)
    renderName('a_b_c_end.csv')
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe('a_b')
    expect(container.querySelector('[data-testid="file-name-tail"]')).toBeNull()
  })

  it('keeps a recognizable Chinese ending when there is room for both fragments', () => {
    mockWidths(() => 128)
    renderName('示例文档_测试记录_阶段汇总_最终版本.md')
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toMatch(
      /^示例文档/
    )
    expect(container.querySelector('[data-testid="file-name-tail"]')?.textContent).toMatch(
      /最终版本$/
    )
  })

  it.each([false, true])('uses the same measured rule with compact=%s', (compact) => {
    mockWidths(() => 80)
    act(() =>
      root.render(
        <ExtensionPreservingFileName
          name="very_long_experiment_analysis_result_2025.csv"
          compact={compact}
        />
      )
    )
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe('very')
    expect(container.querySelector('[data-testid="file-name-ellipsis"]')?.textContent).toBe('…')
    expect(container.querySelector('[data-testid="file-name-tail"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="file-name-root"]')?.getAttribute('aria-label')
    ).toBe('very_long_experiment_analysis_result_2025.csv')
  })

  it('restores the full name when available width grows and abbreviates again when it shrinks', () => {
    let availableWidth = 80
    const measured = vi.fn()
    const notifyResize = mockWidths(() => availableWidth, measured)
    const name = 'very_long_experiment_analysis_result_2025.csv'
    renderName(name)
    expect(container.querySelector('[data-testid="file-name-ellipsis"]')).not.toBeNull()
    const calls = measured.mock.calls.length
    act(notifyResize)
    expect(HTMLElement.prototype.getBoundingClientRect).not.toHaveBeenCalled()
    expect(measured).toHaveBeenCalledTimes(calls)
    availableWidth = 500
    act(notifyResize)
    expect(container.textContent).toBe(name)
    expect(container.querySelector('[data-testid="file-name-ellipsis"]')).toBeNull()
    availableWidth = 80
    act(notifyResize)
    expect(container.querySelector('[data-testid="file-name-head"]')?.textContent).toBe('very')
    expect(container.querySelector('[data-testid="file-name-ellipsis"]')).not.toBeNull()
  })

  it.each(['👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301'])(
    'keeps the entire %s grapheme at a filename ending',
    (ending) => {
      mockWidths(() => 128)
      renderName(`very_long_experiment_analysis_result_${ending}.csv`)
      expect(
        container.querySelector('[data-testid="file-name-tail"]')?.textContent?.endsWith(ending)
      ).toBe(true)
    }
  )

  it('replaces measured text when another file reuses the surface', () => {
    mockWidths(() => 80)
    renderName('very_long_experiment_analysis_result_2025.csv')
    renderName('note.md')
    expect(container.textContent).toBe('note.md')
    expect(container.querySelector('[data-testid="file-name-ellipsis"]')).toBeNull()
  })

  it('reserves room for the basename head when an extension is unusually long', () => {
    renderName('sample.verylongcustomextension')

    expect(container.querySelector('[data-testid="file-name-head"]')?.className).toContain('shrink')
    expect(container.querySelector('[data-testid="file-name-head"]')?.className).not.toContain(
      'flex-1'
    )
    const extension = container.querySelector('[data-testid="file-name-extension"]')
    expect(extension?.className).toContain('max-w-[50%]')
    expect(extension?.className).toContain('text-ellipsis')
  })
})
