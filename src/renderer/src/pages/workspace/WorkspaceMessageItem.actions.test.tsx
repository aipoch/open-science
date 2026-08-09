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
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

// Artifact rendering is outside this test's boundary and imports the PDF worker bundle.
vi.mock('./artifact-preview', () => ({
  ArtifactPreview: () => <div data-testid="artifact-preview" />
}))

let container: HTMLDivElement
let root: Root

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
    subsequentTurns?: number
    revisionNavigation?: {
      index: number
      total: number
      onPrevious?: () => void
      onNext?: () => void
    }
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
        subsequentTurns={options.subsequentTurns ?? 0}
        revisionNavigation={options.revisionNavigation}
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
})

describe('WorkspaceMessageItem user message actions', () => {
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
