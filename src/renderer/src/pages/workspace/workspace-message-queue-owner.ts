import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import type { MessageAttribution } from '../../../../shared/session-persistence'
import type { ChatSession } from '@/stores/session-store'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import type { ComposerSendSnapshot } from './workspace-composer-controller'

type MessageQueuePhase = 'queued' | 'interrupting' | 'sending' | 'error'
type MessageQueueError = {
  kind: 'branch' | 'send' | 'edit' | 'cancel'
  detail?: string
}

type MessageQueueItem = {
  kind: 'user' | 'application'
  id: string
  sessionId: string
  agentFrameId: string
  messageBranchId: string
  snapshot?: ComposerSendSnapshot
  text: string
  attachmentCount: number
  forcedSkillIds: string[]
  permissionProfile: PermissionProfileId
  agentConfiguration?: SessionAgentConfiguration
  specialistId: string | null | undefined
  agentFrameworkId?: ChatSession['agentFrameworkId']
  agentBackendId?: string
  projectId: string
  cwd: string | undefined
  phase: MessageQueuePhase
  error?: MessageQueueError
  deferredUntilIdle?: boolean
  application?: {
    messageId: string
    attribution: Extract<MessageAttribution, { feature: 'compute' }>
    completion: Promise<{ sessionId: string; messageId: string } | undefined>
    resolve: (result: { sessionId: string; messageId: string } | undefined) => void
  }
  revisionMessageId?: string
}

type MessageQueueAdmission = {
  session: ChatSession
  snapshot: ComposerSendSnapshot
  text: string
  forcedSkillIds: string[]
  permissionProfile: PermissionProfileId
  agentConfiguration: SessionAgentConfiguration
  specialistId: string | null | undefined
  revisionMessageId?: string
}

type ApplicationMessageQueueAdmission = {
  session: ChatSession
  text: string
  messageId?: string
  attribution: Extract<MessageAttribution, { feature: 'compute' }>
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
  isSideChatOpen: (sessionId: string) => boolean
  composer: {
    setError: (error: string | null) => void
    restoreQueuedDraft: (snapshot: ComposerSendSnapshot) => boolean
    discardSnapshot: (snapshot: ComposerSendSnapshot) => void
  }
  runtime: Pick<WorkspaceAgentRuntime, 'sendMessage' | 'cancelRun'> &
    Partial<Pick<WorkspaceAgentRuntime, 'steerFollowUp' | 'resendEditedMessage'>>
  isBarrierInFlight: (sessionId: string) => boolean
  isPresentationRevealing: (sessionId: string) => boolean
  isSpecialistReady: (sessionId: string) => boolean
  isPersistenceBlocked: (sessionId: string) => boolean
  hasPendingPermissionRequest: (sessionId: string) => boolean
  isProjectActive?: (projectId: string) => boolean
  abortFixLoop: (request: { projectId: string; appSessionId: string }) => Promise<unknown>
  getSession: (sessionId: string) => ChatSession | undefined
  subscribeSessionChanges: (listener: () => void) => () => void
}

type MessageQueueSnapshot = {
  queues: Map<string, MessageQueueItem[]>
  announcement: string
}

type WorkspaceMessageQueueRuntimeOptions = Pick<
  WorkspaceMessageQueueControllerOptions,
  | 'promptInFlightSessionIds'
  | 'sendPreparationInFlightSessionIds'
  | 'saveAsSkillInFlightSessionIds'
  | 'runtime'
  | 'isBarrierInFlight'
  | 'isSpecialistReady'
  | 'isPersistenceBlocked'
  | 'isSideChatOpen'
  | 'hasPendingPermissionRequest'
  | 'isProjectActive'
  | 'abortFixLoop'
  | 'getSession'
  | 'subscribeSessionChanges'
>

class WorkspaceMessageQueueOwner {
  readonly queues = new Map<string, MessageQueueItem[]>()
  readonly dispatches = new Map<string, MessageQueueDispatch>()
  private nextQueueId = 0
  private listeners = new Set<() => void>()
  private snapshot: MessageQueueSnapshot = { queues: new Map(), announcement: '' }
  private sessionSubscription:
    | {
        source: WorkspaceMessageQueueControllerOptions['subscribeSessionChanges']
        drain: () => void
        unsubscribe: () => void
      }
    | undefined
  private discardSnapshot:
    WorkspaceMessageQueueControllerOptions['composer']['discardSnapshot'] | undefined
  private runtimeOptions: WorkspaceMessageQueueRuntimeOptions | undefined
  private fallbackDrain: (() => void) | undefined

