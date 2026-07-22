// @vitest-environment jsdom
// Pins the user-bubble hover actions and the inline edit flow: copy writes the prompt to the
// clipboard, and edit swaps the bubble for a multi-line editor whose confirm resends the prompt.
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
  options: { canEditMessage?: boolean; onSendEditedMessage?: (doc: ComposerDoc) => void } = {}
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

    const cancelButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    if (!cancelButton) throw new Error('Cancel button not found')
    await click(cancelButton)

    expect(getEditor()).toBeNull()
    expect(onSendEditedMessage).not.toHaveBeenCalled()
    // The original bubble content is back.
    expect(container.textContent).toContain('Prompt text')
  })

  it('resends the adjusted prompt as a new turn and closes the editor', async () => {
    const onSendEditedMessage = vi.fn()
    await renderItem(createMessage(), { canEditMessage: true, onSendEditedMessage })

    await click(getButton('Edit message'))
    const editor = getEditor()
    if (!editor) throw new Error('editor not found')

    await typeIntoEditor(editor, 'edited prompt')

    const sendButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Send'
    )
    if (!sendButton) throw new Error('Send button not found')
    await click(sendButton)

    expect(onSendEditedMessage).toHaveBeenCalledWith({
      nodes: [{ type: 'text', text: 'edited prompt' }]
    })
    expect(getEditor()).toBeNull()
  })
})
