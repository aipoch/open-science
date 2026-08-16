import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import type { ChatSession } from '@/stores/session-store'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import { docToArtifactRefs } from './composer/composer-doc'
import type { ComposerSendSnapshot } from './workspace-composer-controller'

type MessageQueuePhase = 'queued' | 'interrupting' | 'sending' | 'error'
type MessageQueueError = {
  kind: 'branch' | 'send' | 'edit' | 'cancel'
  detail?: string
}

type MessageQueueItem = {
  id: string
  sessionId: string
  agentFrameId: string
  messageBranchId: string
  snapshot: ComposerSendSnapshot
  text: string
  attachmentCount: number
  forcedSkillIds: string[]
  permissionProfile: PermissionProfileId
  specialistId: string | null | undefined
  projectId: string
  cwd: string | undefined
  phase: MessageQueuePhase
  error?: MessageQueueError
}

type MessageQueueItemView = Pick<
  MessageQueueItem,
  'id' | 'text' | 'attachmentCount' | 'phase' | 'error'
>

type MessageQueueAdmission = {
  session: ChatSession
  snapshot: ComposerSendSnapshot
  text: string
  forcedSkillIds: string[]
  permissionProfile: PermissionProfileId
  specialistId: string | null | undefined
}

type MessageQueueDispatch = {
  itemId: string
  settled: boolean
  completion: Promise<void>
}

