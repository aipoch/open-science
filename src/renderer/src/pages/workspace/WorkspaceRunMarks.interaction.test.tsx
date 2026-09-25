// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import type { GroupedConversationItem } from './workspace-tool-activity-groups'
import {
  createRunMarks,
  normalizePreviewText,
  resolveCurrentRunMarkIndex,
  resolveCurrentRunMarkPosition
} from './workspace-run-marks'
import { WorkspaceRunMarks } from './WorkspaceRunMarks'

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_000_000,
  ...overrides
})

const createMessageItem = (
  overrides: Partial<ChatMessage>,
  sortIndex: number
): GroupedConversationItem => {
  const message = createMessage(overrides)
  return {
    id: message.id,
    type: 'message',
    createdAt: message.createdAt,
    sortIndex,
    message
  }
}

const createRect = (top: number, height = 40, left = 0, width = 800): DOMRect =>
  ({
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({})
  }) as DOMRect

const appendMessageTarget = (viewport: HTMLDivElement, messageId: string, top: number): void => {
  const target = document.createElement('article')
  target.dataset.messageId = messageId
  target.getBoundingClientRect = () => createRect(top)
  viewport.append(target)
}

describe('WorkspaceRunMarks projection', () => {
  it('creates marks only for visible human-authored user messages', () => {
    const marks = createRunMarks([
      createMessageItem({ id: 'prompt-1', content: 'First prompt' }, 0),
      createMessageItem(
        {
          id: 'reviewer-correction',
          attribution: {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          }
        },
        1
      ),
      createMessageItem(
        {
          id: 'relayed-message',
          relayedFrom: { kind: 'side-chat', direction: 'to-main' }
        },
        2
      ),
      createMessageItem({ id: 'hidden-control', turnIntent: 'save-as-skill' }, 3),
      createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 4)
    ])

    expect(marks.map((mark) => mark.id)).toEqual(['prompt-1', 'prompt-2'])
  })

  it('uses only the first explicitly linked Agent message and never infers a legacy association', () => {
    const marks = createRunMarks([
      createMessageItem({ id: 'prompt-1', content: 'First prompt' }, 0),
      createMessageItem(
        { id: 'legacy-agent', role: 'agent', content: 'Legacy response without ownership' },
        1
      ),
      createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 2),
      createMessageItem(
        {
          id: 'agent-2a',
          role: 'agent',
          content: 'First visible response',
          responseToMessageId: 'prompt-2'
        },
        3
      ),
      createMessageItem(
        {
          id: 'agent-2b',
          role: 'agent',
          content: 'Later response',
          responseToMessageId: 'prompt-2'
        },
        4
      )
    ])

    expect(marks[0]?.agentMessage).toBeUndefined()
    expect(marks[1]?.agentMessage?.id).toBe('agent-2a')
  })

  it('keeps persisted response status out of the Run Mark projection', () => {
    const items = [
      createMessageItem({ id: 'prompt-loading' }, 0),
      createMessageItem({ id: 'prompt-error' }, 1),
      createMessageItem(
        {
          id: 'agent-error',
          role: 'agent',
          responseToMessageId: 'prompt-error',
          status: 'error'
        },
        2
      ),
      createMessageItem({ id: 'prompt-success' }, 3),
      createMessageItem(
        {
          id: 'agent-success',
          role: 'agent',
          responseToMessageId: 'prompt-success',
          status: 'complete'
        },
        4
      )
    ]

    expect(createRunMarks(items).map((mark) => mark.id)).toEqual([
      'prompt-loading',
      'prompt-error',
      'prompt-success'
    ])
    expect(createRunMarks(items).every((mark) => !('state' in mark))).toBe(true)
  })

  it('normalizes preview text and uses attachment fallbacks for empty messages', () => {
    const fallback = { attachment: 'Attachment', content: 'Content', image: 'Image' }
    expect(normalizePreviewText(createMessage({ content: '  two\n lines  ' }), fallback)).toBe(
      'two lines'
    )
    expect(
      normalizePreviewText(
        createMessage({
          content: '',
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'notes.txt',
              originalName: 'notes.txt',
              path: '/workspace/notes.txt',
              mimeType: 'text/plain',
              size: 12
            }
          ]
        }),
        fallback
      )
    ).toBe('Attachment')
  })
})

