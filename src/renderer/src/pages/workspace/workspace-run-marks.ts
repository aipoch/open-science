import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/session-store'

import { isHiddenControlMessage, isHumanUserMessage } from '../../../../shared/session-persistence'
import type { WorkspaceConversationTimelineItem } from './workspace-conversation-timeline'

type RunMark = {
  id: string
  userMessage: ChatMessage
  agentMessage?: ChatMessage
}

const RUN_MARK_READING_BOUNDARY_PX = 32

const normalizePreviewText = (
  message: ChatMessage,
  fallback: { attachment: string; content: string; image: string }
): string => {
  const text = message.content.replace(/\s+/gu, ' ').trim()
  if (text) return text
  if ((message.images?.length ?? 0) > 0) return fallback.image
  if ((message.uploads?.length ?? 0) > 0) return fallback.attachment
  return fallback.content
}

// One Run Mark belongs to one visible human prompt. Agent preview ownership is explicit: older
// messages without responseToMessageId never gain a guessed association from timeline adjacency.
const createRunMarks = (items: readonly WorkspaceConversationTimelineItem[]): RunMark[] => {
  const messages = items.flatMap((item) =>
    item.type === 'message' && !isHiddenControlMessage(item.message) ? [item.message] : []
  )
  const firstAgentMessageByRunId = new Map<string, ChatMessage>()

  for (const message of messages) {
    if (
      message.role !== 'agent' ||
      !message.responseToMessageId ||
      firstAgentMessageByRunId.has(message.responseToMessageId)
    ) {
      continue
    }
    firstAgentMessageByRunId.set(message.responseToMessageId, message)
  }

  return messages.flatMap((message): RunMark[] => {
    if (!isHumanUserMessage(message)) return []
    const agentMessage = firstAgentMessageByRunId.get(message.id)

    return [{ id: message.id, userMessage: message, agentMessage }]
  })
}

// Visual navigation segments run from one human prompt to the next in the already-filtered
// timeline. This lookup also covers mounted replies when their prompt is outside the DOM window;
// it does not change the explicit ownership used to build Agent previews.
const createRunMarkItemIndex = (
  items: readonly WorkspaceConversationTimelineItem[],
  marks: readonly RunMark[]
): Map<string, number> => {
  const indexByPromptId = new Map(marks.map((mark, index) => [mark.id, index]))
  const indexByItemId = new Map<string, number>()
  let index = -1
  for (const item of items) {
    if (item.type === 'message' && isHiddenControlMessage(item.message)) continue
    index = indexByPromptId.get(item.id) ?? index
    if (index >= 0) indexByItemId.set(item.id, index)
  }
  return indexByItemId
}

const findMessageTarget = (viewport: HTMLDivElement, messageId: string): HTMLElement | undefined =>
  Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (element) => element.dataset.messageId === messageId
  )

const resolveCurrentRunMarkPosition = (
  viewport: HTMLDivElement,
  marks: readonly RunMark[]
): number => {
  const boundary = viewport.getBoundingClientRect().top + RUN_MARK_READING_BOUNDARY_PX
  const targetTopByMessageId = new Map(
    Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).flatMap((element) => {
      const messageId = element.dataset.messageId
      return messageId ? [[messageId, element.getBoundingClientRect().top] as const] : []
    })
  )
  let currentIndex = 0

  marks.forEach((mark, index) => {
    const targetTop = targetTopByMessageId.get(mark.id)
    if (targetTop !== undefined && targetTop <= boundary) currentIndex = index
  })

  const currentTop = targetTopByMessageId.get(marks[currentIndex]?.id)
  const nextTop = targetTopByMessageId.get(marks[currentIndex + 1]?.id)
  const progress =
    currentTop !== undefined && nextTop !== undefined && nextTop > currentTop
      ? Math.max(0, Math.min(1, (boundary - currentTop) / (nextTop - currentTop)))
      : 0
  return currentIndex + progress
}

const resolveCurrentRunMarkIndex = (viewport: HTMLDivElement, marks: readonly RunMark[]): number =>
  Math.floor(resolveCurrentRunMarkPosition(viewport, marks))

const runMarkIndicatorClassName = (
  highlightedIndex: number | null,
  markIndex: number,
  visible = false
): string => {
  const distance = highlightedIndex === null ? undefined : Math.abs(highlightedIndex - markIndex)

  return cn(
    'block h-0.5 w-5 origin-left rounded-full transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-active/run-mark:translate-x-px motion-reduce:transition-none rtl:origin-right',
    distance === 0
      ? 'scale-x-100 bg-text-000'
      : distance === 1
        ? 'scale-x-[0.7] bg-text-200'
        : distance === 2
          ? 'scale-x-[0.55] bg-text-300/80'
          : distance === 3
            ? 'scale-x-[0.48] bg-text-300/70'
            : 'scale-x-[0.4] bg-text-300/60',
    visible && 'bg-text-000'
  )
}

export {
  createRunMarks,
  createRunMarkItemIndex,
  findMessageTarget,
  normalizePreviewText,
  resolveCurrentRunMarkIndex,
  resolveCurrentRunMarkPosition,
  runMarkIndicatorClassName
}
export type { RunMark }
