// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
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

const createRect = (top: number): DOMRect =>
  ({
    bottom: top + 40,
    height: 40,
    left: 0,
    right: 800,
    top,
    width: 800,
    x: 0,
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
    vi.unstubAllGlobals()
  })

  it('renders only for multiple runs and exposes native keyboard controls', () => {
    const viewportRef = createRef<HTMLDivElement>()
    viewportRef.current = viewport
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 600)
    const items = [
      createMessageItem({ id: 'prompt-1', content: 'First prompt' }, 0),
      createMessageItem({ id: 'prompt-2', content: 'Second prompt' }, 1)
    ]

    const { rerender } = render(
      <WorkspaceRunMarks items={items.slice(0, 1)} viewportRef={viewportRef} />
    )
    expect(screen.queryByRole('navigation', { name: 'Run marks' })).toBeNull()

    rerender(<WorkspaceRunMarks items={items} viewportRef={viewportRef} />)
    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]?.getAttribute('aria-current')).toBe('location')
    buttons[1]?.focus()
    expect(document.activeElement).toBe(buttons[1])
  })

  it('keeps every mark short and gray until hover, then tapers away from the highlighted mark', () => {
    const viewportRef = createRef<HTMLDivElement>()
    viewportRef.current = viewport
    const items = [0, 1, 2, 3, 4].map((index) => {
      const messageId = `prompt-${index}`
      appendMessageTarget(viewport, messageId, 120 + index * 100)
      return createMessageItem({ id: messageId, content: `Prompt ${index}` }, index)
    })
    render(<WorkspaceRunMarks items={items} viewportRef={viewportRef} />)

    const buttons = screen.getAllByRole('button', { name: /Go to run/u })
    const indicators = buttons.map((button) => button.querySelector('span'))
    expect(indicators.every((indicator) => indicator?.classList.contains('scale-x-50'))).toBe(true)
    expect(indicators.every((indicator) => indicator?.className.includes('bg-text-300/60'))).toBe(
      true
    )

    fireEvent.pointerEnter(buttons[2]!)
    expect(indicators[2]?.classList.contains('scale-x-100')).toBe(true)
    expect(indicators[2]?.classList.contains('bg-text-000')).toBe(true)
    expect(indicators[1]?.classList.contains('scale-x-[0.85]')).toBe(true)
    expect(indicators[0]?.classList.contains('scale-x-[0.7]')).toBe(true)
    expect(indicators[4]?.classList.contains('scale-x-[0.7]')).toBe(true)

    fireEvent.pointerLeave(buttons[2]!)
    expect(indicators.every((indicator) => indicator?.classList.contains('scale-x-50'))).toBe(true)
  })

  it('shows the user message and first explicitly linked Agent message on keyboard focus', async () => {
    const viewportRef = createRef<HTMLDivElement>()
    viewportRef.current = viewport
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 600)
    render(
      <WorkspaceRunMarks
        viewportRef={viewportRef}
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
  })

  it('scrolls to the selected run with a clamped offset', () => {
    const viewportRef = createRef<HTMLDivElement>()
    viewportRef.current = viewport
    appendMessageTarget(viewport, 'prompt-1', 120)
    appendMessageTarget(viewport, 'prompt-2', 1_100)
    const scrollTo = vi.fn()
    viewport.scrollTo = scrollTo

    render(
      <WorkspaceRunMarks
        viewportRef={viewportRef}
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
