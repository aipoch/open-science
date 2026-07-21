// @vitest-environment jsdom
// Pins the user-bubble hover actions: copy writes the prompt to the clipboard, and edit is gated
// by the settled-run flag and hands the message back so the page can reload it into the composer.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '@/stores/session-store'

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
  options: { canEditMessage?: boolean; onEditMessage?: (message: ChatMessage) => void } = {}
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
        onEditMessage={options.onEditMessage}
      />
    )
  })
}

const getButton = (label: string): HTMLButtonElement => {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  if (!button) throw new Error(`button "${label}" not found`)
  return button
}

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

  it('keeps edit disabled while the run has not settled', async () => {
    const onEditMessage = vi.fn()
    await renderItem(createMessage(), { canEditMessage: false, onEditMessage })

    const editButton = getButton('Edit message')
    expect(editButton.disabled).toBe(true)

    await click(editButton)
    expect(onEditMessage).not.toHaveBeenCalled()
  })

  it('hands the message back for editing once the run has settled', async () => {
    const onEditMessage = vi.fn()
    const message = createMessage()
    await renderItem(message, { canEditMessage: true, onEditMessage })

    const editButton = getButton('Edit message')
    expect(editButton.disabled).toBe(false)

    await click(editButton)
    expect(onEditMessage).toHaveBeenCalledWith(message)
  })
})