type WorkspaceMessageQueueControllerOptions = {
  activeSession: ChatSession | undefined
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  saveAsSkillInFlightSessionIds: string[]
  sideChatOpen: boolean
  composer: {
    setError: (error: string | null) => void
    restoreQueuedDraft: (snapshot: ComposerSendSnapshot) => boolean
    discardSnapshot: (snapshot: ComposerSendSnapshot) => void
  }
  runtime: Pick<WorkspaceAgentRuntime, 'sendMessage' | 'cancelRun'>
  isBarrierInFlight: (sessionId: string) => boolean
  isSpecialistReady: (sessionId: string) => boolean
  hasPendingPermissionRequest: (sessionId: string) => boolean
  abortFixLoop: (request: { projectId: string; appSessionId: string }) => Promise<unknown>
  getSession: (sessionId: string) => ChatSession | undefined
  subscribeSessionChanges: (listener: () => void) => () => void
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

const queueSessionIsSendable = (
  options: WorkspaceMessageQueueControllerOptions,
  session: ChatSession
): boolean =>
  session.archivedAt === undefined &&
  (session.status === 'idle' || session.status === 'error') &&
  !options.promptInFlightSessionIds.includes(session.id) &&
  !options.sendPreparationInFlightSessionIds.includes(session.id) &&
  !options.saveAsSkillInFlightSessionIds.includes(session.id) &&
  !options.hasPendingPermissionRequest(session.id) &&
  !session.fixLoopActive &&
  !session.conversationGraphSyncBlocked &&
  !session.compacting &&
  !options.isBarrierInFlight(session.id) &&
  !(options.activeSession?.id === session.id && options.sideChatOpen)

const useWorkspaceMessageQueueController = (
  options: WorkspaceMessageQueueControllerOptions
): WorkspaceMessageQueueController => {
  const { subscribeSessionChanges } = options
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  const queueBySessionRef = useRef(new Map<string, MessageQueueItem[]>())
  const dispatchBySessionRef = useRef(new Map<string, MessageQueueDispatch>())
  const nextQueueIdRef = useRef(0)
  const [queueSnapshot, setQueueSnapshot] = useState(new Map<string, MessageQueueItem[]>())
  const [announcement, setAnnouncement] = useState('')

  const emit = useCallback((message?: string): void => {
    if (message) setAnnouncement(message)
    setQueueSnapshot(new Map(queueBySessionRef.current))
  }, [])
  const itemsFor = useCallback(
    (sessionId: string): MessageQueueItem[] => queueBySessionRef.current.get(sessionId) ?? [],
    []
  )
  const replaceItem = useCallback(
    (
      sessionId: string,
      itemId: string,
      update: Partial<Pick<MessageQueueItem, 'phase' | 'error'>>
    ): void => {
      const items = itemsFor(sessionId)
      const index = items.findIndex((item) => item.id === itemId)
      if (index < 0) return
      const next = [...items]
      next[index] = { ...next[index], ...update }
      queueBySessionRef.current.set(sessionId, next)
      emit()
    },
    [emit, itemsFor]
  )
  const discardSession = useCallback(
    (sessionId: string): void => {
      const current = optionsRef.current
      for (const item of itemsFor(sessionId)) current.composer.discardSnapshot(item.snapshot)
      queueBySessionRef.current.delete(sessionId)
      emit()
    },
    [emit, itemsFor]
  )
  const dispatch = useCallback(
    (sessionId: string): void => {
      const current = optionsRef.current
      const existingDispatch = dispatchBySessionRef.current.get(sessionId)
      const session = current.getSession(sessionId)
      if (!session) {
        if (existingDispatch && !existingDispatch.settled) return
        dispatchBySessionRef.current.delete(sessionId)
        discardSession(sessionId)
        return
      }
      if (existingDispatch) {
        if (!existingDispatch.settled) return
        if (session.status === 'error') {
          dispatchBySessionRef.current.delete(sessionId)
        } else {
          if (!queueSessionIsSendable(current, session)) {
            dispatchBySessionRef.current.delete(sessionId)
          }
          return
        }
      }
      const item = itemsFor(sessionId)[0]
      if (!item || item.phase === 'sending' || item.phase === 'error') return
      if (!queueBranchMatches(session, item)) {
        replaceItem(sessionId, item.id, {
          phase: 'error',
          error: { kind: 'branch' }
        })
        return
      }
      if ((session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE) !== item.permissionProfile) {
        replaceItem(sessionId, item.id, { phase: 'error', error: { kind: 'send' } })
        return
      }
      if (session.specialistId !== item.specialistId) {
        replaceItem(sessionId, item.id, {
          phase: 'error',
          error: { kind: 'send' }
        })
        return
      }
      if (!current.isSpecialistReady(sessionId)) return
      if (!queueSessionIsSendable(current, session)) return

      replaceItem(sessionId, item.id, { phase: 'sending', error: undefined })
      let resolveCompletion!: () => void
      const activeDispatch: MessageQueueDispatch = {
        itemId: item.id,
        settled: false,
        completion: new Promise((resolve) => {
          resolveCompletion = resolve
        })
      }
      dispatchBySessionRef.current.set(sessionId, activeDispatch)
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
            forcedSkillIds: item.forcedSkillIds,
            specialistId: item.specialistId
          })
          if (!result) {
            throw new Error('The queued message was not admitted.')
          }
          const latest = itemsFor(sessionId)
          const remaining = latest.filter((candidate) => candidate.id !== item.id)
          if (remaining.length === 0) queueBySessionRef.current.delete(sessionId)
          else queueBySessionRef.current.set(sessionId, remaining)
          emit('Queued message sent.')
        } catch (error) {
          if (dispatchBySessionRef.current.get(sessionId) === activeDispatch) {
            dispatchBySessionRef.current.delete(sessionId)
          }
          replaceItem(sessionId, item.id, {
            phase: 'error',
            error: { kind: 'send', detail: errorMessage(error) }
          })
        } finally {
          activeDispatch.settled = true
          resolveCompletion()
          if (!optionsRef.current.getSession(sessionId)) {
            if (dispatchBySessionRef.current.get(sessionId) === activeDispatch) {
              dispatchBySessionRef.current.delete(sessionId)
            }
            discardSession(sessionId)
          }
        }
      })()
    },
    [discardSession, emit, itemsFor, replaceItem]
  )
  const drainQueues = useCallback((): void => {
    for (const sessionId of queueBySessionRef.current.keys()) dispatch(sessionId)
  }, [dispatch])
  const currentSessionQueue = useCallback(():
    { sessionId: string; items: MessageQueueItem[] } | undefined => {
    const sessionId = optionsRef.current.activeSession?.id
    return sessionId ? { sessionId, items: itemsFor(sessionId) } : undefined
  }, [itemsFor])
  const blocksImmediateSend = useCallback(
    (sessionId: string): boolean => {
      const activeDispatch = dispatchBySessionRef.current.get(sessionId)
      return (
        itemsFor(sessionId).length > 0 ||
        Boolean(
          activeDispatch &&
          !(activeDispatch.settled && optionsRef.current.getSession(sessionId)?.status === 'error')
        )
      )
    },
    [itemsFor]
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
        id: `queued-message-${Date.now()}-${++nextQueueIdRef.current}`,
        sessionId: session.id,
        ...identity,
        snapshot,
        attachmentCount: snapshot.attachments.length,
        projectId: session.projectId,
        cwd: session.cwd,
        phase: 'queued',
        ...intent
      }
      queueBySessionRef.current.set(session.id, [...itemsFor(session.id), item])
      emit('Message added to queue.')
      return true
    },
    [emit, itemsFor]
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
      queueBySessionRef.current.set(queue.sessionId, items)
      emit(`Queued message moved ${direction}.`)
    },
    [currentSessionQueue, emit]
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
      queueBySessionRef.current.set(queue.sessionId, items)
      emit('Queued messages reordered.')
    },
    [currentSessionQueue, emit]
  )
  const remove = useCallback(
    (itemId: string): void => {
      const queue = currentSessionQueue()
      if (!queue) return
      const item = queue.items.find((candidate) => candidate.id === itemId)
      if (!item || item.phase === 'sending' || item.phase === 'interrupting') return
      optionsRef.current.composer.discardSnapshot(item.snapshot)
      const remaining = queue.items.filter((candidate) => candidate.id !== itemId)
      if (remaining.length === 0) queueBySessionRef.current.delete(queue.sessionId)
      else queueBySessionRef.current.set(queue.sessionId, remaining)
      emit('Queued message removed.')
    },
    [currentSessionQueue, emit]
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
          error: { kind: 'edit' }
        })
        return
      }
      const remaining = queue.items.filter((candidate) => candidate.id !== itemId)
      if (remaining.length === 0) queueBySessionRef.current.delete(queue.sessionId)
      else queueBySessionRef.current.set(queue.sessionId, remaining)
      emit('Queued message moved to the composer for editing.')
    },
    [currentSessionQueue, emit, replaceItem]
  )
  const sendNow = useCallback(
    async (itemId: string): Promise<void> => {
      const queue = currentSessionQueue()
      if (!queue) return
      const item = queue.items.find((candidate) => candidate.id === itemId)
      if (!item) return
      queueBySessionRef.current.set(queue.sessionId, [
        { ...item, phase: 'interrupting', error: undefined },
        ...queue.items.filter((candidate) => candidate.id !== itemId)
      ])
      emit('Stopping the current run before sending the queued message.')
      try {
        const displacedDispatch = dispatchBySessionRef.current.get(queue.sessionId)
        if (displacedDispatch && displacedDispatch.itemId !== itemId) {
          await displacedDispatch.completion
        }
        const current = optionsRef.current
        const session = current.getSession(queue.sessionId)
        if (session?.fixLoopActive) {
          await current.abortFixLoop({
            projectId: session.projectId,
            appSessionId: queue.sessionId
          })
        }
        if (
          session?.status === 'running' ||
          session?.status === 'waiting-for-user' ||
          session?.status === 'waiting-permission'
        ) {
          await current.runtime.cancelRun(queue.sessionId)
        }
        if (dispatchBySessionRef.current.get(queue.sessionId) === displacedDispatch) {
          dispatchBySessionRef.current.delete(queue.sessionId)
        }
        drainQueues()
      } catch (error) {
        replaceItem(queue.sessionId, itemId, {
          phase: 'error',
          error: { kind: 'cancel', detail: errorMessage(error) }
        })
      }
    },
    [currentSessionQueue, drainQueues, emit, replaceItem]
  )

  useEffect(() => subscribeSessionChanges(drainQueues), [drainQueues, subscribeSessionChanges])
  useEffect(() => drainQueues(), [drainQueues, options, queueSnapshot])
  useEffect(
    () => () => {
      for (const items of queueBySessionRef.current.values()) {
        for (const item of items) {
          if (item.phase !== 'sending') optionsRef.current.composer.discardSnapshot(item.snapshot)
        }
      }
      queueBySessionRef.current.clear()
    },
    []
  )

  const activeItems = options.activeSession
    ? (queueSnapshot.get(options.activeSession.id) ?? [])
    : []
  return {
    lifecycle: { enqueue, blocksImmediateSend },
    actions: { move, moveTo, remove, edit, sendNow },
    items: activeItems.map(({ id, text, attachmentCount, phase, error }) => ({
      id,
      text,
      attachmentCount,
      phase,
      error
    })),
    announcement
  }
}

export { useWorkspaceMessageQueueController }
export type {
  MessageQueueAdmission,
  MessageQueueItemView,
  MessageQueuePhase,
  WorkspaceMessageQueueController,
  WorkspaceMessageQueueControllerOptions
}
