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
  type MessageQueueItem,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-owner'

type MessageQueueOptionsRef = { current: WorkspaceMessageQueueControllerOptions }

const dispatchQueuedSession = (
  owner: WorkspaceMessageQueueOwner,
  optionsRef: MessageQueueOptionsRef,
  sessionId: string
): void => {
  if (!owner.ready) return
  let current = owner.resolveOptions(optionsRef.current)
  const existingDispatch = owner.dispatches.get(sessionId)
  const session = current.getSession(sessionId)
  if (!session) {
    // Catalog hydration is asynchronous. Only main's deletion lifecycle removes durable input.
    if (owner.itemsFor(sessionId).some((item) => item.durableRevision)) return
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
  let item: MessageQueueItem | undefined
  // Only skip terminal automatic heads; reserve at most one send per drain.
  for (
    let remainingHeads = owner.itemsFor(sessionId).length;
    remainingHeads > 0;
    remainingHeads--
  ) {
    const head = owner.itemsFor(sessionId)[0]
    if (
      !head ||
      head.phase === 'sending' ||
      head.phase === 'error' ||
      head.phase === 'recovery-required'
    )
      return
    const contextError = queueItemContextError(session, head)
    if (!contextError) {
      item = head
      break
    }
    if (head.kind === 'application') {
      const remaining = owner.itemsFor(sessionId).filter((candidate) => candidate.id !== head.id)
      if (remaining.length === 0) owner.queues.delete(sessionId)
      else owner.queues.set(sessionId, remaining)
      owner.emit()
      head.application?.resolve(undefined)
      continue
    }
    owner.replaceItem(sessionId, head.id, {
      phase: 'error',
      error: contextError,
      deferredUntilIdle: false
    })
    return
  }
  if (!item) return
  if (!current.isSpecialistReady(sessionId)) return
  if (!queueSessionIsSendable(current, session)) return

  if (!item.durableRevision)
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
    let claimedRevision: number | undefined
    try {
      if (item.durableRevision) {
        const claimed = await owner.executeRemote({
          operation: 'claim',
          claimId: crypto.randomUUID(),
          id: item.id,
          revision: item.durableRevision
        })
        claimedRevision = claimed.item?.revision
        if (!claimedRevision) throw new Error('The queued message could not be claimed.')
        current = owner.resolveOptions(optionsRef.current)
        const beforeDispatch = current.getSession(sessionId)
        if (
          !beforeDispatch ||
          queueItemContextError(beforeDispatch, item) ||
          !queueSessionIsSendable(current, beforeDispatch)
        ) {
          await owner.executeRemote({
            operation: 'settle',
            id: item.id,
            revision: claimedRevision,
            outcome: 'deferred'
          })
          owner.dispatches.delete(sessionId)
          return
        }
      }
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
            ...(item.agentFrameworkId ? { expectedFrameworkId: item.agentFrameworkId } : {}),
            agentConfiguration: item.agentConfiguration,
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
            pdfReadingPositionSource: item.snapshot?.pdfReadingPositionSource,
            pendingPdfContextAttachmentIds: item.snapshot?.pendingPdfContextAttachmentIds,
            pendingPdfContextVersions: item.snapshot?.pendingPdfContextVersions,
            cwd: item.cwd,
            projectId: item.projectId,
            permissionProfile: item.permissionProfile,
            ...(item.agentFrameworkId ? { expectedFrameworkId: item.agentFrameworkId } : {}),
            agentConfiguration: item.agentConfiguration,
            forcedSkillIds: item.forcedSkillIds,
            specialistId: item.specialistId,
            messageId: item.application?.messageId ?? (item.durableRevision ? item.id : undefined),
            attribution: item.application?.attribution,
            requireExistingSession:
              item.kind === 'application' || item.durableRevision ? true : undefined
          })
      if (!result) {
        const latest = owner.resolveOptions(optionsRef.current)
        const latestSession = latest.getSession(sessionId)
        if (latestSession && !queueSessionIsSendable(latest, latestSession)) {
          if (owner.dispatches.get(sessionId) === activeDispatch) {
            owner.dispatches.delete(sessionId)
          }
          if (claimedRevision)
            await owner.executeRemote({
              operation: 'settle',
              id: item.id,
              revision: claimedRevision,
              outcome: 'deferred'
            })
          if (!item.durableRevision)
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
      if (claimedRevision)
        await owner.executeRemote({
          operation: 'settle',
          id: item.id,
          revision: claimedRevision,
          outcome: 'sent'
        })
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
        if (claimedRevision) {
          await owner
            .executeRemote({
              operation: 'settle',
              id: item.id,
              revision: claimedRevision,
              outcome: 'uncertain',
              error: { kind: 'send', detail: queueErrorMessage(error) }
            })
            .catch(() => undefined)
        }
        if (!item.durableRevision)
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
  const isCurrentLifetime = owner.captureLifetime()
  const sessionId = optionsRef.current.activeSession?.id
  if (!sessionId) return
  const items = owner.itemsFor(sessionId)
  const item = items.find((candidate) => candidate.id === itemId)
  if (!item?.snapshot || queueItemIsBusy(item)) return
  let claimedRevision: number | undefined
  if (item.durableRevision) {
    const existingDispatch = owner.dispatches.get(sessionId)
    if (existingDispatch && existingDispatch.itemId !== itemId) {
      await existingDispatch.completion
      const latestItem = owner.itemsFor(sessionId).find((candidate) => candidate.id === itemId)
      if (
        !isCurrentLifetime() ||
        !latestItem ||
        queueItemIsBusy(latestItem) ||
        latestItem.durableRevision !== item.durableRevision
      )
        return
    }
    try {
      const claimed = await owner.executeRemote({
        operation: 'claim',
        claimId: crypto.randomUUID(),
        id: item.id,
        revision: item.durableRevision,
        prioritize: true
      })
      claimedRevision = claimed.item!.revision
    } catch (error) {
      optionsRef.current.composer.setError(queueErrorMessage(error))
      return
    }
  }
  let sent = false
  const hasPayload = queuedItemHasPayload(item)
  if (!item.durableRevision) {
    owner.queues.set(sessionId, [
      { ...item, phase: 'sending', error: undefined, deferredUntilIdle: false },
      ...items.filter((candidate) => candidate.id !== itemId)
    ])
    owner.emit()
  }
  try {
    const displacedDispatch = owner.dispatches.get(sessionId)
    if (displacedDispatch && displacedDispatch.itemId !== itemId) {
      await displacedDispatch.completion
    }
    let current = owner.resolveOptions(optionsRef.current)
    let liveSession = current.getSession(sessionId)
    const canContinue = (): boolean => {
      if (!isCurrentLifetime()) return false
      if (!liveSession) {
        owner.discardSession(sessionId, current.composer.discardSnapshot)
        return false
      }
      const contextError = queueItemContextError(liveSession, item)
      if (contextError) {
        if (!item.durableRevision)
          owner.replaceItem(sessionId, itemId, {
            phase: 'error',
            error: contextError,
            deferredUntilIdle: false
          })
        return false
      }
      if (
        current.isPersistenceBlocked(sessionId) ||
        !current.isSpecialistReady(sessionId) ||
        queuePermissionIsPending(current, liveSession) ||
        liveSession.archivedAt !== undefined ||
        !(current.isProjectActive?.(liveSession.projectId) ?? true) ||
        liveSession.conversationGraphSyncBlocked ||
        liveSession.compacting ||
        liveSession.specialistBindingPending === true ||
        current.isBarrierInFlight(sessionId) ||
        current.isSideChatOpen(sessionId)
      ) {
        if (!item.durableRevision)
          owner.replaceItem(sessionId, itemId, {
            phase: 'queued',
            error: undefined,
            deferredUntilIdle: true
          })
        owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.deferredUntilIdle)
        return false
      }
      return true
    }
    if (!canContinue()) return
    if (liveSession?.fixLoopActive) {
      await current.abortFixLoop({
        projectId: liveSession.projectId,
        appSessionId: sessionId
      })
      current = owner.resolveOptions(optionsRef.current)
      liveSession = current.getSession(sessionId)
      if (!canContinue()) return
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
      if (!item.durableRevision)
        owner.replaceItem(sessionId, itemId, {
          phase: 'sending',
          error: undefined,
          deferredUntilIdle: false
        })
      owner.emit(MESSAGE_QUEUE_ANNOUNCEMENTS.steering)
      try {
        const steered = await current.runtime.steerFollowUp({
          sessionId,
          ...(item.agentFrameworkId ? { expectedFrameworkId: item.agentFrameworkId } : {}),
          agentConfiguration: item.agentConfiguration,
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
          sent = true
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
        if (
          claimedRevision &&
          ![
            'empty-text',
            'attachments',
            'no-live-turn',
            'not-advertised',
            'prompt-required'
          ].includes(steered.reason)
        ) {
          throw new Error(
            'The interrupted send may already have reached the agent. Review the conversation before sending again.'
          )
        }
      } catch (error) {
        if (claimedRevision) throw error
        // Native follow-up is fail-closed. Keep the current run and send after it finishes.
      }
    }
    if (liveTurn && hasPayload) {
      const latest = owner.resolveOptions(optionsRef.current)
      const latestSession = latest.getSession(sessionId)
      const latestLiveTurn = isQueueLiveTurn(latestSession)
      if (!latestSession || !latestLiveTurn || queueSessionIsSendable(latest, latestSession)) {
        if (!item.durableRevision)
          owner.replaceItem(sessionId, itemId, {
            phase: 'queued',
            error: undefined,
            deferredUntilIdle: false
          })
        if (owner.dispatches.get(sessionId) === displacedDispatch) {
          owner.dispatches.delete(sessionId)
        }
        if (!claimedRevision) drainQueuedSessions(owner, optionsRef)
        return
      }
      if (!item.durableRevision)
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
      if (!item.durableRevision)
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
    if (!item.durableRevision)
      owner.replaceItem(sessionId, itemId, {
        phase: 'queued',
        error: undefined,
        deferredUntilIdle: false
      })
    if (!claimedRevision) drainQueuedSessions(owner, optionsRef)
  } catch (error) {
    if (claimedRevision) {
      await owner
        .executeRemote({
          operation: 'settle',
          id: item.id,
          revision: claimedRevision,
          outcome: 'uncertain',
          error: { kind: 'cancel', detail: queueErrorMessage(error) }
        })
        .catch(() => undefined)
      claimedRevision = undefined
    }
    if (!item.durableRevision)
      owner.replaceItem(sessionId, itemId, {
        phase: 'error',
        error: { kind: 'cancel', detail: queueErrorMessage(error) },
        deferredUntilIdle: false
      })
  } finally {
    if (claimedRevision) {
      await owner
        .executeRemote({
          operation: 'settle',
          id: item.id,
          revision: claimedRevision,
          outcome: sent ? 'sent' : 'deferred'
        })
        .catch((error) => {
          optionsRef.current.composer.setError(queueErrorMessage(error))
        })
    }
  }
}

export { drainQueuedSessions, sendQueuedItemNow }
