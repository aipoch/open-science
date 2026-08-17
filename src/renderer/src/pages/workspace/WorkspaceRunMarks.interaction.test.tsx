// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import type { GroupedConversationItem } from './workspace-tool-activity-groups'
import {
  createRunMarks,
  normalizePreviewText,
  resolveCurrentRunMarkIndex
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
      vi.fn(() => ({
        matches: false,
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

  it('renders only for multiple runs and exposes native keyboard controls', () => {
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 600)
    const items = [
      createMessageItem({ id: 'prompt-1', content: 'First prompt' }, 0),
      createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 1)
    ]

    const { rerender } = render(<WorkspaceRunMarks items={items.slice(0, 1)} viewport={viewport} />)
    expect(screen.queryByRole('navigation', { name: 'Run marks' })).toBeNull()

    rerender(<WorkspaceRunMarks items={items} viewport={viewport} />)
    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.getAttribute('aria-current')).toBe('location')
    buttons[1]?.focus()
    expect(document.activeElement).toBe(buttons[1])
  })

  it('keeps every mark short and gray until hover, then tapers away from the highlighted mark', () => {
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
    expect(indicators.every((indicator) => indicator?.className.includes('bg-text-300/60'))).toBe(
      true
    )

    fireEvent.pointerEnter(buttons[2]!)
    expect(indicators[2]?.classList.contains('scale-x-100')).toBe(true)
    expect(indicators[2]?.classList.contains('bg-text-000')).toBe(true)
    expect(indicators[1]?.classList.contains('scale-x-[0.7]')).toBe(true)
    expect(indicators[0]?.classList.contains('scale-x-[0.55]')).toBe(true)
    expect(indicators[4]?.classList.contains('scale-x-[0.55]')).toBe(true)

    fireEvent.pointerLeave(buttons[2]!)
    expect(indicators.every((indicator) => indicator?.classList.contains('scale-x-[0.4]'))).toBe(
      true
    )
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
    expect(list?.style.height).toBe('50px')
    expect(list?.style.maxHeight).toBe('calc(100vh - 6rem)')

    viewportHeight = 240
    await act(async () => {
      notifyResize?.()
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    expect(rail.style.top).toBe('440px')
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
          createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 1)
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Go to run 2/u }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' })
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
  })
})
