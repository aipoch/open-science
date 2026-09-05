import { docToArtifactRefs, docToMessageParts } from './composer/composer-doc'
import { MESSAGE_QUEUE_ANNOUNCEMENTS } from './workspace-message-queue-announcement'
import {
  isQueueLiveTurn,
  queueErrorMessage,
  queueItemContextError,
  queueItemIsBusy,
  queuePermissionIsPending,
  queueSessionIsSendable,
  queuedAdmissionFailure,
  queuedItemHasPayload
} from './workspace-message-queue-admission'
import {
  WorkspaceMessageQueueOwner,
  type MessageQueueDispatch,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-owner'

type MessageQueueOptionsRef = { current: WorkspaceMessageQueueControllerOptions }

const dispatchQueuedSession = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  sessionId: string
): void => {
  const current = owner.resolveOptions(optionsRef.current)
  const existingDispatch = owner.dispatches.get(sessionId)
  const session = current.getSession(sessionId)
  if (!session) {
    if (existingDispatch && !existingDispatch.settled) return
    owner.dispatches.delete(sessionId)
    owner.discardSession(sessionId, current.composer.discardSnapshot)
    return
  }
  if (existingDispatch) {
    if (!existingDispatch.settled) return
    if (session.status === 'error') {
      owner.dispatches.delete(sessionId)
    } else {
      if (!queueSessionIsSendable(current, session)) {
        owner.dispatches.delete(sessionId)
      }
      return
    }
  }
  const item = owner.itemsFor(sessionId)[0]
  if (!item || item.phase === 'sending' || item.phase === 'error') return
  const contextError = queueItemContextError(session, item)
  if (contextError) {
    if (item.kind === 'application') {
      const remaining = owner.itemsFor(sessionId).filter((candidate) => candidate.id !== item.id)
      if (remaining.length === 0) owner.queues.delete(sessionId)
      else owner.queues.set(sessionId, remaining)
      owner.emit()
      item.application?.resolve(undefined)
      return
    }
    owner.replaceItem(sessionId, item.id, {
      phase: 'error',
      error: contextError,
      deferredUntilIdle: false
    })
    return
  }
  if (!current.isSpecialistReady(sessionId)) return
  if (!queueSessionIsSendable(current, session)) return

  owner.replaceItem(sessionId, item.id, {
    phase: 'sending',
    error: undefined,
    deferredUntilIdle: false
  })
  let resolveCompletion!: () => void
  const activeDispatch: MessageQueueDispatch = {
    itemId: item.id,
    settled: false,
    completion: new Promise((resolve) => {
      resolveCompletion = resolve
    })
  }
  owner.dispatches.set(sessionId, activeDispatch)
  void (async (): Promise<void> => {
    try {
      const sessionBeforeSend = current.getSession(sessionId)
      const sessionBeforeAdmission = sessionBeforeSend
        ? {
            status: sessionBeforeSend.status,
            error: sessionBeforeSend.error,
            updatedAt: sessionBeforeSend.updatedAt
          }
        : undefined
      if (item.revisionMessageId && !current.runtime.resendEditedMessage) {
        throw new Error('Queued message revision is unavailable.')
      }
      const result = item.revisionMessageId
        ? await current.runtime.resendEditedMessage!(sessionId, item.revisionMessageId, {
            text: item.text,
            annotations: item.snapshot?.annotations,
            referencedArtifacts: item.snapshot ? docToArtifactRefs(item.snapshot.doc) : undefined,
            parts: item.snapshot ? docToMessageParts(item.snapshot.doc) : undefined,
            forcedSkillIds: item.forcedSkillIds
          })
        : await current.runtime.sendMessage({
            sessionId,
            text: item.text,
            attachments: item.snapshot?.attachments,
            annotations: item.snapshot?.annotations,
            referencedArtifacts: item.snapshot ? docToArtifactRefs(item.snapshot.doc) : undefined,
            parts: item.snapshot ? docToMessageParts(item.snapshot.doc) : undefined,
            pdfContext: item.snapshot?.pdfContext,
            pdfReadingPosition: item.snapshot?.pdfReadingPosition,
            pendingPdfContextAttachmentIds: item.snapshot?.pendingPdfContextAttachmentIds,
            pendingPdfContextVersions: item.snapshot?.pendingPdfContextVersions,
            cwd: item.cwd,
            projectId: item.projectId,
            permissionProfile: item.permissionProfile,
            agentConfiguration: item.agentConfiguration,
            forcedSkillIds: item.forcedSkillIds,
            specialistId: item.specialistId,
            messageId: item.application?.messageId,
            attribution: item.application?.attribution,
            requireExistingSession: item.kind === 'application' ? true : undefined
          })
      if (!result) {
        const latest = owner.resolveOptions(optionsRef.current)
        const latestSession = latest.getSession(sessionId)
        if (latestSession && !queueSessionIsSendable(latest, latestSession)) {
          if (owner.dispatches.get(sessionId) === activeDispatch) {
            owner.dispatches.delete(sessionId)
          }
          owner.replaceItem(sessionId, item.id, {
            phase: 'queued',
            error: undefined,
            deferredUntilIdle: true
          })
          owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
          return
        }
        throw new Error(queuedAdmissionFailure(sessionBeforeAdmission, latestSession))
      }
      const latest = owner.itemsFor(sessionId)
      const remaining = latest.filter((candidate) => candidate.id !== item.id)
      if (remaining.length === 0) {
        owner.queues.delete(sessionId)
        if (owner.dispatches.get(sessionId) === activeDispatch) {
          owner.dispatches.delete(sessionId)
        }
      } else {
        owner.queues.set(sessionId, remaining)
      }
      owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.sent)
      item.application?.resolve(typeof result === 'object' ? result : undefined)
    } catch (error) {
      if (owner.dispatches.get(sessionId) === activeDispatch) {
        owner.dispatches.delete(sessionId)
      }
      if (item.kind === 'application') {
        const remaining = owner.itemsFor(sessionId).filter((candidate) => candidate.id !== item.id)
        if (remaining.length === 0) owner.queues.delete(sessionId)
        else owner.queues.set(sessionId, remaining)
        owner.emit()
        item.application?.resolve(undefined)
      } else {
        owner.replaceItem(sessionId, item.id, {
          phase: 'error',
          error: { kind: 'send', detail: queueErrorMessage(error) },
          deferredUntilIdle: false
        })
      }
    } finally {
      activeDispatch.settled = true
      resolveCompletion()
      if (!owner.resolveOptions(optionsRef.current).getSession(sessionId)) {
        if (owner.dispatches.get(sessionId) === activeDispatch) {
          owner.dispatches.delete(sessionId)
        }
        owner.discardSession(
          sessionId,
          owner.resolveOptions(optionsRef.current).composer.discardSnapshot
        )
      }
    }
  })()
}

