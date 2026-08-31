import { queueItemIsBusy } from './workspace-message-queue-admission'
import {
  MESSAGE_QUEUE_ANNOUNCEMENTS,
  queuedMessageMovedAnnouncement
} from './workspace-message-queue-announcement'
import {
  WorkspaceMessageQueueOwner,
  type MessageQueueItem,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-owner'

type MessageQueueItemView = Pick<
  MessageQueueItem,
  'id' | 'text' | 'attachmentCount' | 'phase' | 'error' | 'deferredUntilIdle'
>

type MessageQueueOptionsRef = { current: WorkspaceMessageQueueControllerOptions }

const activeSessionQueue = (
  owner: WorkspaceMessageQueueOwner,
  activeSessionId: string | undefined
): { sessionId: string; items: MessageQueueItem[] } | undefined =>
  activeSessionId
    ? { sessionId: activeSessionId, items: owner.itemsFor(activeSessionId) }
    : undefined

const projectActiveQueueItems = (
  queues: Map<string, MessageQueueItem[]>,
  activeSessionId: string | undefined
): MessageQueueItemView[] => {
  const activeItems = activeSessionId ? (queues.get(activeSessionId) ?? []) : []
  return activeItems
    .filter((item) => item.kind === 'user')
    .map(({ id, text, attachmentCount, phase, error, deferredUntilIdle }) => ({
      id,
      text,
      attachmentCount,
      phase,
      error,
      ...(deferredUntilIdle ? { deferredUntilIdle: true } : {})
    }))
}

const moveQueuedItem = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  itemId: string,
  direction: 'up' | 'down'
): void => {
  const queue = activeSessionQueue(owner, optionsRef.current.activeSession?.id)
  if (!queue) return
  const items = [...queue.items]
  const index = items.findIndex((item) => item.id === itemId)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= items.length) return
  ;[items[index], items[target]] = [items[target], items[index]]
  owner.queues.set(queue.sessionId, items)
  owner.emit(queuedMessageMovedAnnouncement(direction))
}

const moveQueuedItemTo = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  itemId: string,
  targetId: string,
  edge: 'before' | 'after'
): void => {
  const queue = activeSessionQueue(owner, optionsRef.current.activeSession?.id)
  if (!queue || itemId === targetId) return
  const items = [...queue.items]
  const from = items.findIndex((item) => item.id === itemId)
  if (from < 0 || !items.some((item) => item.id === targetId)) return
  const [moved] = items.splice(from, 1)
  const target = items.findIndex((item) => item.id === targetId)
  items.splice(edge === 'after' ? target + 1 : target, 0, moved)
  owner.queues.set(queue.sessionId, items)
  owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.reordered)
}

const removeQueuedItem = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  itemId: string
): void => {
  const queue = activeSessionQueue(owner, optionsRef.current.activeSession?.id)
  if (!queue) return
  const item = queue.items.find((candidate) => candidate.id === itemId)
  if (!item?.snapshot || queueItemIsBusy(item)) return
  optionsRef.current.composer.discardSnapshot(item.snapshot)
  const remaining = queue.items.filter((candidate) => candidate.id !== itemId)
  if (remaining.length === 0) owner.queues.delete(queue.sessionId)
  else owner.queues.set(queue.sessionId, remaining)
  owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.removed)
}

const editQueuedItem = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  itemId: string
): void => {
  const queue = activeSessionQueue(owner, optionsRef.current.activeSession?.id)
  if (!queue) return
  const item = queue.items.find((candidate) => candidate.id === itemId)
  if (!item?.snapshot || queueItemIsBusy(item)) return
  if (!optionsRef.current.composer.restoreQueuedDraft(item.snapshot)) {
    owner.replaceItem(queue.sessionId, itemId, {
      phase: 'error',
      error: { kind: 'edit' },
      deferredUntilIdle: false
    })
    return
  }
  const remaining = queue.items.filter((candidate) => candidate.id !== itemId)
  if (remaining.length === 0) owner.queues.delete(queue.sessionId)
  else owner.queues.set(queue.sessionId, remaining)
  owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.restoredForEdit)
}

export {
  editQueuedItem,
  moveQueuedItem,
  moveQueuedItemTo,
  projectActiveQueueItems,
  removeQueuedItem
}
export type { MessageQueueItemView }
