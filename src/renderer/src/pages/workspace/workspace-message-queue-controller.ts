import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
  type ReactElement
} from 'react'

import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import { docToArtifactRefs } from './composer/composer-doc'
import {
  isWorkspaceSpecialistBarrierInFlight,
  subscribeWorkspaceSpecialistBarriers
} from './workspace-specialist-barrier'
import { subscribeWorkspacePresentationRevealing } from './workspace-presentation-revealing'
import { useOpenSideChatParentSessionIds } from './use-side-chat-controller'
import type { ComposerSendSnapshot } from './workspace-composer-controller'
import {
  WorkspaceMessageQueueOwner,
  type MessageQueueDispatch,
  type MessageQueueError,
  type MessageQueueItem,
  type MessageQueuePhase,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-owner'

type MessageQueueItemView = Pick<
  MessageQueueItem,
  'id' | 'text' | 'attachmentCount' | 'phase' | 'error' | 'deferredUntilIdle'
>

type MessageQueueAdmission = {
  session: ChatSession
  snapshot: ComposerSendSnapshot
  text: string
  forcedSkillIds: string[]
  permissionProfile: PermissionProfileId
  agentConfiguration: SessionAgentConfiguration
  specialistId: string | null | undefined
}

type WorkspaceMessageQueueController = {
  items: MessageQueueItemView[]
  announcement: string
  actions: {
    move: (itemId: string, direction: 'up' | 'down') => void
    moveTo: (itemId: string, targetId: string, edge: 'before' | 'after') => void
    remove: (itemId: string) => void
    edit: (itemId: string) => void
    sendNow: (itemId: string) => Promise<void>
  }
  lifecycle: {
    enqueue: (admission: MessageQueueAdmission) => boolean
    blocksImmediateSend: (sessionId: string) => boolean
  }
}

const WorkspaceMessageQueueContext = createContext<WorkspaceMessageQueueOwner | null>(null)

const useWorkspaceMessageQueueOwner = (): WorkspaceMessageQueueOwner => {
  const providedOwner = useContext(WorkspaceMessageQueueContext)
  const [localOwner] = useState(() => new WorkspaceMessageQueueOwner())
  useEffect(
    () => (providedOwner ? undefined : () => localOwner.dispose()),
    [localOwner, providedOwner]
  )
  return providedOwner ?? localOwner
}

const useProvidedWorkspaceMessageQueueOwner = (): WorkspaceMessageQueueOwner => {
  const owner = useContext(WorkspaceMessageQueueContext)
  if (!owner) throw new Error('Workspace message queue provider is missing.')
  return owner
}

const WorkspaceMessageQueueProvider = ({ children }: PropsWithChildren): ReactElement => {
  const [owner] = useState(() => new WorkspaceMessageQueueOwner())
  useEffect(() => {
    const unsubscribeBarriers = subscribeWorkspaceSpecialistBarriers(owner.requestDrain)
    const unsubscribePresentation = subscribeWorkspacePresentationRevealing(owner.requestDrain)
    return () => {
      unsubscribeBarriers()
      unsubscribePresentation()
      owner.dispose()
    }
  }, [owner])
  return createElement(WorkspaceMessageQueueContext.Provider, { value: owner }, children)
}

const WorkspaceMessageQueueRuntimeBridge = (): null => {
  const owner = useProvidedWorkspaceMessageQueueOwner()
  const runtime = useWorkspaceAgentRuntime()
  const specialistCatalogLoaded = useSpecialistStore((state) => state.isLoaded)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const openSideChatParentSessionIds = useOpenSideChatParentSessionIds()
  useLayoutEffect(() => {
    owner.updateRuntime({
      promptInFlightSessionIds: runtime.promptInFlightSessionIds,
      sendPreparationInFlightSessionIds: runtime.sendPreparationInFlightSessionIds,
      saveAsSkillInFlightSessionIds: runtime.saveAsSkillInFlightSessionIds,
      runtime,
      isBarrierInFlight: isWorkspaceSpecialistBarrierInFlight,
      isSpecialistReady: (sessionId) => {
        const session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === sessionId)
        if (!session) return false
        if (session.specialistBindingPending === true) return false
        if (session.specialistId === undefined) return true
        if (!specialistCatalogLoaded) {
          void loadSpecialists()
          return false
        }
        return specialistItems.some(
          (item) => item.kind === 'custom' && item.enabled && item.id === session.specialistId
        )
      },
      isSideChatOpen: (sessionId) => openSideChatParentSessionIds.has(sessionId),
      hasPendingPermissionRequest: (sessionId) =>
        runtime.pendingPermissions.some((request) => request.sessionId === sessionId),
      abortFixLoop: (request) => window.api.reviewer.abortFixLoop(request),
      getSession: (sessionId) =>
        useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId),
      subscribeSessionChanges: useSessionStore.subscribe
    })
  }, [
    loadSpecialists,
    openSideChatParentSessionIds,
    owner,
    runtime,
    specialistCatalogLoaded,
    specialistItems
  ])
  return null
}

