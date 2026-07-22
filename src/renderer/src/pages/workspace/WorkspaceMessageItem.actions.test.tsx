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
    onSendEditedMessage?: (messageId: string, doc: ComposerDoc) => void
    subsequentTurns?: number
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
        onSendEditedMessage={options.onSendEditedMessage}
        subsequentTurns={options.subsequentTurns ?? 0}
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
  it('renders copy and edit actions next to user bubbles only', async () => {
    await renderItem(createMessage())

    expect(container.querySelector('[aria-label="Copy message"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).not.toBeNull()

    await renderItem(createMessage({ role: 'agent' }))

    expect(container.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect(container.querySelector('[aria-label="Edit message"]')).toBeNull()
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

    // The resend waits for explicit confirmation, and the dialog names the deletion cost.
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    expect(getDialog()?.textContent).toContain('Resend and overwrite later turns?')
    expect(getDialog()?.textContent).toContain('3 turns')

    await click(getDialogButton('Overwrite and resend'))

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
