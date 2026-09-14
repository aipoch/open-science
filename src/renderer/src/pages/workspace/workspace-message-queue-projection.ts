import { toRuntimeUploadedAttachment } from '../../../../shared/uploads'
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
  const items = queue.items.filter((item) => item.kind === 'user')
  const index = items.findIndex((item) => item.id === itemId)
  const target = items[direction === 'up' ? index - 1 : index + 1]
  if (index < 0 || !target) return
  moveQueuedItemTo(
    owner,
    optionsRef,
    itemId,
    target.id,
    direction === 'up' ? 'before' : 'after',
    queuedMessageMovedAnnouncement(direction)
  )
}

const moveQueuedItemTo = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  itemId: string,
  targetId: string,
  edge: 'before' | 'after',
  announcement: string = MESSAGE_QUEUE_ANNOUNCEMENTS.reordered
): void => {
  const queue = activeSessionQueue(owner, optionsRef.current.activeSession?.id)
  if (!queue || itemId === targetId) return
  const items = [...queue.items]
  const from = items.findIndex((item) => item.id === itemId)
  if (from < 0 || !items.some((item) => item.id === targetId)) return
  const source = items[from]
  if (source.durableRevision) {
    void owner
      .executeRemote({
        operation: 'move',
        id: source.id,
        revision: source.durableRevision,
        targetId,
        edge
      })
      .catch((error: unknown) => optionsRef.current.composer.setError(String(error)))
    return
  }
  const [moved] = items.splice(from, 1)
  const target = items.findIndex((item) => item.id === targetId)
  items.splice(edge === 'after' ? target + 1 : target, 0, moved)
  owner.queues.set(queue.sessionId, items)
  owner.emit(announcement)
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
  if (item.durableRevision) {
    void owner
      .executeRemote({ operation: 'remove', id: item.id, revision: item.durableRevision })
      .catch((error: unknown) => optionsRef.current.composer.setError(String(error)))
    return
  }
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
  if (item.durableRevision) {
    void owner
      .executeRemote({ operation: 'edit', id: item.id, revision: item.durableRevision })
      .then((result) => {
        if (!result.item || optionsRef.current.activeSession?.id !== result.item.sessionId) return
        const saved = result.item
        if (
          !optionsRef.current.composer.restoreQueuedDraft({
            ...saved.snapshot,
            attachments: saved.snapshot.attachments.map((file) =>
              toRuntimeUploadedAttachment(file, saved.projectId)
            ),
            queuedEdit: {
              kind: 'user',
              sessionId: saved.sessionId,
              agentFrameId: saved.agentFrameId,
              messageBranchId: saved.messageBranchId,
              permissionProfile: saved.permissionProfile,
              agentConfiguration: saved.agentConfiguration,
              specialistId: saved.specialistId,
              agentFrameworkId: saved.agentFrameworkId,
              agentBackendId: saved.agentBackendId,
              projectId: saved.projectId,
              cwd: saved.cwd,
              revisionMessageId: saved.revisionMessageId,
              durableItemId: saved.id,
              durableRevision: saved.revision
            }
          })
        )
          optionsRef.current.composer.setError(
            'Clear the composer before editing this queued message.'
          )
      })
      .catch((error: unknown) => optionsRef.current.composer.setError(String(error)))
    return
  }
  const {
    kind,
    sessionId,
    agentFrameId,
    messageBranchId,
    permissionProfile,
    agentConfiguration,
    specialistId,
    agentFrameworkId,
    agentBackendId,
    projectId,
    cwd,
    revisionMessageId
  } = item
  if (
    !optionsRef.current.composer.restoreQueuedDraft({
      ...item.snapshot,
      queuedEdit: {
        kind,
        sessionId,
        agentFrameId,
        messageBranchId,
        permissionProfile,
        agentConfiguration,
        specialistId,
        agentFrameworkId,
        agentBackendId,
        projectId,
        cwd,
        revisionMessageId
      }
    })
  ) {
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
