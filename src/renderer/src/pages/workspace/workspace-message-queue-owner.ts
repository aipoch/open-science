import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import type { ChatSession } from '@/stores/session-store'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

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
  agentConfiguration: SessionAgentConfiguration
  specialistId: string | null | undefined
  projectId: string
  cwd: string | undefined
  phase: MessageQueuePhase
  error?: MessageQueueError
  deferredUntilIdle?: boolean
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
    Partial<Pick<WorkspaceAgentRuntime, 'steerFollowUp'>>
  isBarrierInFlight: (sessionId: string) => boolean
  isPresentationRevealing: (sessionId: string) => boolean
  isSpecialistReady: (sessionId: string) => boolean
  hasPendingPermissionRequest: (sessionId: string) => boolean
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
  | 'isSideChatOpen'
  | 'hasPendingPermissionRequest'
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): MessageQueueSnapshot => this.snapshot

  requestDrain = (): void => this.sessionSubscription?.drain()

  createQueueItemId(): string {
    this.nextQueueId += 1
    return `queued-message-${Date.now()}-${this.nextQueueId}`
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
    this.sessionSubscription?.drain()
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
    for (const items of this.queues.values()) {
      for (const item of items) {
        if (item.phase !== 'sending') this.discardSnapshot?.(item.snapshot)
      }
    }
    this.queues.clear()
    this.dispatches.clear()
    this.emit()
  }
}

export { WorkspaceMessageQueueOwner }
export type {
  MessageQueueDispatch,
  MessageQueueError,
  MessageQueueItem,
  MessageQueuePhase,
  MessageQueueSnapshot,
  WorkspaceMessageQueueControllerOptions,
  WorkspaceMessageQueueRuntimeOptions
}
