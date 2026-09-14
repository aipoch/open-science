import {
  pendingInputMatchesContent,
  type PendingInputCommand,
  type PendingInputResult,
  type PendingInputSnapshot,
  type PendingInputContent
} from '../../../../shared/pending-input'
import { toRuntimeUploadedAttachment } from '../../../../shared/uploads'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import type { SessionAgentConfiguration } from '../../../../shared/settings'
import type { MessageAttribution } from '../../../../shared/session-persistence'
import type { ChatSession } from '@/stores/session-store'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

import type { ComposerSendSnapshot } from './workspace-composer-controller'

type MessageQueuePhase = 'queued' | 'interrupting' | 'sending' | 'error' | 'recovery-required'
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
  durableRevision?: number
}

type MessageQueueEditIntent = Pick<
  MessageQueueItem,
  | 'kind'
  | 'sessionId'
  | 'agentFrameId'
  | 'messageBranchId'
  | 'permissionProfile'
  | 'agentConfiguration'
  | 'specialistId'
  | 'agentFrameworkId'
  | 'agentBackendId'
  | 'projectId'
  | 'cwd'
  | 'revisionMessageId'
> & { durableItemId?: string; durableRevision?: number }

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

  private remoteSnapshot: PendingInputSnapshot | undefined
  private remoteSubscription: (() => void) | undefined
  private remoteReady: Promise<void> | undefined
  private retiredGenerations = new Set<string>()
  private disposed = false
  private lifecycle = 0
  private readonly activeClaims = new Map<string, number>()
  private readonly admissionIds = new Map<string, string>()

  constructor(
    readonly remote?: {
      execute(command: PendingInputCommand): Promise<PendingInputResult>
      onChanged(listener: (snapshot: PendingInputSnapshot) => void): () => void
    }
  ) {}

  get ready(): boolean {
    return !this.disposed && (!this.remote || this.remoteSnapshot !== undefined)
  }

  captureLifetime(): () => boolean {
    const lifecycle = this.lifecycle
    return () => !this.disposed && lifecycle === this.lifecycle
  }

  connectRemote(): Promise<void> {
    if (!this.remote) return Promise.resolve()
    if (this.remoteReady) return this.remoteReady
    this.disposed = false
    this.remoteSubscription = this.remote.onChanged(this.applyRemote)
    this.remoteReady = this.remote
      .execute({ operation: 'list' })
      .then(this.applyRemote)
      .catch((error) => {
        this.remoteReady = undefined
        this.remoteSubscription?.()
        this.remoteSubscription = undefined
        throw error
      })
    return this.remoteReady
  }

  private applyRemote = (snapshot: PendingInputSnapshot): void => {
    if (this.disposed || this.retiredGenerations.has(snapshot.generation)) return
    if (
      this.remoteSnapshot?.generation === snapshot.generation &&
      this.remoteSnapshot.revision > snapshot.revision
    )
      return
    if (this.remoteSnapshot && this.remoteSnapshot.generation !== snapshot.generation)
      this.retiredGenerations.add(this.remoteSnapshot.generation)
    this.remoteSnapshot = snapshot
    const sessionIds = new Set([
      ...this.queues.keys(),
      ...snapshot.items.map((item) => item.sessionId)
    ])
    for (const sessionId of sessionIds) {
      const users: MessageQueueItem[] = snapshot.items
        .filter((item) => item.sessionId === sessionId)
        .map((item) => ({
          ...item,
          kind: 'user',
          snapshot: {
            ...item.snapshot,
            attachments: item.snapshot.attachments.map((file) =>
              toRuntimeUploadedAttachment(file, item.projectId)
            )
          },
          durableRevision: item.revision,
          attachmentCount: item.snapshot.attachments.length,
          cwd: item.cwd,
          specialistId: item.specialistId
        }))
      const liveIds = new Set(users.map((item) => item.id))
      const existing = this.itemsFor(sessionId).filter(
        (item) => item.kind === 'application' || liveIds.has(item.id)
      )
      const merged = existing
        .map((item) => (item.kind === 'application' ? item : users.shift()!))
        .concat(users)
      if (merged.length) this.queues.set(sessionId, merged)
      else this.queues.delete(sessionId)
    }
    this.emit()
    this.requestDrain()
  }

  async executeRemote(command: PendingInputCommand): Promise<PendingInputResult> {
    if (this.disposed) throw new Error('Pending input owner is unavailable.')
    const lifecycle = this.lifecycle
    await this.connectRemote()
    if (!this.remote || this.disposed || lifecycle !== this.lifecycle)
      throw new Error('Pending input owner is unavailable.')
    try {
      const result = await this.remote.execute(command)
      if (command.operation === 'claim' && result.item) {
        if (this.disposed || lifecycle !== this.lifecycle) {
          await this.remote.execute({
            operation: 'settle',
            id: result.item.id,
            revision: result.item.revision,
            outcome: 'uncertain'
          })
          throw new Error('Pending input owner is unavailable.')
        }
        this.activeClaims.set(result.item.id, result.item.revision)
      }
      if (command.operation === 'settle' && this.activeClaims.get(command.id) === command.revision)
        this.activeClaims.delete(command.id)
      if (this.disposed || lifecycle !== this.lifecycle)
        throw new Error('Pending input owner is unavailable.')
      this.applyRemote(result)
      return result
    } catch (error) {
      // Refresh a stale revision before presenting a retry, including a lost mutation reply.
      if (!this.disposed)
        await this.remote
          .execute({ operation: 'list' })
          .then(this.applyRemote)
          .catch(() => undefined)
      if (command.operation === 'claim') {
        const claimed = this.remoteSnapshot?.items.find((item) => item.id === command.id)
        if (claimed?.phase === 'sending') {
          // Only the lease that committed the claim can release it. A competing client's
          // claim is rejected by main; a lost reply from our own claim must not strand it.
          await this.remote
            .execute({
              operation: 'settle',
              id: claimed.id,
              revision: claimed.revision,
              claimId: command.claimId,
              outcome: 'uncertain'
            })
            .then((result) => {
              this.applyRemote(result)
              if (this.activeClaims.get(claimed.id) === claimed.revision)
                this.activeClaims.delete(claimed.id)
            })
            .catch(() => undefined)
        }
      }
      if (command.operation === 'enqueue') {
        const saved = this.remoteSnapshot?.items.find((item) => item.id === command.content.id)
        if (
          saved &&
          pendingInputMatchesContent(saved, command.content) &&
          (command.expectedRevision === undefined || saved.revision > command.expectedRevision)
        ) {
          return { ...this.remoteSnapshot!, item: saved }
        }
      }
      throw error
    }
  }

  admissionId(admission: MessageQueueAdmission): string {
    const key = JSON.stringify([
      admission.session.id,
      admission.snapshot.draftKey,
      admission.snapshot.version,
      admission.revisionMessageId
    ])
    const existing = this.admissionIds.get(key)
    if (existing) return existing
    const id = this.createQueueItemId()
    this.admissionIds.set(key, id)
    return id
  }

  async persistAdmission(item: MessageQueueItem): Promise<void> {
    if (!item.snapshot) throw new Error('Queued input is missing its composer snapshot.')
    const snapshot = { ...item.snapshot }
    delete snapshot.setupSessionToken
    delete snapshot.queuedEdit
    const content: PendingInputContent = {
      schemaVersion: 1,
      id: item.id,
      projectId: item.projectId,
      sessionId: item.sessionId,
      agentFrameId: item.agentFrameId,
      messageBranchId: item.messageBranchId,
      text: item.text,
      forcedSkillIds: item.forcedSkillIds,
      permissionProfile: item.permissionProfile,
      agentConfiguration: item.agentConfiguration,
      specialistId: item.specialistId,
      agentFrameworkId: item.agentFrameworkId,
      agentBackendId: item.agentBackendId,
      cwd: item.cwd,
      revisionMessageId: item.revisionMessageId,
      snapshot: {
        ...snapshot,
        doc: {
          nodes: snapshot.doc.nodes.map((node) => {
            if (node.type !== 'pasted-text') return node
            if (!node.attachmentId) throw new Error('Pasted text has not finished uploading.')
            return {
              type: node.type,
              id: node.id,
              text: node.text,
              attachmentId: node.attachmentId
            }
          })
        },
        attachments: snapshot.attachments.map((attachment) => {
          const file = { ...attachment }
          delete file.draftReceipt
          return file
        })
      }
    }
    await this.executeRemote({
      operation: 'enqueue',
      content,
      expectedRevision: item.durableRevision
    })
  }

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
    return `queued-message-${crypto.randomUUID()}`
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
      if (item.snapshot && !item.durableRevision) discardSnapshot(item.snapshot)
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
    this.disposed = true
    this.lifecycle++
    for (const [id, revision] of this.activeClaims) {
      void this.remote
        ?.execute({ operation: 'settle', id, revision, outcome: 'uncertain' })
        .catch(() => undefined)
    }
    this.activeClaims.clear()
    this.remoteSubscription?.()
    this.remoteSubscription = undefined
    this.remoteReady = undefined
    this.sessionSubscription?.unsubscribe()
    this.sessionSubscription = undefined
    this.runtimeOptions = undefined
    this.fallbackDrain = undefined
    for (const items of this.queues.values()) {
      for (const item of items) {
        if (!item.durableRevision && item.snapshot && item.phase !== 'sending')
          this.discardSnapshot?.(item.snapshot)
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

export type { MessageQueueEditIntent }
