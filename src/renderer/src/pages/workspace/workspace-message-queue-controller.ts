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

import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import { useOpenSideChatParentSessionIds } from './use-side-chat-controller'
import {
  enqueueApplicationMessage,
  enqueueQueuedMessage,
  queueBlocksImmediateSend
} from './workspace-message-queue-admission'
import { drainQueuedSessions, sendQueuedItemNow } from './workspace-message-queue-drain'
import {
  WorkspaceMessageQueueOwner,
  type MessageQueueAdmission,
  type ApplicationMessageQueueAdmission,
  type MessageQueuePhase,
  type WorkspaceMessageQueueControllerOptions
} from './workspace-message-queue-owner'
import {
  editQueuedItem,
  moveQueuedItem,
  moveQueuedItemTo,
  projectActiveQueueItems,
  removeQueuedItem,
  type MessageQueueItemView
} from './workspace-message-queue-projection'
import { subscribeWorkspacePresentationRevealing } from './workspace-presentation-revealing'
import {
  isWorkspaceSpecialistBarrierInFlight,
  subscribeWorkspaceSpecialistBarriers
} from './workspace-specialist-barrier'

type WorkspaceMessageQueueController = {
  items: MessageQueueItemView[]
  hasPendingWork: boolean
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
    enqueueApplication: (
      admission: ApplicationMessageQueueAdmission
    ) => Promise<{ sessionId: string; messageId: string } | undefined>
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

const useWorkspaceApplicationMessageAdmission =
  (): WorkspaceMessageQueueController['lifecycle']['enqueueApplication'] => {
    const owner = useProvidedWorkspaceMessageQueueOwner()
    return useCallback(
      (admission: ApplicationMessageQueueAdmission) => {
        const currentSession = useSessionStore
          .getState()
          .sessions.find((session) => session.id === admission.session.id)
        return enqueueApplicationMessage(owner, {
          ...admission,
          session: currentSession ?? admission.session
        })
      },
      [owner]
    )
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

const WorkspaceMessageQueueRuntimeBridge = ({
  persistenceBlockedSessionIds
}: {
  persistenceBlockedSessionIds: readonly string[]
}): null => {
  const owner = useProvidedWorkspaceMessageQueueOwner()
  const runtime = useWorkspaceAgentRuntime()
  const specialistCatalogLoaded = useSpecialistStore((state) => state.isLoaded)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const openSideChatParentSessionIds = useOpenSideChatParentSessionIds()
  const projects = useProjectStore((state) => state.projects)
  const fallbackOptionsRef = useRef<WorkspaceMessageQueueControllerOptions>(undefined as never)
  const cancelledPersistenceBlockedSessions = useRef(new Set<string>())
  useEffect(() => {
    const blocked = new Set(persistenceBlockedSessionIds)
    for (const sessionId of cancelledPersistenceBlockedSessions.current) {
      if (!blocked.has(sessionId)) cancelledPersistenceBlockedSessions.current.delete(sessionId)
    }
    for (const sessionId of blocked) {
      if (cancelledPersistenceBlockedSessions.current.has(sessionId)) continue
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (!session?.activeRun && !session?.agentPromptInFlight && session?.status !== 'running') {
        continue
      }
      cancelledPersistenceBlockedSessions.current.add(sessionId)
      void runtime
        .cancelRun(sessionId)
        .catch(() => runtime.cancelRun(sessionId))
        .catch((error: unknown) => {
          cancelledPersistenceBlockedSessions.current.delete(sessionId)
          console.warn('Failed to stop oversized conversation:', error)
        })
    }
  }, [persistenceBlockedSessionIds, runtime])
  const runtimeOptions: WorkspaceMessageQueueControllerOptions = {
    activeSession: undefined,
    promptInFlightSessionIds: runtime.promptInFlightSessionIds,
    sendPreparationInFlightSessionIds: runtime.sendPreparationInFlightSessionIds,
    saveAsSkillInFlightSessionIds: runtime.saveAsSkillInFlightSessionIds,
    runtime,
    composer: {
      setError: () => undefined,
      restoreQueuedDraft: () => false,
      discardSnapshot: () => undefined
    },
    isBarrierInFlight: isWorkspaceSpecialistBarrierInFlight,
    isPresentationRevealing: () => false,
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
    isPersistenceBlocked: (sessionId) => persistenceBlockedSessionIds.includes(sessionId),
    hasPendingPermissionRequest: (sessionId) =>
      runtime.pendingPermissions.some((request) => request.sessionId === sessionId),
    isProjectActive: (projectId) =>
      projects.some((project) => project.id === projectId && project.archivedAt === undefined),
    abortFixLoop: (request) => window.api.reviewer.abortFixLoop(request),
    getSession: (sessionId) =>
      useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId),
    subscribeSessionChanges: useSessionStore.subscribe
  }
  useLayoutEffect(() => {
    fallbackOptionsRef.current = runtimeOptions
    owner.updateRuntime(runtimeOptions)
  })
  useLayoutEffect(() => {
    const drain = (): void => drainQueuedSessions(owner, fallbackOptionsRef)
    owner.setFallbackDrain(drain)
    return () => owner.setFallbackDrain(undefined)
  }, [owner])
  return null
}

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

  const enqueue = useCallback(
    (admission: MessageQueueAdmission): boolean =>
      enqueueQueuedMessage(owner, optionsRef.current.composer.setError, admission),
    [owner]
  )
  const blocksImmediateSend = useCallback(
    (sessionId: string): boolean => queueBlocksImmediateSend(owner, optionsRef.current, sessionId),
    [owner]
  )
  const enqueueApplication = useCallback(
    (admission: ApplicationMessageQueueAdmission) =>
      enqueueApplicationMessage(owner, {
        ...admission,
        session: optionsRef.current.getSession(admission.session.id) ?? admission.session
      }),
    [owner]
  )
  const drainQueues = useCallback((): void => {
    drainQueuedSessions(owner, optionsRef)
  }, [owner])
  const move = useCallback(
    (itemId: string, direction: 'up' | 'down'): void => {
      moveQueuedItem(owner, optionsRef, itemId, direction)
    },
    [owner]
  )
  const moveTo = useCallback(
    (itemId: string, targetId: string, edge: 'before' | 'after'): void => {
      moveQueuedItemTo(owner, optionsRef, itemId, targetId, edge)
    },
    [owner]
  )
  const remove = useCallback(
    (itemId: string): void => {
      removeQueuedItem(owner, optionsRef, itemId)
    },
    [owner]
  )
  const edit = useCallback(
    (itemId: string): void => {
      editQueuedItem(owner, optionsRef, itemId)
    },
    [owner]
  )
  const sendNow = useCallback(
    (itemId: string): Promise<void> => sendQueuedItemNow(owner, optionsRef, itemId),
    [owner]
  )

  useEffect(
    () => owner.connect(subscribeSessionChanges, drainQueues, options.composer.discardSnapshot),
    [drainQueues, options.composer.discardSnapshot, owner, subscribeSessionChanges]
  )
  useEffect(() => drainQueues(), [drainQueues, options, queueSnapshot])

  return {
    lifecycle: { enqueue, enqueueApplication, blocksImmediateSend },
    actions: { move, moveTo, remove, edit, sendNow },
    items: projectActiveQueueItems(queueSnapshot, options.activeSession?.id),
    hasPendingWork: Boolean(
      options.activeSession && (queueSnapshot.get(options.activeSession.id)?.length ?? 0) > 0
    ),
    announcement
  }
}

export {
  useWorkspaceMessageQueueController,
  useWorkspaceApplicationMessageAdmission,
  WorkspaceMessageQueueProvider,
  WorkspaceMessageQueueRuntimeBridge
}
export type {
  MessageQueueAdmission,
  ApplicationMessageQueueAdmission,
  MessageQueueItemView,
  MessageQueuePhase,
  WorkspaceMessageQueueController,
  WorkspaceMessageQueueControllerOptions
}
