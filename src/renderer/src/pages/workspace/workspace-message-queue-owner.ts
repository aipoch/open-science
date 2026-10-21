import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type { MessageAttribution } from '../../../../shared/session-message-contract'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import type { ChatSession } from '@/stores/session-store'
import type {
  MessageQueueEditIntent,
  MessageQueueError,
  MessageQueueItem,
  MessageQueuePhase
} from './composer-contract'

import type { ComposerSendSnapshot } from './composer-contract'

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
  removed: RemovedQueueItemView[]
}

type RemovedQueueItemView = {
  id: string
  sessionId: string
  text: string
  expiresAt: number
  unavailable?: boolean
}

const QUEUED_MESSAGE_UNDO_MS = 8_000
// Once appended, the normal conversation persistence owns recovery, even if sending later fails.
const isUnsentUserItem = (item: MessageQueueItem): boolean =>
  item.kind === 'user' && !item.messageAppended
const exitGuardOwners = new Set<WorkspaceMessageQueueOwner>()
const exitGuardListeners = new Set<() => void>()
const subscribeWorkspaceQueueChanges = (listener: () => void): (() => void) => {
  exitGuardListeners.add(listener)
  return () => {
    exitGuardListeners.delete(listener)
  }
}
const pendingWorkspaceQueueCount = (): number =>
  [...exitGuardOwners].reduce((count, owner) => count + owner.pendingUserCount(), 0)
const pendingWorkspaceQueueTarget = (): { projectId: string; sessionId: string } | undefined => {
  for (const owner of exitGuardOwners) {
    for (const items of owner.queues.values()) {
      const item = items.find(isUnsentUserItem)
      if (item) return { projectId: item.projectId, sessionId: item.sessionId }
    }
  }
  return undefined
}
const registerWorkspaceQueueExitGuard = (owner: WorkspaceMessageQueueOwner): (() => void) => {
  exitGuardOwners.add(owner)
  for (const listener of exitGuardListeners) listener()
  return () => {
    exitGuardOwners.delete(owner)
    for (const listener of exitGuardListeners) listener()
  }
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
  private snapshot: MessageQueueSnapshot = { queues: new Map(), announcement: '', removed: [] }
  private removed = new Map<
    string,
    {
      item: MessageQueueItem
      index: number
      expiresAt: number
      timer: ReturnType<typeof setTimeout>
      discard: () => void
      unavailable?: boolean
    }
  >()
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

  pendingUserCount = (): number =>
    [...this.queues.values()].reduce(
      (count, items) => count + items.filter(isUnsentUserItem).length,
      0
    )

  retainRemoved(item: MessageQueueItem, index: number, discard: () => void): void {
    this.removed.set(item.id, {
      item,
      index,
      discard,
      expiresAt: Date.now() + QUEUED_MESSAGE_UNDO_MS,
      timer: setTimeout(() => this.dismissRemoved(item.id), QUEUED_MESSAGE_UNDO_MS)
    })
  }

  removedItem(id: string): MessageQueueItem | undefined {
    const receipt = this.removed.get(id)
    if (receipt && receipt.expiresAt <= Date.now()) {
      this.dismissRemoved(id)
      return undefined
    }
    return receipt?.item
  }

  markRemovedUnavailable(id: string): void {
    const receipt = this.removed.get(id)
    if (!receipt) return
    receipt.unavailable = true
    this.emit()
  }

  restoreRemoved(id: string): void {
    const receipt = this.removed.get(id)
    if (!receipt || !this.removedItem(id)) return
    clearTimeout(receipt.timer)
    this.removed.delete(id)
    const items = [...this.itemsFor(receipt.item.sessionId)]
    items.splice(Math.min(receipt.index, items.length), 0, receipt.item)
    this.queues.set(receipt.item.sessionId, items)
    this.emit()
  }

  dismissRemoved = (id: string): void => {
    const receipt = this.removed.get(id)
    if (!receipt) return
    clearTimeout(receipt.timer)
    this.removed.delete(id)
    receipt.discard()
    this.emit()
  }

  replaceItem = (
    sessionId: string,
    itemId: string,
    update: Partial<
      Pick<MessageQueueItem, 'phase' | 'error' | 'deferredUntilIdle' | 'messageAppended'>
    >
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
    for (const [id, receipt] of this.removed) {
      if (receipt.item.sessionId === sessionId) this.dismissRemoved(id)
    }
    this.emit()
  }

  emit = (announcement?: string): void => {
    this.snapshot = {
      queues: new Map(this.queues),
      removed: [...this.removed.values()].map(({ item, expiresAt, unavailable }) => ({
        id: item.id,
        sessionId: item.sessionId,
        text: item.text,
        expiresAt,
        unavailable
      })),
      announcement: announcement ?? this.snapshot.announcement
    }
    for (const listener of this.listeners) listener()
    if (exitGuardOwners.has(this)) for (const listener of exitGuardListeners) listener()
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
    exitGuardOwners.delete(this)
    for (const id of this.removed.keys()) this.dismissRemoved(id)
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

export {
  WorkspaceMessageQueueOwner,
  QUEUED_MESSAGE_UNDO_MS,
  pendingWorkspaceQueueCount,
  pendingWorkspaceQueueTarget,
  registerWorkspaceQueueExitGuard,
  subscribeWorkspaceQueueChanges
}
export type {
  ApplicationMessageQueueAdmission,
  MessageQueueAdmission,
  MessageQueueDispatch,
  MessageQueueError,
  MessageQueueItem,
  MessageQueuePhase,
  MessageQueueSnapshot,
  RemovedQueueItemView,
  WorkspaceMessageQueueControllerOptions,
  WorkspaceMessageQueueRuntimeOptions
}

export type { MessageQueueEditIntent }