  subscribe = (onStoreChange: () => void): (() => void) => {
    this.listeners.add(onStoreChange)
    return (): void => {
      this.listeners.delete(onStoreChange)
    }
  }

  getSnapshot = (): MessageQueueSnapshot => this.snapshot

  requestDrain = (): void => (this.sessionSubscription?.drain ?? this.fallbackDrain)?.()

  setFallbackDrain(drain: (() => void) | undefined): void {
    this.fallbackDrain = drain
    if (!this.sessionSubscription) drain?.()
  }

  createQueueItemId(): string {
    this.nextQueueId += 1
    return `queued-message-${Date.now()}-${this.nextQueueId}`
  }

  itemsFor = (sessionId: string): MessageQueueItem[] => this.queues.get(sessionId) ?? []

  replaceItem = (
    sessionId: string,
    itemId: string,
    update: Partial<Pick<MessageQueueItem, 'phase' | 'error' | 'deferredUntilIdle'>>
  ): void => {
    const items = this.itemsFor(sessionId)
    const index = items.findIndex((item) => item.id === itemId)
    if (index < 0) return
    const next = [...items]
    next[index] = { ...next[index], ...update }
    this.queues.set(sessionId, next)
    this.emit()
  }

  discardSession = (
    sessionId: string,
    discardSnapshot: WorkspaceMessageQueueControllerOptions['composer']['discardSnapshot']
  ): void => {
    for (const item of this.itemsFor(sessionId)) {
      if (item.snapshot) discardSnapshot(item.snapshot)
      item.application?.resolve(undefined)
    }
    this.queues.delete(sessionId)
    this.emit()
  }

  emit = (announcement?: string): void => {
    this.snapshot = {
      queues: new Map(this.queues),
      announcement: announcement ?? this.snapshot.announcement
    }
    for (const listener of this.listeners) listener()
  }

  connect(
    source: WorkspaceMessageQueueControllerOptions['subscribeSessionChanges'],
    drain: () => void,
    discardSnapshot: WorkspaceMessageQueueControllerOptions['composer']['discardSnapshot']
  ): void {
    this.discardSnapshot = discardSnapshot
    const liveSource = this.runtimeOptions?.subscribeSessionChanges ?? source
    if (
      this.sessionSubscription?.source === liveSource &&
      this.sessionSubscription.drain === drain
    ) {
      return
    }
    this.sessionSubscription?.unsubscribe()
    this.sessionSubscription = { source: liveSource, drain, unsubscribe: liveSource(drain) }
  }

  updateRuntime(options: WorkspaceMessageQueueRuntimeOptions): void {
    this.runtimeOptions = options
    const current = this.sessionSubscription
    if (current && current.source !== options.subscribeSessionChanges) {
      current.unsubscribe()
      this.sessionSubscription = {
        source: options.subscribeSessionChanges,
        drain: current.drain,
        unsubscribe: options.subscribeSessionChanges(current.drain)
      }
    }
    ;(this.sessionSubscription?.drain ?? this.fallbackDrain)?.()
  }

  resolveOptions(
    fallback: WorkspaceMessageQueueControllerOptions
  ): WorkspaceMessageQueueControllerOptions {
    return this.runtimeOptions ? { ...fallback, ...this.runtimeOptions } : fallback
  }

  dispose(): void {
    this.sessionSubscription?.unsubscribe()
    this.sessionSubscription = undefined
    this.runtimeOptions = undefined
    this.fallbackDrain = undefined
    for (const items of this.queues.values()) {
      for (const item of items) {
        if (item.snapshot && item.phase !== 'sending') this.discardSnapshot?.(item.snapshot)
        item.application?.resolve(undefined)
      }
    }
    this.queues.clear()
    this.dispatches.clear()
    this.emit()
  }
}

export { WorkspaceMessageQueueOwner }
export type {
  MessageQueueAdmission,
  ApplicationMessageQueueAdmission,
  MessageQueueDispatch,
  MessageQueueError,
  MessageQueueItem,
  MessageQueuePhase,
  MessageQueueSnapshot,
  WorkspaceMessageQueueControllerOptions,
  WorkspaceMessageQueueRuntimeOptions
}