const drainQueuedSessions = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef
): void => {
  for (const sessionId of owner.queues.keys()) dispatchQueuedSession(owner, optionsRef, sessionId)
}

const sendQueuedItemNow = async (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  itemId: string
): Promise<void> => {
  const sessionId = optionsRef.current.activeSession?.id
  if (!sessionId) return
  const items = owner.itemsFor(sessionId)
  const item = items.find((candidate) => candidate.id === itemId)
  if (!item?.snapshot || queueItemIsBusy(item)) return
  const hasPayload = queuedItemHasPayload(item)
  owner.queues.set(sessionId, [
    { ...item, phase: 'sending', error: undefined, deferredUntilIdle: false },
    ...items.filter((candidate) => candidate.id !== itemId)
  ])
  owner.emit()
  try {
    const displacedDispatch = owner.dispatches.get(sessionId)
    if (displacedDispatch && displacedDispatch.itemId !== itemId) {
      await displacedDispatch.completion
    }
    const current = owner.resolveOptions(optionsRef.current)
    const session = current.getSession(sessionId)
    if (session?.fixLoopActive) {
      await current.abortFixLoop({
        projectId: session.projectId,
        appSessionId: sessionId
      })
    }
    const liveSession = current.getSession(sessionId)
    if (liveSession) {
      if (current.isPersistenceBlocked(sessionId)) {
        owner.replaceItem(sessionId, itemId, {
          phase: 'queued',
          error: undefined,
          deferredUntilIdle: true
        })
        owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
        return
      }
      const contextError = queueItemContextError(liveSession, item)
      if (contextError) {
        owner.replaceItem(sessionId, itemId, {
          phase: 'error',
          error: contextError,
          deferredUntilIdle: false
        })
        return
      }
      if (!current.isSpecialistReady(sessionId)) {
        owner.replaceItem(sessionId, itemId, {
          phase: 'queued',
          error: undefined,
          deferredUntilIdle: true
        })
        owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
        return
      }
      if (queuePermissionIsPending(current, liveSession)) {
        owner.replaceItem(sessionId, itemId, {
          phase: 'queued',
          error: undefined,
          deferredUntilIdle: true
        })
        owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
        return
      }
    }
    const liveTurn = isQueueLiveTurn(liveSession)
    const referencedArtifacts = docToArtifactRefs(item.snapshot.doc)
    if (
      liveTurn &&
      hasPayload &&
      !item.revisionMessageId &&
      current.runtime.steerFollowUp &&
      !item.snapshot.annotations?.length &&
      !item.snapshot.pdfContext &&
      !item.snapshot.pendingPdfContextAttachmentIds?.length &&
      !item.snapshot.pendingPdfContextVersions?.length
    ) {
      owner.replaceItem(sessionId, itemId, {
        phase: 'sending',
        error: undefined,
        deferredUntilIdle: false
      })
      owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.steering)
      try {
        const steered = await current.runtime.steerFollowUp({
          sessionId,
          text: item.text,
          ...(item.snapshot.attachments.length > 0
            ? { attachments: item.snapshot.attachments }
            : {}),
          ...(referencedArtifacts.length > 0 ? { referencedArtifacts } : {}),
          ...(item.forcedSkillIds.length > 0 ? { forcedSkillIds: item.forcedSkillIds } : {}),
          ...(docToMessageParts(item.snapshot.doc).length > 0
            ? { parts: docToMessageParts(item.snapshot.doc) }
            : {})
        })
        if (steered.injected) {
          const latest = owner.itemsFor(sessionId)
          const remaining = latest.filter((candidate) => candidate.id !== item.id)
          if (remaining.length === 0) owner.queues.delete(sessionId)
          else owner.queues.set(sessionId, remaining)
          if (owner.dispatches.get(sessionId) === displacedDispatch) {
            owner.dispatches.delete(sessionId)
          }
          owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.sent)
          return
        }
      } catch {
        // Native follow-up is fail-closed. Keep the current run and send after it finishes.
      }
    }
    if (liveTurn && hasPayload) {
      const latest = owner.resolveOptions(optionsRef.current)
      const latestSession = latest.getSession(sessionId)
      const latestLiveTurn = isQueueLiveTurn(latestSession)
      if (!latestSession || !latestLiveTurn || queueSessionIsSendable(latest, latestSession)) {
        owner.replaceItem(sessionId, itemId, {
          phase: 'queued',
          error: undefined,
          deferredUntilIdle: false
        })
        if (owner.dispatches.get(sessionId) === displacedDispatch) {
          owner.dispatches.delete(sessionId)
        }
        drainQueuedSessions(owner, optionsRef)
        return
      }
      owner.replaceItem(sessionId, itemId, {
        phase: 'queued',
        error: undefined,
        deferredUntilIdle: true
      })
      if (owner.dispatches.get(sessionId) === displacedDispatch) {
        owner.dispatches.delete(sessionId)
      }
      owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
      return
    }
    if (liveTurn) {
      owner.replaceItem(sessionId, itemId, {
        phase: 'queued',
        error: undefined,
        deferredUntilIdle: true
      })
      owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
      return
    }
    if (owner.dispatches.get(sessionId) === displacedDispatch) {
      owner.dispatches.delete(sessionId)
    }
    owner.replaceItem(sessionId, itemId, {
      phase: 'queued',
      error: undefined,
      deferredUntilIdle: false
    })
    drainQueuedSessions(owner, optionsRef)
  } catch (error) {
    owner.replaceItem(sessionId, itemId, {
      phase: 'error',
      error: { kind: 'cancel', detail: queueErrorMessage(error) },
      deferredUntilIdle: false
    })
  }
}

export { drainQueuedSessions, sendQueuedItemNow }