const errorMessage = (error: unknown): string =>
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

const queueSessionIsSendable = (
  options: WorkspaceMessageQueueControllerOptions,
  session: ChatSession
): boolean =>
  session.archivedAt === undefined &&
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

const useWorkspaceMessageQueueController = (
  options: WorkspaceMessageQueueControllerOptions
): WorkspaceMessageQueueController => {
  const owner = useWorkspaceMessageQueueOwner()
  const { subscribeSessionChanges } = options
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  const { queues: queueSnapshot, announcement } = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot
  )

  const emit = useCallback(
    (message?: string): void => {
      owner.emit(message)
    },
    [owner]
  )
  const itemsFor = useCallback(
    (sessionId: string): MessageQueueItem[] => owner.queues.get(sessionId) ?? [],
    [owner]
  )
  const replaceItem = useCallback(
    (
      sessionId: string,
      itemId: string,
      update: Partial<Pick<MessageQueueItem, 'phase' | 'error' | 'deferredUntilIdle'>>
    ): void => {
      const items = itemsFor(sessionId)
      const index = items.findIndex((item) => item.id === itemId)
      if (index < 0) return
      const next = [...items]
      next[index] = { ...next[index], ...update }
      owner.queues.set(sessionId, next)
      emit()
    },
    [emit, itemsFor, owner]
  )
  const discardSession = useCallback(
    (sessionId: string): void => {
      const current = owner.resolveOptions(optionsRef.current)
      for (const item of itemsFor(sessionId)) current.composer.discardSnapshot(item.snapshot)
      owner.queues.delete(sessionId)
      emit()
    },
    [emit, itemsFor, owner]
  )
  const dispatch = useCallback(
    (sessionId: string): void => {
      const current = owner.resolveOptions(optionsRef.current)
      const existingDispatch = owner.dispatches.get(sessionId)
      const session = current.getSession(sessionId)
      if (!session) {
        if (existingDispatch && !existingDispatch.settled) return
        owner.dispatches.delete(sessionId)
        discardSession(sessionId)
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
      const item = itemsFor(sessionId)[0]
      if (!item || item.phase === 'sending' || item.phase === 'error') return
      const contextError = queueItemContextError(session, item)
      if (contextError) {
        replaceItem(sessionId, item.id, {
          phase: 'error',
          error: contextError,
          deferredUntilIdle: false
        })
        return
      }
      if (!current.isSpecialistReady(sessionId)) return
      if (!queueSessionIsSendable(current, session)) return

      replaceItem(sessionId, item.id, {
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
          const result = await current.runtime.sendMessage({
            sessionId,
            text: item.text,
            attachments: item.snapshot.attachments,
            referencedArtifacts: docToArtifactRefs(item.snapshot.doc),
            parts: item.snapshot.doc.nodes,
            cwd: item.cwd,
            projectId: item.projectId,
            permissionProfile: item.permissionProfile,
            agentConfiguration: item.agentConfiguration,
            forcedSkillIds: item.forcedSkillIds,
            specialistId: item.specialistId
          })
          if (!result) {
            const latest = owner.resolveOptions(optionsRef.current)
            const latestSession = latest.getSession(sessionId)
            if (latestSession && !queueSessionIsSendable(latest, latestSession)) {
              if (owner.dispatches.get(sessionId) === activeDispatch) {
                owner.dispatches.delete(sessionId)
              }
              replaceItem(sessionId, item.id, {
                phase: 'queued',
                error: undefined,
                deferredUntilIdle: true
              })
              emit('Queued message will send after the current run finishes.')
              return
            }
            throw new Error('The queued message was not admitted.')
          }
          const latest = itemsFor(sessionId)
          const remaining = latest.filter((candidate) => candidate.id !== item.id)
          if (remaining.length === 0) {
            owner.queues.delete(sessionId)
            if (owner.dispatches.get(sessionId) === activeDispatch) {
              owner.dispatches.delete(sessionId)
            }
          } else {
            owner.queues.set(sessionId, remaining)
          }
          emit('Queued message sent.')
        } catch (error) {
          if (owner.dispatches.get(sessionId) === activeDispatch) {
            owner.dispatches.delete(sessionId)
          }
          replaceItem(sessionId, item.id, {
            phase: 'error',
            error: { kind: 'send', detail: errorMessage(error) },
            deferredUntilIdle: false
          })
        } finally {
          activeDispatch.settled = true
          resolveCompletion()
          if (!owner.resolveOptions(optionsRef.current).getSession(sessionId)) {
            if (owner.dispatches.get(sessionId) === activeDispatch) {
              owner.dispatches.delete(sessionId)
            }
            discardSession(sessionId)
          }
        }
      })()
    },
    [discardSession, emit, itemsFor, owner, replaceItem]
  )
  const drainQueues = useCallback((): void => {
    for (const sessionId of owner.queues.keys()) dispatch(sessionId)
  }, [dispatch, owner])
  const currentSessionQueue = useCallback(():
    { sessionId: string; items: MessageQueueItem[] } | undefined => {
    const sessionId = optionsRef.current.activeSession?.id
    return sessionId ? { sessionId, items: itemsFor(sessionId) } : undefined
  }, [itemsFor])
  const blocksImmediateSend = useCallback(
    (sessionId: string): boolean => {
      const activeDispatch = owner.dispatches.get(sessionId)
      return (
        itemsFor(sessionId).length > 0 ||
        Boolean(
          activeDispatch &&
          !(
            activeDispatch.settled &&
            owner.resolveOptions(optionsRef.current).getSession(sessionId)?.status === 'error'
          )
        )
      )
    },
    [itemsFor, owner]
  )

  const enqueue = useCallback(
    ({ session, snapshot, ...intent }: MessageQueueAdmission): boolean => {
      const identity = activeBranchIdentity(session)
      if (!identity) {
        optionsRef.current.composer.setError(
          'Wait for the active message branch to finish loading, then try again.'
        )
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
      owner.queues.set(session.id, [...itemsFor(session.id), item])
      emit('Message added to queue.')
      return true
    },
    [emit, itemsFor, owner]
  )
  const move = useCallback(
    (itemId: string, direction: 'up' | 'down'): void => {
      const queue = currentSessionQueue()
      if (!queue) return
      const items = [...queue.items]
      const index = items.findIndex((item) => item.id === itemId)
      const target = direction === 'up' ? index - 1 : index + 1
      if (index < 0 || target < 0 || target >= items.length) return
      ;[items[index], items[target]] = [items[target], items[index]]
      owner.queues.set(queue.sessionId, items)
      emit(`Queued message moved ${direction}.`)
    },
    [currentSessionQueue, emit, owner]
  )
  const moveTo = useCallback(
    (itemId: string, targetId: string, edge: 'before' | 'after'): void => {
      const queue = currentSessionQueue()
      if (!queue || itemId === targetId) return
      const items = [...queue.items]
      const from = items.findIndex((item) => item.id === itemId)
      if (from < 0 || !items.some((item) => item.id === targetId)) return
      const [moved] = items.splice(from, 1)
      const target = items.findIndex((item) => item.id === targetId)
      items.splice(edge === 'after' ? target + 1 : target, 0, moved)
      owner.queues.set(queue.sessionId, items)
      emit('Queued messages reordered.')
    },
    [currentSessionQueue, emit, owner]
  )
  const remove = useCallback(
    (itemId: string): void => {
      const queue = currentSessionQueue()
      if (!queue) return
      const item = queue.items.find((candidate) => candidate.id === itemId)
      if (!item || item.phase === 'sending' || item.phase === 'interrupting') return
      optionsRef.current.composer.discardSnapshot(item.snapshot)
      const remaining = queue.items.filter((candidate) => candidate.id !== itemId)
      if (remaining.length === 0) owner.queues.delete(queue.sessionId)
      else owner.queues.set(queue.sessionId, remaining)
      emit('Queued message removed.')
    },
    [currentSessionQueue, emit, owner]
  )
  const edit = useCallback(
    (itemId: string): void => {
      const queue = currentSessionQueue()
      if (!queue) return
      const item = queue.items.find((candidate) => candidate.id === itemId)
      if (!item || item.phase === 'sending' || item.phase === 'interrupting') return
      if (!optionsRef.current.composer.restoreQueuedDraft(item.snapshot)) {
        replaceItem(queue.sessionId, itemId, {
          phase: 'error',
          error: { kind: 'edit' },
          deferredUntilIdle: false
        })
        return
      }
      const remaining = queue.items.filter((candidate) => candidate.id !== itemId)
      if (remaining.length === 0) owner.queues.delete(queue.sessionId)
      else owner.queues.set(queue.sessionId, remaining)
      emit('Queued message moved to the composer for editing.')
    },
    [currentSessionQueue, emit, owner, replaceItem]
  )
  const sendNow = useCallback(
    async (itemId: string): Promise<void> => {
      const queue = currentSessionQueue()
      if (!queue) return
      const item = queue.items.find((candidate) => candidate.id === itemId)
      if (!item || item.phase === 'sending' || item.phase === 'interrupting') return
      const hasPayload =
        Boolean(item.text.trim()) ||
        item.attachmentCount > 0 ||
        item.forcedSkillIds.length > 0 ||
        docToArtifactRefs(item.snapshot.doc).length > 0
      owner.queues.set(queue.sessionId, [
        { ...item, phase: 'sending', error: undefined, deferredUntilIdle: false },
        ...queue.items.filter((candidate) => candidate.id !== itemId)
      ])
      emit()
      try {
        const displacedDispatch = owner.dispatches.get(queue.sessionId)
        if (displacedDispatch && displacedDispatch.itemId !== itemId) {
          await displacedDispatch.completion
        }
        const current = owner.resolveOptions(optionsRef.current)
        const session = current.getSession(queue.sessionId)
        if (session?.fixLoopActive) {
          await current.abortFixLoop({
            projectId: session.projectId,
            appSessionId: queue.sessionId
          })
        }
        const liveSession = current.getSession(queue.sessionId)
        if (liveSession) {
          const contextError = queueItemContextError(liveSession, item)
          if (contextError) {
            replaceItem(queue.sessionId, itemId, {
              phase: 'error',
              error: contextError,
              deferredUntilIdle: false
            })
            return
          }
          if (!current.isSpecialistReady(queue.sessionId)) {
            replaceItem(queue.sessionId, itemId, {
              phase: 'queued',
              error: undefined,
              deferredUntilIdle: true
            })
            emit('Queued message will send after the current run finishes.')
            return
          }
          if (queuePermissionIsPending(current, liveSession)) {
            replaceItem(queue.sessionId, itemId, {
              phase: 'queued',
              error: undefined,
              deferredUntilIdle: true
            })
            emit('Queued message will send after the current run finishes.')
            return
          }
        }
        const liveTurn =
          liveSession?.status === 'running' ||
          liveSession?.status === 'waiting-for-user' ||
          liveSession?.status === 'waiting-permission'
        const referencedArtifacts = docToArtifactRefs(item.snapshot.doc)
        if (liveTurn && hasPayload && current.runtime.steerFollowUp) {
          replaceItem(queue.sessionId, itemId, {
            phase: 'sending',
            error: undefined,
            deferredUntilIdle: false
          })
          emit('Sending the queued message into the current run.')
          try {
            const steered = await current.runtime.steerFollowUp({
              sessionId: queue.sessionId,
              text: item.text,
              ...(item.snapshot.attachments.length > 0
                ? { attachments: item.snapshot.attachments }
                : {}),
              ...(referencedArtifacts.length > 0 ? { referencedArtifacts } : {}),
              ...(item.forcedSkillIds.length > 0 ? { forcedSkillIds: item.forcedSkillIds } : {}),
              ...(item.snapshot.doc.nodes.length > 0 ? { parts: item.snapshot.doc.nodes } : {})
            })
            if (steered.injected) {
              const latest = itemsFor(queue.sessionId)
              const remaining = latest.filter((candidate) => candidate.id !== item.id)
              if (remaining.length === 0) owner.queues.delete(queue.sessionId)
              else owner.queues.set(queue.sessionId, remaining)
              if (owner.dispatches.get(queue.sessionId) === displacedDispatch) {
                owner.dispatches.delete(queue.sessionId)
              }
              emit('Queued message sent.')
              return
            }
          } catch {
            // Native follow-up is fail-closed. Keep the current run and send after it finishes.
          }
          replaceItem(queue.sessionId, itemId, { phase: 'queued', error: undefined })
          if (owner.dispatches.get(queue.sessionId) === displacedDispatch) {
            owner.dispatches.delete(queue.sessionId)
          }
          const latest = owner.resolveOptions(optionsRef.current)
          const latestSession = latest.getSession(queue.sessionId)
          if (!latestSession || queueSessionIsSendable(latest, latestSession)) {
            drainQueues()
            return
          }
          replaceItem(queue.sessionId, itemId, {
            phase: 'queued',
            error: undefined,
            deferredUntilIdle: true
          })
          emit('Queued message will send after the current run finishes.')
          return
        }
        if (liveTurn) {
          replaceItem(queue.sessionId, itemId, {
            phase: 'queued',
            error: undefined,
            deferredUntilIdle: true
          })
          emit('Queued message will send after the current run finishes.')
          return
        }
        if (owner.dispatches.get(queue.sessionId) === displacedDispatch) {
          owner.dispatches.delete(queue.sessionId)
        }
        replaceItem(queue.sessionId, itemId, {
          phase: 'queued',
          error: undefined,
          deferredUntilIdle: false
        })
        drainQueues()
      } catch (error) {
        replaceItem(queue.sessionId, itemId, {
          phase: 'error',
          error: { kind: 'cancel', detail: errorMessage(error) },
          deferredUntilIdle: false
        })
      }
    },
    [currentSessionQueue, drainQueues, emit, itemsFor, owner, replaceItem]
  )

  useEffect(
    () => owner.connect(subscribeSessionChanges, drainQueues, options.composer.discardSnapshot),
    [drainQueues, options.composer.discardSnapshot, owner, subscribeSessionChanges]
  )
  useEffect(() => drainQueues(), [drainQueues, options, queueSnapshot])

  const activeItems = options.activeSession
    ? (queueSnapshot.get(options.activeSession.id) ?? [])
    : []
  return {
    lifecycle: { enqueue, blocksImmediateSend },
    actions: { move, moveTo, remove, edit, sendNow },
    items: activeItems.map(({ id, text, attachmentCount, phase, error, deferredUntilIdle }) => ({
      id,
      text,
      attachmentCount,
      phase,
      error,
      ...(deferredUntilIdle ? { deferredUntilIdle: true } : {})
    })),
    announcement
  }
}

export {
  useWorkspaceMessageQueueController,
  WorkspaceMessageQueueProvider,
  WorkspaceMessageQueueRuntimeBridge
}
export type {
  MessageQueueAdmission,
  MessageQueueItemView,
  MessageQueuePhase,
  WorkspaceMessageQueueController,
  WorkspaceMessageQueueControllerOptions
}
