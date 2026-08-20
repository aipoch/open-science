// @vitest-environment jsdom
// Pins the user-bubble hover actions and the inline edit flow: copy writes the prompt to the
// clipboard, edit swaps the bubble for a multi-line editor, and confirming resends the prompt —
// with a warning first when several later turns would be deleted.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

import type { ComposerDoc } from './composer/composer-doc'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'

// Keep the transcript row and markdown surface as thin wrappers so the test never loads Shiki.
vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: PropsWithChildren): JSX.Element => <div>{children}</div>
}))

vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  PresentedAgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

// Artifact rendering is outside this test's boundary and imports the PDF worker bundle.
vi.mock('./artifact-preview', () => ({
  ArtifactPreview: () => <div data-testid="artifact-preview" />
}))

let container: HTMLDivElement
let root: Root
let notifyResize: (() => void) | undefined

const originalResizeObserver = globalThis.ResizeObserver

const writeText = vi.fn().mockResolvedValue(undefined)

const createMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt text',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const noop = (): void => {}

const renderItem = async (
  message: ChatMessage,
  options: {
    canEditMessage?: boolean
    showUserActions?: boolean
    onSendEditedMessage?: (messageId: string, doc: ComposerDoc) => void
    canBranchInNewSession?: boolean
    onBranchInNewSession?: (messageId: string) => void
    subsequentTurns?: number
    revisionNavigation?: {
      index: number
      total: number
      onPrevious?: () => void
      onNext?: () => void
    }
    reviewerCorrectionActive?: boolean
  } = {}
): Promise<void> => {
  await act(async () => {
    root.render(
      <WorkspaceMessageItem
        message={message}
        onPreviewArtifact={noop}
        onPreviewUploadAttachment={noop}
        onOpenSkillMention={noop}
        onPreviewMentionArtifact={noop}
        canEditMessage={options.canEditMessage ?? false}
        showUserActions={options.showUserActions}
        onSendEditedMessage={options.onSendEditedMessage}
        canBranchInNewSession={options.canBranchInNewSession}
        onBranchInNewSession={options.onBranchInNewSession}
        subsequentTurns={options.subsequentTurns ?? 0}
        revisionNavigation={options.revisionNavigation}
        reviewerCorrectionActive={options.reviewerCorrectionActive}
      />
    )
  })
}

const getButton = (label: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!button) throw new Error(`button "${label}" not found`)
  return button
}

const getEditor = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[role="textbox"][aria-label="Edit message"]')

// The editor card's Send/Cancel buttons are plain text buttons inside the item container.
const getEditorCardButton = (label: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  if (!button) throw new Error(`button "${label}" not found`)
  return button as HTMLButtonElement
}

// The confirmation dialog renders in a body-level portal, outside the item container.
const getDialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]')

const getDialogButton = (label: string): HTMLButtonElement => {
  const dialog = getDialog()
  const button = dialog
    ? Array.from(dialog.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label
      )
    : undefined
  if (!button) throw new Error(`dialog button "${label}" not found`)
  return button as HTMLButtonElement
}

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// Replaces the inline editor's text and lets the editor emit the updated doc, mimicking a typing pass.
const typeIntoEditor = async (editor: HTMLElement, text: string): Promise<void> => {
  await act(async () => {
    editor.textContent = text
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      notifyResize = () => this.callback([], this as unknown as ResizeObserver)
    }
    disconnect(): void {
      notifyResize = undefined
    }
    unobserve(): void {
      notifyResize = undefined
    }
  }
  writeText.mockClear()
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  notifyResize = undefined
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver
  else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
})