describe('WorkspaceRunMarks interaction', () => {
  let viewport: HTMLDivElement
  let panel: HTMLElement | undefined

  beforeEach(() => {
    viewport = document.createElement('div')
    viewport.getBoundingClientRect = () => createRect(100)
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 0, writable: true }
    })
    document.body.append(viewport)
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(min-width: 48rem)',
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    )
  })

  afterEach(() => {
    cleanup()
    viewport.remove()
    panel?.remove()
    panel = undefined
    vi.unstubAllGlobals()
  })

  it('renders from four runs and exposes native keyboard controls', () => {
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 600)
    const items = [
      createMessageItem({ id: 'prompt-1', content: 'First prompt' }, 0),
      createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 1),
      createMessageItem({ id: 'prompt-3' }, 2),
      createMessageItem({ id: 'prompt-4' }, 3)
    ]

    const { rerender } = render(<WorkspaceRunMarks items={items.slice(0, 3)} viewport={viewport} />)
    expect(screen.queryByRole('navigation', { name: 'Run marks' })).toBeNull()

    rerender(<WorkspaceRunMarks items={items} viewport={viewport} />)
    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    expect(buttons).toHaveLength(4)
    expect(buttons[0]?.getAttribute('aria-current')).toBe('location')
    buttons[1]?.focus()
    expect(document.activeElement).toBe(buttons[1])
  })

  it('does not observe or measure layouts when the run-mark rail is hidden', async () => {
    let notifyResize: (() => void) | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver)
        }

        observe(): void {
          // no-op
        }

        disconnect(): void {
          // no-op
        }
      }
    )
    const viewportRect = vi.spyOn(viewport, 'getBoundingClientRect')
    const items = [0, 1, 2].map((index) =>
      createMessageItem({ id: `prompt-${index}`, content: `Prompt ${index}` }, index)
    )

    render(<WorkspaceRunMarks items={items} viewport={viewport} />)
    viewportRect.mockClear()
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      notifyResize?.()
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    expect(notifyResize).toBeUndefined()
    expect(viewportRect).not.toHaveBeenCalled()
  })

  it('skips message geometry on mobile while retaining resize recovery', async () => {
    const items = Array.from({ length: 6 }, (_, index) => {
      appendMessageTarget(viewport, `prompt-${index}`, 100 + index * 100)
      return createMessageItem({ id: `prompt-${index}` }, index)
    })
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList)
    const reads = [...viewport.children].map((element) =>
      vi.spyOn(element, 'getBoundingClientRect')
    )
    render(<WorkspaceRunMarks items={items} viewport={viewport} />)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true)
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(screen.getByRole('navigation', { name: 'Run marks' })).toBeTruthy()
  })

  it('measures each mounted message once for a coalesced resize', async () => {
    const items = Array.from({ length: 6 }, (_, index) => {
      appendMessageTarget(viewport, `prompt-${index}`, 100 + index * 100)
      return createMessageItem({ id: `prompt-${index}` }, index)
    })
    render(<WorkspaceRunMarks items={items} viewport={viewport} />)
    const reads = [...viewport.children].map((element) =>
      vi.spyOn(element, 'getBoundingClientRect')
    )
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(reads.map((read) => read.mock.calls.length)).toEqual(items.map(() => 1))
  })

  it('keeps visible marks dark at rest while hover tapers mark lengths independently', () => {
    const items = [0, 1, 2, 3, 4].map((index) => {
      const messageId = `prompt-${index}`
      appendMessageTarget(viewport, messageId, 120 + index * 100)
      return createMessageItem({ id: messageId, content: `Prompt ${index}` }, index)
    })
    render(<WorkspaceRunMarks items={items} viewport={viewport} />)

    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    const indicators = buttons.map((button) => button.querySelector('span'))
    expect(indicators.every((indicator) => indicator?.classList.contains('scale-x-[0.4]'))).toBe(
      true
    )
    expect(indicators[0]?.classList.contains('bg-text-000')).toBe(true)
    expect(
      indicators.slice(1).every((indicator) => indicator?.className.includes('bg-text-300/60'))
    ).toBe(true)

    fireEvent.pointerEnter(buttons[2]!)
    expect(indicators[2]?.classList.contains('scale-x-100')).toBe(true)
    expect(indicators[2]?.classList.contains('bg-text-000')).toBe(true)
    expect(indicators[1]?.classList.contains('scale-x-[0.7]')).toBe(true)
    expect(indicators[0]?.classList.contains('scale-x-[0.55]')).toBe(true)
    expect(indicators[4]?.classList.contains('scale-x-[0.55]')).toBe(true)

    fireEvent.pointerLeave(buttons[2]!)
    fireEvent.pointerLeave(screen.getByRole('list'))
    expect(indicators.every((indicator) => indicator?.classList.contains('scale-x-[0.4]'))).toBe(
      true
    )
  })

  it('coalesces fractional pointer positions and cancels a pending wave on dismissal', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const items = Array.from({ length: 9 }, (_, index) => {
      appendMessageTarget(viewport, `prompt-${index}`, 120 + index * 100)
      return createMessageItem({ id: `prompt-${index}` }, index)
    })
    render(<WorkspaceRunMarks items={items} viewport={viewport} />)
    const rail = screen.getByRole('list')
    rail.getBoundingClientRect = () => createRect(100, 72, 20, 24)
    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    const scale = (index: number): number =>
      parseFloat(buttons[index]!.querySelector('span')!.style.scale)
    fireEvent.pointerEnter(buttons[4]!)
    expect(scale(4)).toBe(1)
    expect(scale(3)).toBeGreaterThan(scale(2))
    expect(scale(0)).toBeCloseTo(0.4)
    const frames = vi.spyOn(window, 'requestAnimationFrame')
    fireEvent.pointerMove(rail, { clientY: 137 })
    fireEvent.pointerMove(rail, { clientY: 138 })
    expect(frames).toHaveBeenCalledTimes(1)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(scale(4)).toBeLessThan(1)
    expect(scale(4)).toBeGreaterThan(scale(5))
    expect(scale(5)).toBeGreaterThan(scale(3))
    fireEvent.pointerMove(rail, { clientY: 140 })
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(scale(4)).toBe(0.4)
    expect(screen.queryByRole('tooltip')).toBeNull()
    frames.mockRestore()
  })

  it('highlights all visible segments and follows replies even when their prompt is unmounted', async () => {
    viewport.getBoundingClientRect = () => createRect(100, 400)
    const items = [
      createMessageItem({ id: 'prompt-0' }, 0),
      createMessageItem({ id: 'reply-0', role: 'agent', responseToMessageId: 'prompt-0' }, 1),
      createMessageItem({ id: 'prompt-1' }, 2),
      createMessageItem({ id: 'prompt-2' }, 3),
      createMessageItem({ id: 'prompt-3' }, 4)
    ]
    for (const [id, top] of [
      ['reply-0', 80],
      ['prompt-1', 200],
      ['prompt-2', 600],
      ['prompt-3', 800]
    ] as const) {
      appendMessageTarget(viewport, id, top)
      const target = viewport.lastElementChild as HTMLElement
      target.getBoundingClientRect = () => createRect(top - viewport.scrollTop)
    }
    render(<WorkspaceRunMarks items={items} viewport={viewport} onRevealMessage={vi.fn()} />)
    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    const visible = (): boolean[] => buttons.map((button) => button.dataset.visible === 'true')
    expect(visible()).toEqual([true, true, false, false])
    expect(buttons[0]?.querySelector('span')?.className).toContain('bg-text-000')
    await act(async () => {
      viewport.scrollTop = 500
      fireEvent.scroll(viewport)
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })
    expect(visible()).toEqual([false, false, true, true])
    expect(buttons[0]?.querySelector('span')?.className).toContain('bg-text-300/60')
    fireEvent.pointerEnter(buttons[2]!)
    fireEvent.pointerLeave(buttons[2]!)
    fireEvent.pointerLeave(screen.getByRole('list'))
    expect(buttons[2]?.querySelector('span')?.className).toContain('bg-text-000')
    expect(buttons[3]?.querySelector('span')?.className).toContain('bg-text-000')
  })

  it('keeps a compact rail fixed to the conversation panel when the scroller is squeezed', async () => {
    let notifyResize: (() => void) | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}

        observe(): void {
          notifyResize = () => this.callback([], this as unknown as ResizeObserver)
        }

        disconnect(): void {
          /* Test observer has no resources to release. */
        }
        unobserve(): void {
          /* Test observer tracks one shared callback only. */
        }
      }
    )

    panel = document.createElement('section')
    panel.dataset.sessionId = 'session-1'
    panel.getBoundingClientRect = () => createRect(40, 800, 200, 1_000)
    panel.append(viewport)
    document.body.append(panel)

    let viewportHeight = 520
    viewport.getBoundingClientRect = () => createRect(80, viewportHeight, 216, 968)
    const items = [0, 1, 2, 3, 4].map((index) => {
      const messageId = `prompt-${index}`
      appendMessageTarget(viewport, messageId, 120 + index * 100)
      return createMessageItem({ id: messageId, content: `Prompt ${index}` }, index)
    })

    render(<WorkspaceRunMarks items={items} viewport={viewport} />)

    const rail = screen.getByRole('navigation', { name: 'Run marks' })
    const list = rail.querySelector('ol')
    expect(rail.className).toContain('fixed')
    expect(rail.style.left).toBe('208px')
    expect(rail.style.top).toBe('440px')
    expect(list?.style.height).toBe('40px')
    expect(list?.style.maxHeight).toBe('calc(100vh - 6rem)')

    fireEvent.focus(screen.getAllByRole('button', { name: /Go to run/u })[0]!)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    viewportHeight = 240
    await act(async () => {
      notifyResize?.()
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    expect(rail.style.top).toBe('440px')
    expect(screen.getByRole('tooltip')).toBeTruthy()
    panel.getBoundingClientRect = () => createRect(80, 800, 200, 1_000)
    await act(async () => {
      notifyResize?.()
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })
    expect(rail.style.top).toBe('480px')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('bounds dense spacing and follows transcript progress only beyond the visible rail edges', async () => {
    const items = Array.from({ length: 100 }, (_, index) => {
      const id = `prompt-${index}`
      appendMessageTarget(viewport, id, 100 + index * 100)
      const target = viewport.lastElementChild as HTMLElement
      target.getBoundingClientRect = () => createRect(100 + index * 100 - viewport.scrollTop)
      return createMessageItem({ id }, index)
    })
    render(<WorkspaceRunMarks items={items} viewport={viewport} />)
    const rail = screen.getByRole('list')
    Object.defineProperties(rail, {
      clientHeight: { value: 480 },
      scrollHeight: { value: 800 }
    })
    expect(screen.getAllByRole('button').length).toBeLessThan(100)
    expect(rail.style.height).toBe('480px')
    expect(rail.className).toContain('overflow-hidden')

    const scrollTranscript = async (top: number): Promise<void> => {
      await act(async () => {
        viewport.scrollTop = top
        fireEvent.scroll(viewport)
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      })
    }
    await scrollTranscript(1_000)
    expect(rail.scrollTop).toBe(0)
    await scrollTranscript(5_900)
    expect(rail.scrollTop).toBeCloseTo(10.56)
    await scrollTranscript(5_950)
    expect(rail.scrollTop).toBeCloseTo(14.56)
    await scrollTranscript(5_900)
    expect(rail.scrollTop).toBeCloseTo(14.56)
    await scrollTranscript(100)
    expect(rail.scrollTop).toBeCloseTo(2.56)
    await scrollTranscript(0)
    expect(rail.scrollTop).toBe(0)
    await scrollTranscript(9_900)
    expect(rail.scrollTop).toBe(320)
  })

  it('shows the user message and first explicitly linked Agent message on keyboard focus', async () => {
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 600)
    render(
      <WorkspaceRunMarks
        viewport={viewport}
        items={[
          createMessageItem({ id: 'prompt-1', content: 'Only the user preview' }, 0),
          createMessageItem({ id: 'prompt-2', content: 'Question with response' }, 1),
          createMessageItem({ id: 'prompt-3' }, 3),
          createMessageItem({ id: 'prompt-4' }, 4),
          createMessageItem(
            {
              id: 'agent-2',
              role: 'agent',
              content: 'First visible Agent response',
              responseToMessageId: 'prompt-2'
            },
            2
          )
        ]}
      />
    )

    fireEvent.focus(screen.getByRole('button', { name: /Go to run 2/u }))
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('Question with response')
    expect(tooltip.textContent).toContain('First visible Agent response')
    const previewLines = tooltip.querySelectorAll('p')
    expect(previewLines[0]?.classList.contains('truncate')).toBe(true)
    expect(previewLines[0]?.classList.contains('font-semibold')).toBe(true)
    expect(previewLines[0]?.classList.contains('text-text-000')).toBe(true)
    expect(previewLines[1]?.classList.contains('line-clamp-2')).toBe(true)
    expect(previewLines[1]?.classList.contains('text-text-200')).toBe(true)
  })

  it('scrolls to the selected run with a clamped offset', () => {
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 1_100)
    const scrollTo = vi.fn()
    viewport.scrollTo = scrollTo

    render(
      <WorkspaceRunMarks
        viewport={viewport}
        items={[
          createMessageItem({ id: 'prompt-1', content: 'First prompt' }, 0),
          createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 1),
          createMessageItem({ id: 'prompt-3' }, 2),
          createMessageItem({ id: 'prompt-4' }, 3)
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Go to run 2/u }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })
  })

  it('moves the same preview between marks, clamps it and dismisses it with Escape', () => {
    const items = Array.from({ length: 4 }, (_, index) =>
      createMessageItem({ id: `prompt-${index}`, content: `Question ${index}` }, index)
    )
    render(<WorkspaceRunMarks items={items} viewport={viewport} onRevealMessage={vi.fn()} />)
    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    buttons[0]!.getBoundingClientRect = () => createRect(200, 20, 200, 24)
    buttons[1]!.getBoundingClientRect = () => createRect(300, 20, 200, 24)
    fireEvent.pointerEnter(buttons[0]!)
    const preview = screen.getByRole('tooltip')
    expect(preview.textContent).toBe('Question 0')
    expect(preview.style.transform).toBe('translate3d(232px, 166px, 0)')
    fireEvent.pointerLeave(buttons[0]!)
    fireEvent.pointerEnter(buttons[1]!)
    expect(screen.getByRole('tooltip')).toBe(preview)
    expect(preview.textContent).toBe('Question 1')
    expect(preview.style.transform).toBe('translate3d(232px, 266px, 0)')
    expect(buttons[1]!.getAttribute('aria-describedby')).toBe(preview.id)
    buttons[2]!.getBoundingClientRect = () => createRect(-40, 20, window.innerWidth, 24)
    fireEvent.focus(buttons[2]!)
    expect(preview.style.transform).toBe(`translate3d(${window.innerWidth - 268}px, 12px, 0)`)
    viewport.style.direction = 'rtl'
    buttons[3]!.getBoundingClientRect = () => createRect(300, 20, 800, 24)
    fireEvent.focus(buttons[3]!)
    expect(preview.style.transform).toBe('translate3d(536px, 266px, 0)')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(buttons[2]!.hasAttribute('aria-describedby')).toBe(false)
  })

  it('keeps the preview hoverable and cancels delayed dismissal on rapid reentry', () => {
    vi.useFakeTimers()
    try {
      const items = Array.from({ length: 4 }, (_, index) =>
        createMessageItem({ id: `prompt-${index}` }, index)
      )
      render(<WorkspaceRunMarks items={items} viewport={viewport} onRevealMessage={vi.fn()} />)
      const button = screen.getAllByRole('button')[0]!
      fireEvent.pointerEnter(button)
      const preview = screen.getByRole('tooltip')
      fireEvent.pointerLeave(button)
      fireEvent.pointerEnter(preview)
      act(() => vi.advanceTimersByTime(200))
      expect(screen.getByRole('tooltip')).toBe(preview)
      fireEvent.pointerLeave(preview)
      act(() => vi.advanceTimersByTime(120))
      expect(screen.queryByRole('tooltip')).toBeNull()
      fireEvent.focus(button)
      fireEvent.blur(button)
      fireEvent.focus(button)
      act(() => vi.advanceTimersByTime(200))
      expect(screen.getByRole('tooltip')).toBe(preview)
      fireEvent.blur(button)
      act(() => vi.advanceTimersByTime(120))
      expect(screen.queryByRole('tooltip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals unmounted targets, honors reduced motion and resets preview across scopes', () => {
    const items = Array.from({ length: 4 }, (_, index) =>
      createMessageItem({ id: `prompt-${index}` }, index)
    )
    const reveal = vi.fn()
    const { rerender } = render(
      <WorkspaceRunMarks
        key="branch-a"
        items={items}
        viewport={viewport}
        onRevealMessage={reveal}
      />
    )
    fireEvent.focus(screen.getAllByRole('button')[0]!)
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(reveal).toHaveBeenCalledWith('prompt-0')
    expect(screen.queryByRole('tooltip')).toBeNull()
    appendMessageTarget(viewport, 'prompt-1', 300)
    viewport.scrollTo = vi.fn()
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList)
    fireEvent.click(screen.getAllByRole('button')[1]!)
    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 192, behavior: 'auto' })
    fireEvent.focus(screen.getAllByRole('button')[0]!)
    rerender(
      <WorkspaceRunMarks
        key="branch-b"
        items={items}
        viewport={viewport}
        onRevealMessage={reveal}
      />
    )
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(screen.getAllByRole('button')[0]!)
    fireEvent.scroll(viewport)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(screen.getAllByRole('button')[0]!)
    fireEvent(window, new Event('resize'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('tracks the last mark above the viewport reading boundary', () => {
    appendMessageTarget(viewport, 'prompt-1', 80)
    appendMessageTarget(viewport, 'prompt-2', 125)
    appendMessageTarget(viewport, 'prompt-3', 300)
    const marks = createRunMarks([
      createMessageItem({ id: 'prompt-1' }, 0),
      createMessageItem({ id: 'prompt-2' }, 1),
      createMessageItem({ id: 'prompt-3' }, 2)
    ])

    expect(resolveCurrentRunMarkIndex(viewport, marks)).toBe(1)
    expect(resolveCurrentRunMarkPosition(viewport, marks)).toBeCloseTo(1.04)
  })
})
