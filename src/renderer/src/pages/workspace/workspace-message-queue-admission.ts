import { DEFAULT_PERMISSION_PROFILE } from '../../../../shared/permission-profiles'
import type { ChatSession } from '@/stores/session-store'

import { docToArtifactRefs } from './composer/composer-doc'
import { MESSAGE_QUEUE_ANNOUNCEMENTS } from './workspace-message-queue-announcement'
import {
  WorkspaceMessageQueueOwner,
  type MessageQueueAdmission,
  type MessageQueueError,
  type MessageQueueItem,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-owner'

const queueErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const activeBranchIdentity = (
  session: ChatSession
): { agentFrameId: string; messageBranchId: string } | undefined => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find((candidate) => candidate.id === graph.activeFrameId)
  return frame ? { agentFrameId: frame.id, messageBranchId: frame.activeBranchId } : undefined
}

const queueBranchMatches = (session: ChatSession, item: MessageQueueItem): boolean => {
  const identity = activeBranchIdentity(session)
  return (
    identity?.agentFrameId === item.agentFrameId &&
    identity.messageBranchId === item.messageBranchId
  )
}

const queueItemContextError = (
  session: ChatSession,
  item: MessageQueueItem
): MessageQueueError | undefined => {
  if (!queueBranchMatches(session, item)) return { kind: 'branch' }
  if ((session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE) !== item.permissionProfile) {
    return { kind: 'send' }
  }
  if (session.specialistId !== item.specialistId) return { kind: 'send' }
  return undefined
}

const queuePermissionIsPending = (
  options: WorkspaceMessageQueueControllerOptions,
  session: ChatSession
): boolean =>
  session.runtimeContext?.permission?.state === 'pending' ||
  options.hasPendingPermissionRequest(session.id)

const queuedAdmissionFailure = (
  sessionBefore: Pick<ChatSession, 'status' | 'error' | 'updatedAt'> | undefined,
  sessionAfter: Pick<ChatSession, 'status' | 'error' | 'updatedAt'> | undefined
): string => {
  const causedError =
    sessionAfter?.status === 'error' &&
    Boolean(sessionAfter.error) &&
    (sessionBefore?.status !== 'error' ||
      sessionBefore.error !== sessionAfter.error ||
      sessionBefore.updatedAt !== sessionAfter.updatedAt)
  return causedError && sessionAfter.error
    ? sessionAfter.error
    : 'The queued message was not admitted.'
}

const queueSessionIsSendable = (
  options: WorkspaceMessageQueueControllerOptions,
  session: ChatSession
): boolean =>
  session.archivedAt === undefined &&
  (options.isProjectActive?.(session.projectId) ?? true) &&
  (session.status === 'idle' || session.status === 'error') &&
  // Errored turns have no live reveal to wait for; let the queue proceed immediately.
  (session.status === 'error' || !options.isPresentationRevealing(session.id)) &&
  !options.promptInFlightSessionIds.includes(session.id) &&
  !options.sendPreparationInFlightSessionIds.includes(session.id) &&
  !options.saveAsSkillInFlightSessionIds.includes(session.id) &&
  !queuePermissionIsPending(options, session) &&
  !session.fixLoopActive &&
  !session.conversationGraphSyncBlocked &&
  !session.compacting &&
  session.specialistBindingPending !== true &&
  !options.isBarrierInFlight(session.id) &&
  !options.isSideChatOpen(session.id)

const queueItemIsBusy = (item: MessageQueueItem): boolean =>
  item.phase === 'sending' || item.phase === 'interrupting'

const queuedItemHasPayload = (item: MessageQueueItem): boolean =>
  Boolean(item.text.trim()) ||
  item.attachmentCount > 0 ||
  item.forcedSkillIds.length > 0 ||
  docToArtifactRefs(item.snapshot.doc).length > 0

const isQueueLiveTurn = (session: ChatSession | undefined): boolean =>
  session?.status === 'running' ||
  session?.status === 'waiting-for-user' ||
  session?.status === 'waiting-permission'

const queueBlocksImmediateSend = (
  owner: WorkspaceMessageQueueOwner,
  options: WorkspaceMessageQueueControllerOptions,
  sessionId: string
): boolean => {
  const activeDispatch = owner.dispatches.get(sessionId)
  return (
    owner.itemsFor(sessionId).length > 0 ||
    Boolean(
      activeDispatch &&
      !(
        activeDispatch.settled &&
        owner.resolveOptions(options).getSession(sessionId)?.status === 'error'
      )
    )
  )
}

const enqueueQueuedMessage = (
  owner: WorkspaceMessageQueueOwner,
  setComposerError: (error: string | null) => void,
  admission: MessageQueueAdmission
): boolean => {
  const { session, snapshot, ...intent } = admission
  const identity = activeBranchIdentity(session)
  if (!identity) {
    setComposerError('Wait for the active message branch to finish loading, then try again.')
    return false
  }
  const item: MessageQueueItem = {
    id: owner.createQueueItemId(),
    sessionId: session.id,
    ...identity,
    snapshot,
    attachmentCount: snapshot.attachments.length,
    projectId: session.projectId,
    cwd: session.cwd,
    phase: 'queued',
    ...intent
  }
  owner.queues.set(session.id, [...owner.itemsFor(session.id), item])
  owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.added)
  return true
}

export {
  enqueueQueuedMessage,
  isQueueLiveTurn,
  queueBlocksImmediateSend,
  queueErrorMessage,
  queueItemContextError,
  queueItemIsBusy,
  queuePermissionIsPending,
  queueSessionIsSendable,
  queuedAdmissionFailure,
  queuedItemHasPayload
}