describe('WorkspaceMessageItem user message actions', () => {
  it('groups Copy tightly before Branch in a completed Agent Message footer', async () => {
    const onBranchInNewSession = vi.fn()
    await renderItem(
      createMessage({
        id: 'agent-message',
        role: 'agent',
        content: 'Completed analysis',
        completedAt: 1710000001000
      }),
      { canBranchInNewSession: true, onBranchInNewSession }
    )

    const footer = container.querySelector('[data-slot="assistant-message-footer"]')
    const actionGroup = footer?.querySelector('[data-slot="assistant-message-actions"]')
    const copyButton = getButton('Copy message')
    const branchButton = getButton('Branch in new session')
    const completedTime = footer?.querySelector('time')
    if (!footer || !actionGroup || !completedTime) {
      throw new Error('completed Agent Message footer not found')
    }

    expect(actionGroup.classList.contains('gap-0.5')).toBe(true)
    expect(actionGroup.contains(copyButton)).toBe(true)
    expect(actionGroup.contains(branchButton)).toBe(true)
    expect(
      copyButton.compareDocumentPosition(branchButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(
      branchButton.compareDocumentPosition(completedTime) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    await click(copyButton)
    expect(writeText).toHaveBeenCalledWith('Completed analysis')
    await click(branchButton)
    expect(onBranchInNewSession).toHaveBeenCalledWith('agent-message')
  })

  it('keeps the completed Agent Message branch action visible but disabled when unavailable', async () => {
    const onBranchInNewSession = vi.fn()
    await renderItem(
      createMessage({ role: 'agent', content: 'Completed analysis', completedAt: 1710000001000 }),
      { canBranchInNewSession: false, onBranchInNewSession }
    )

    const branchButton = getButton('Branch in new session')
    expect(branchButton.disabled).toBe(true)
    await click(branchButton)
    expect(onBranchInNewSession).not.toHaveBeenCalled()
  })

  it('presents a settled Reviewer Correction as a compact content-free status row', async () => {
    await renderItem(
      createMessage({
        content: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      }),
      {
        canEditMessage: true,
        revisionNavigation: { index: 0, total: 2, onNext: noop }
      }
    )

    expect(container.querySelector('[data-testid="reviewer-correction-message"]')).not.toBeNull()
    expect(container.textContent).toContain('Corrections requested')
    expect(container.textContent).toContain('Handed off to the Agent · response started')
    expect(container.textContent).not.toContain('[Auditor] Correct the unsupported claim.')
    expect(container.querySelector('[data-slot="user-message-bubble"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Message revision"]')).toBeNull()
    expect(container.querySelector('[aria-label="Copy correction"]')).toBeNull()
    expect(container.querySelector('details')).toBeNull()
    expect(
      container.querySelector('[data-testid="reviewer-correction-settled-icon"]')
    ).not.toBeNull()
  })

  it('shows the active correction lifecycle without mounting the correction body', async () => {
    await renderItem(
      createMessage({
        content: '[Auditor] Correct the unsupported claim.',
        attribution: {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: 'review-1'
        }
      }),
      { reviewerCorrectionActive: true }
    )

    expect(container.textContent).toContain('Reviewer requested corrections')
    expect(container.textContent).toContain('Agent is addressing the feedback')
    expect(container.textContent).not.toContain('Handed off to the Agent · response started')
    expect(container.textContent).not.toContain('[Auditor] Correct the unsupported claim.')
    const activeIcon = container.querySelector('[data-testid="reviewer-correction-active-icon"]')
    expect(activeIcon?.getAttribute('class')).toContain('animate-spin')
    expect(activeIcon?.getAttribute('class')).toContain('motion-reduce:animate-none')
  })

  it('keeps matching Auditor text human-authored when attribution is absent', async () => {
    await renderItem(createMessage({ content: '[Auditor] Correct the unsupported claim.' }), {
      canEditMessage: true
    })

    expect(container.querySelector('[data-slot="user-message-bubble"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).not.toBeNull()
  })
  it('keeps the normal Session transcript gutter by default', async () => {
    await renderItem(createMessage())

    const transcriptRow = container.querySelector<HTMLElement>('[class~="pb-1"][class~="pt-5"]')
    expect(transcriptRow?.classList.contains('px-4')).toBe(true)
    expect(transcriptRow?.classList.contains('md:px-6')).toBe(true)
  })

  it('measures the user bubble against the full transcript width', async () => {
    await renderItem(createMessage())

    const bubbleRow = container.querySelector<HTMLElement>('[data-slot="user-bubble-row"]')
    expect(bubbleRow?.classList.contains('w-full')).toBe(true)
  })

  it('collapses user message content beyond twelve lines and expands it downward on demand', async () => {
    await renderItem(createMessage({ content: 'Long prompt line\n'.repeat(13) }))

    const content = container.querySelector<HTMLElement>('[data-slot="user-message-content"]')
    const measurement = container.querySelector<HTMLElement>(
      '[data-slot="user-message-measurement"]'
    )
    if (!content || !measurement) throw new Error('user message content not found')
    expect(measurement.textContent).toBe('')
    expect(measurement.dataset.content).toBe('Long prompt line\n'.repeat(13))
    measurement.style.lineHeight = '20px'
    Object.defineProperty(measurement, 'scrollHeight', { configurable: true, value: 260 })
    act(() => notifyResize?.())

    const showMore = getButton('Show more')
    const ellipsis = container.querySelector<HTMLElement>(
      '[data-slot="user-message-collapse-ellipsis"]'
    )
    expect(content.classList.contains('max-h-[12.5lh]')).toBe(true)
    expect(content.classList.contains('overflow-hidden')).toBe(true)
    expect(ellipsis?.textContent?.trim()).toBe('…')
    expect(ellipsis?.getAttribute('aria-hidden')).toBe('true')
    expect(showMore.classList.contains('mt-1')).toBe(true)
    expect(showMore.getAttribute('aria-expanded')).toBe('false')
    expect(showMore.getAttribute('aria-controls')).toBe(content.id)

    await click(showMore)

    expect(content.classList.contains('max-h-[12.5lh]')).toBe(false)
    expect(content.classList.contains('overflow-hidden')).toBe(false)
    expect(container.querySelector('[data-slot="user-message-collapse-ellipsis"]')).toBeNull()
    const showLess = getButton('Show less')
    expect(showLess.classList.contains('mt-2')).toBe(true)
    expect(showLess.getAttribute('aria-expanded')).toBe('true')

    await click(showLess)

    expect(content.classList.contains('max-h-[12.5lh]')).toBe(true)
    expect(container.querySelector('[data-slot="user-message-collapse-ellipsis"]')).not.toBeNull()
    expect(getButton('Show more').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps short user message content fully visible without an expand control', async () => {
    await renderItem(createMessage({ content: 'Short prompt' }))

    const content = container.querySelector<HTMLElement>('[data-slot="user-message-content"]')
    const measurement = container.querySelector<HTMLElement>(
      '[data-slot="user-message-measurement"]'
    )
    if (!content || !measurement) throw new Error('user message content not found')
    measurement.style.lineHeight = '20px'
    Object.defineProperty(measurement, 'scrollHeight', { configurable: true, value: 240 })
    act(() => notifyResize?.())

    expect(container.querySelector('[aria-label="Show more"]')).toBeNull()
    expect(content.classList.contains('max-h-[12.5lh]')).toBe(false)
  })

  it('remeasures structured content and uses a non-interactive summary while collapsed', async () => {
    const text = 'Structured prompt line\n'.repeat(13)
    const contentText = `${text}/forecast @evidence.csv`
    await renderItem(
      createMessage({
        content: contentText,
        parts: [
          { type: 'text', text },
          { type: 'skill', id: 'skill-forecast', name: 'forecast' },
          { type: 'text', text: ' ' },
          {
            type: 'artifact',
            id: 'artifact-1',
            name: 'evidence.csv',
            path: '/project/evidence.csv',
            source: 'artifact'
          }
        ],
        uploads: [
          {
            id: 'upload-1',
            sessionId: 'session-1',
            name: 'evidence.pdf',
            originalName: 'evidence.pdf',
            mimeType: 'application/pdf',
            size: 1024
          }
        ]
      })
    )

    const content = container.querySelector<HTMLElement>('[data-slot="user-message-content"]')
    const measurement = container.querySelector<HTMLElement>(
      '[data-slot="user-message-measurement"]'
    )
    const attachment = getButton('Preview uploaded attachment evidence.pdf')
    if (!content || !measurement) throw new Error('user message content not found')
    const measuredSkill = measurement.querySelector<HTMLElement>('[data-part-type="skill"]')
    const measuredArtifact = measurement.querySelector<HTMLElement>('[data-part-type="artifact"]')
    expect(measurement.textContent).toBe('')
    expect(measurement.dataset.content).toBeUndefined()
    expect(measuredSkill?.dataset.content).toBe('/forecast')
    expect(measuredSkill?.classList.contains('px-1.5')).toBe(true)
    expect(measuredArtifact?.dataset.content).toBe('@evidence.csv')
    expect(measuredArtifact?.classList.contains('inline-flex')).toBe(true)
    measurement.style.lineHeight = '20px'
    let scrollHeight = 250
    Object.defineProperty(measurement, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight
    })

    act(() => notifyResize?.())
    expect(container.querySelector('[aria-label="Show more"]')).toBeNull()
    expect(getButton('Open skill forecast')).not.toBeNull()

    scrollHeight = 260
    act(() => notifyResize?.())

    expect(getButton('Show more')).not.toBeNull()
    expect(container.querySelector('[aria-label="Open skill forecast"]')).toBeNull()
    expect(container.querySelector('[aria-label="Preview evidence.csv"]')).toBeNull()
    expect(content.textContent).toBe(contentText)
    expect(content.contains(attachment)).toBe(false)

    await click(getButton('Show more'))

    expect(content.contains(getButton('Open skill forecast'))).toBe(true)
    expect(content.contains(getButton('Preview evidence.csv'))).toBe(true)
    expect(getButton('Show less').getAttribute('aria-expanded')).toBe('true')
  })

  it('labels an interrupted user turn without creating another message item', async () => {
    await renderItem(createMessage({ interrupted: true }))

    expect(container.querySelectorAll('[data-slot="user-message-bubble"]')).toHaveLength(1)
    const interruption = container.querySelector('[data-slot="user-message-interrupted"]')
    expect(interruption?.textContent).toBe('This turn was interrupted.')
    expect(interruption?.classList.contains('italic')).toBe(true)
    expect(interruption?.classList.contains('text-amber-600')).toBe(true)
    expect(interruption?.classList.contains('dark:text-amber-400')).toBe(true)
  })

  it('renders copy and edit actions next to user bubbles only', async () => {
    await renderItem(createMessage())

    expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).not.toBeNull()

    await renderItem(createMessage({ role: 'agent' }))

    expect(container.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('renders a delivered Side chat advisory as context instead of an editable user prompt', async () => {
    await renderItem(
      createMessage({
        content: 'Use a black line.',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      })
    )

    expect(container.querySelector('[data-testid="side-chat-advisory"]')?.textContent).toContain(
      'Side chat'
    )
    expect(container.textContent).toContain('Use a black line.')
    expect(container.querySelector('[data-slot="user-message-bubble"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('keeps hover actions left of the bubble and Branch navigation in its footer', async () => {
    await renderItem(createMessage(), {
      canEditMessage: true,
      revisionNavigation: { index: 1, total: 3 }
    })

    const bubbleRow = container.querySelector('[data-slot="user-bubble-row"]')
    const bubble = bubbleRow?.querySelector('[data-slot="user-message-bubble"]')
    const actions = bubbleRow?.querySelector('[data-slot="user-message-actions"]')
    const footer = container.querySelector('[data-slot="user-message-footer"]')
    const revisionNavigation = footer?.querySelector(
      '[data-slot="user-message-revision-navigation"]'
    )
    const sentTime = footer?.querySelector('time')

    if (!bubbleRow || !bubble || !actions || !footer || !revisionNavigation || !sentTime) {
      throw new Error('user bubble layout, actions, footer, time, or revision navigation not found')
    }
    expect(actions.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(bubbleRow.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(sentTime.textContent).toMatch(/^Sent /)
    expect(sentTime.textContent).toMatch(/^Sent [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/)
    expect(sentTime.getAttribute('datetime')).toBe('2024-03-09T16:00:00.000Z')
    expect(footer.classList.contains('text-text-000/70')).toBe(true)
    expect(footer.classList.contains('text-text-300')).toBe(false)
    expect(footer.classList.contains('w-full')).toBe(true)
    expect(footer.classList.contains('flex-wrap')).toBe(true)
    expect(footer.querySelector('[aria-label="Message revision"]')?.textContent).toBe('2/3')
    expect(footer.querySelector('[data-slot="user-message-revision-icon"]')).not.toBeNull()
    expect(actions.querySelector('[aria-label="Message revision"]')).toBeNull()
    expect(
      sentTime.compareDocumentPosition(revisionNavigation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    const copyButton = actions.querySelector('[aria-label="Copy message"]')
    expect(copyButton?.getAttribute('data-state')).toBe('closed')
    expect(copyButton?.classList.contains('focus-visible:ring-[3px]')).toBe(true)
    expect(copyButton?.classList.contains('focus-visible:ring-ring/50')).toBe(true)
    expect(copyButton?.classList.contains('disabled:pointer-events-none')).toBe(true)
    expect(actions.querySelector('[aria-label="Edit message"]')).not.toBeNull()
  })

  it('omits an out-of-range persisted sent time without losing the message', async () => {
    await renderItem(createMessage({ createdAt: Number.MAX_VALUE }))

    expect(container.textContent).toContain('Prompt text')
    expect(container.querySelector('[data-slot="user-message-footer"]')).toBeNull()
  })

  it('keeps Branch navigation available when a persisted sent time is invalid', async () => {
    await renderItem(createMessage({ createdAt: Number.MAX_VALUE }), {
      canEditMessage: true,
      revisionNavigation: { index: 0, total: 2, onNext: noop }
    })

    const footer = container.querySelector('[data-slot="user-message-footer"]')
    expect(footer?.querySelector('time')).toBeNull()
    expect(footer?.querySelector('[aria-label="Message revision"]')?.textContent).toBe('1/2')
  })

  it('hides copy and edit actions on an immutable message surface', async () => {
    await renderItem(createMessage(), { canEditMessage: false, showUserActions: false })

    expect(container.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
  })

  it('switches between message revisions through the rendered navigation controls', async () => {
    const onPrevious = vi.fn()
    const onNext = vi.fn()
    await renderItem(createMessage(), {
      canEditMessage: true,
      revisionNavigation: { index: 1, total: 3, onPrevious, onNext }
    })

    expect(container.querySelector('[aria-label="Message revision"]')?.textContent).toBe('2/3')
    await click(getButton('Previous message revision'))
    await click(getButton('Next message revision'))

    expect(onPrevious).toHaveBeenCalledOnce()
    expect(onNext).toHaveBeenCalledOnce()
  })

  it('copies the message content and confirms with a transient check state', async () => {
    vi.useFakeTimers()
    try {
      await renderItem(createMessage({ content: 'copy me' }))

      await click(getButton('Copy message'))

      expect(writeText).toHaveBeenCalledWith('copy me')
      // The resolved clipboard write swaps the icon to a check until the reset timer fires.
      expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull()

      act(() => {
        vi.advanceTimersByTime(2000)
      })

      expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the editor closed while the run has not settled', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), { canEditMessage: false, onSendEditedMessage })

    const editButton = getButton('Edit message')
    expect(editButton.disabled).toBe(true)

    await click(editButton)
    expect(getEditor()).toBeNull()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
  })

  it('opens an inline editor prefilled from the message, restoring mention chips', async () => {
    await renderItem(
      createMessage({
        content: 'Run /forecast now',
        parts: [
          { type: 'text', text: 'Run ' },
          { type: 'skill', id: 'skill-forecast', name: 'forecast' },
          { type: 'text', text: ' now' }
        ]
      }),
      { canEditMessage: true }
    )

    await click(getButton('Edit message'))

    const editor = getEditor()
    expect(editor).not.toBeNull()
    expect(editor?.textContent).toBe('Run /forecast now')
    // The structured skill segment comes back as a chip, not flattened text.
    expect(editor?.querySelector('[data-mention-type="skill"]')).not.toBeNull()
  })

  it('cancels editing and restores the bubble without resending', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), { canEditMessage: true, onSendEditedMessage })

    await click(getButton('Edit message'))
    expect(getEditor()).not.toBeNull()

    await click(getEditorCardButton('Cancel'))

    expect(getEditor()).toBeNull()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    // The original bubble content is back.
    expect(container.textContent).toContain('Prompt text')
  })

  it('resends the adjusted prompt and closes the editor when few turns follow', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      subsequentTurns: 1
    })

    await click(getButton('Edit message'))
    const editor = getEditor()
    if (!editor) throw new Error('editor not found')

    await typeIntoEditor(editor, 'edited prompt')
    await click(getEditorCardButton('Send'))

    // With fewer than two later turns the resend proceeds without the destructive warning.
    expect(getDialog()).toBeNull()
    expect(onSendEditedMessage).toHaveBeenCalledWith('message-1', {
      nodes: [{ type: 'text', text: 'edited prompt' }]
    })
    expect(getEditor()).toBeNull()
  })

  it('warns before a destructive resend when several turns follow the edited message', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      subsequentTurns: 3
    })

    await click(getButton('Edit message'))
    await click(getEditorCardButton('Send'))

    // The resend waits for explicit confirmation and explains that later turns remain on the old branch.
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    expect(getDialog()?.textContent).toContain('Resend on a new branch?')
    expect(getDialog()?.textContent).toContain('3 turns')

    await click(getDialogButton('Branch and resend'))

    expect(onSendEditedMessage).toHaveBeenCalledWith('message-1', {
      nodes: [{ type: 'text', text: 'Prompt text' }]
    })
    expect(getDialog()).toBeNull()
    expect(getEditor()).toBeNull()
  })

  it('keeps the editor open when the deletion warning is cancelled', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), {
      canEditMessage: true,
      onSendEditedMessage,
      subsequentTurns: 2
    })

    await click(getButton('Edit message'))
    await click(getEditorCardButton('Send'))
    expect(getDialog()).not.toBeNull()

    await click(getDialogButton('Cancel'))

    expect(onSendEditedMessage).not.toHaveBeenCalled()
    expect(getDialog()).toBeNull()
    // The editor stays open so the adjusted draft is not lost.
    expect(getEditor()).not.toBeNull()
  })
})
