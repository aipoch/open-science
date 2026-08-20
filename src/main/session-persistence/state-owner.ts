import { createHash, randomUUID } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedConversationGraph } from '../../shared/conversation-graph'
import type { ProjectFilesChangedEvent, ProjectFileSource } from '../../shared/project-files'
import {
  materializeSessionConversationGraph,
  sanitizeSessionRuntimeContext,
  sessionRevision,
  type DelegationPolicy,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSessionStatus,
  type SaveSessionOptions,
  type SessionRuntimeContext,
  type SessionRuntimeContextPatch
} from '../../shared/session-persistence'
import { FinalizedArtifactBindingConflictError } from '../artifacts/provenance-message-snapshot'
import { diagnosticErrorFields, type Logger } from '../logger'
import {
  rebaseSafeSessionFields,
  resolveRevisionedSessionSave,
  type MainSaveSessionOptions
} from './revision-conflict'
import { mergeMainOwnedRelayProjection } from './relay-projection'
import { saveSessionWithRevision } from './save-session'

type SessionMetadata = Readonly<Pick<PersistedChatSession, 'id' | 'projectId' | 'title'>>

type SessionMetadataSnapshot = Readonly<{
  sessions: readonly SessionMetadata[]
  isComplete: boolean
}>

type PatchSessionRuntimeContextCommand = Readonly<{
  projectId: string
  sessionId: string
  expectedRevision: number
  patch: SessionRuntimeContextPatch
  sessionStatus?: PersistedSessionStatus
  beforePersist?: () => void
}>

type AppendUserMessageToInteractionCommand = Readonly<{
  projectId: string
  sessionId: string
  interactionId: string
  content: string
  beforePersist?: (session: PersistedChatSession) => void
  runtimeContextPatch?: Readonly<{
    expectedRevision: number
    patch:
      SessionRuntimeContextPatch | ((message: PersistedChatMessage) => SessionRuntimeContextPatch)
    sessionStatus?: PersistedSessionStatus
  }>
}>

type SessionStateRepository = {
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession | void>
}

type SessionStateFileIndex = {
  syncSession(session: PersistedChatSession): Promise<ProjectFileSource[]>
}

type SessionStateProvenance = {
  validateFinalizedMessageBindings(session: PersistedChatSession): Promise<void>
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
}

type SessionStateUploads = {
  upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: { mode: 'live-save' }
  ): Promise<PersistedChatSession>
}

type SessionPersistenceStateOwnerOptions = {
  repository: SessionStateRepository
  fileIndex: SessionStateFileIndex
  assertMutable(projectId: string, sessionId: string, operation: 'save' | 'mutate'): void
  notifyFilesChanged(event: ProjectFilesChangedEvent): void
  notifyRuntimeContextSessionUpdated(session: PersistedChatSession): void
  provenance?: SessionStateProvenance
  uploads?: SessionStateUploads
  log: Logger
}

class SessionRuntimeContextRevisionConflictError extends Error {
  readonly code = 'revision-conflict' as const

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Session runtime context revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`
    )
    this.name = 'SessionRuntimeContextRevisionConflictError'
  }
}

const emptySessionRuntimeContext = (): SessionRuntimeContext => ({ version: 1, revision: 0 })

const cloneRuntimeContext = (context: SessionRuntimeContext): SessionRuntimeContext =>
  structuredClone(context)

const sessionBindingTopologyHash = (session: PersistedChatSession): string => {
  const graph = session.conversationGraph
  const topology = graph
    ? {
        rootFrameId: graph.rootFrameId,
        branches: graph.branches.map(({ id, agentFrameId, headMessageId }) => ({
          id,
          agentFrameId,
          headMessageId
        })),
        messages: graph.messages.map(({ id, agentFrameId, parentMessageId }) => ({
          id,
          agentFrameId,
          parentMessageId
        }))
      }
    : null
  return createHash('sha256').update(JSON.stringify(topology)).digest('hex')
}

const delegatedSubtreeFrameIds = (graph: PersistedConversationGraph): Set<string> => {
  const result = new Set(
    graph.frames.filter((frame) => frame.kind === 'delegate').map(({ id }) => id)
  )
  let changed = true
  while (changed) {
    changed = false
    for (const frame of graph.frames) {
      if (frame.parentFrameId && result.has(frame.parentFrameId) && !result.has(frame.id)) {
        result.add(frame.id)
        changed = true
      }
    }
  }
  return result
}

const mergeMainOwnedDelegateSubtree = (
  rendererGraph: PersistedConversationGraph,
  authoritativeGraph: PersistedConversationGraph
): PersistedConversationGraph => {
  const rendererOwnedIds = delegatedSubtreeFrameIds(rendererGraph)
  const authoritativeIds = delegatedSubtreeFrameIds(authoritativeGraph)
  const mergeScoped = <Value extends { agentFrameId: string }>(
    rendererValues: readonly Value[],
    authoritativeValues: readonly Value[]
  ): Value[] => [
    ...rendererValues.filter((value) => !rendererOwnedIds.has(value.agentFrameId)),
    ...authoritativeValues.filter((value) => authoritativeIds.has(value.agentFrameId))
  ]
  return {
    ...rendererGraph,
    activeFrameId:
      rendererOwnedIds.has(rendererGraph.activeFrameId) &&
      !authoritativeGraph.frames.some((frame) => frame.id === rendererGraph.activeFrameId)
        ? rendererGraph.rootFrameId
        : rendererGraph.activeFrameId,
    frames: [
      ...rendererGraph.frames.filter((frame) => !rendererOwnedIds.has(frame.id)),
      ...authoritativeGraph.frames.filter((frame) => authoritativeIds.has(frame.id))
    ],
    branches: mergeScoped(rendererGraph.branches, authoritativeGraph.branches),
    messages: mergeScoped(rendererGraph.messages, authoritativeGraph.messages),
    activities: mergeScoped(rendererGraph.activities, authoritativeGraph.activities),
    activityGroups: mergeScoped(rendererGraph.activityGroups, authoritativeGraph.activityGroups),
    runtimeSegments: mergeScoped(rendererGraph.runtimeSegments, authoritativeGraph.runtimeSegments)
  }
}

type FinalizedArtifactBindingValidation =
  | { status: 'valid' }
  | { status: 'unavailable' }
  | { status: 'conflict'; error: FinalizedArtifactBindingConflictError }

const validateFinalizedArtifactBindings = async (
  provenance: SessionStateProvenance | undefined,
  session: PersistedChatSession,
  log: Logger
): Promise<FinalizedArtifactBindingValidation> => {
  if (!provenance) return { status: 'valid' }

  try {
    await provenance.validateFinalizedMessageBindings(session)
    return { status: 'valid' }
  } catch (error) {
    if (error instanceof FinalizedArtifactBindingConflictError) {
      return { status: 'conflict', error }
    }
    try {
      log.warn('pre-save provenance validation unavailable', {
        operation: 'session-save',
        phase: 'validate-provenance',
        outcome: 'degraded',
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostics must never change Session durability or recovery behavior.
    }
    return { status: 'unavailable' }
  }
}

// Owns scheduled Session reads/writes and their in-memory projections. The coordinator calls this
// module only from inside the operation scheduler's matching Project/Session lane.
class SessionPersistenceStateOwner {
  private readonly validatedBindingTopologies = new Map<string, string>()
  private sessionMetadata = new Map<string, SessionMetadata>()
  private isSessionMetadataComplete = false
  constructor(private readonly options: SessionPersistenceStateOwnerOptions) {}
  beginHydration(): void {
    this.validatedBindingTopologies.clear()
  }
  replaceMetadata(sessions: readonly PersistedChatSession[], isComplete: boolean): void {
    this.sessionMetadata = new Map(
      sessions.map((session) => [
        session.id,
        { id: session.id, projectId: session.projectId, title: session.title }
      ])
    )
    this.isSessionMetadataComplete = isComplete
  }
  recordSession(session: PersistedChatSession): void {
    this.sessionMetadata.set(session.id, {
      id: session.id,
      projectId: session.projectId,
      title: session.title
    })
  }
  markMetadataIncomplete(): void {
    this.isSessionMetadataComplete = false
  }
  removeSession(projectId: string, sessionId: string): void {
    this.sessionMetadata.delete(sessionId)
    this.invalidateBindingTopology(projectId, sessionId)
  }
  removeProject(projectId: string, sessionIds: readonly string[]): void {
    for (const [sessionId, metadata] of this.sessionMetadata) {
      if (metadata.projectId === projectId) this.sessionMetadata.delete(sessionId)
    }
    for (const sessionId of sessionIds) this.invalidateBindingTopology(projectId, sessionId)
  }
  metadataSnapshot(): SessionMetadataSnapshot {
    return {
      sessions: [...this.sessionMetadata.values()],
      isComplete: this.isSessionMetadataComplete
    }
  }
  sessionProjectId(sessionId: string): string | undefined {
    return this.sessionMetadata.get(sessionId)?.projectId
  }
  invalidateBindingTopology(projectId: string, sessionId: string): void {
    this.validatedBindingTopologies.delete(`${projectId}:${sessionId}`)
  }
  async containsMessageOnActiveBranch(
    projectId: string,
    sessionId: string,
    messageId: string
  ): Promise<boolean> {
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot read active Message Branch for a ${loaded.status} Session.`)
    }
    const graph = materializeSessionConversationGraph(loaded.session).conversationGraph
    return graph
      ? resolveActiveConversationMessages(graph).some((message) => message.id === messageId)
      : false
  }

  private async loadRuntimeContextSession(
    projectId: string,
    sessionId: string,
    operation: 'read' | 'patch'
  ): Promise<PersistedChatSession> {
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status === 'unreadable') {
      throw new Error(
        `Cannot ${operation} Session runtime context because its durable JSON is unreadable.`
      )
    }
    if (loaded.status === 'missing') {
      throw new Error(`Cannot ${operation} runtime context for a missing Session.`)
    }
    return loaded.session
  }

  async readRuntimeContext(projectId: string, sessionId: string): Promise<SessionRuntimeContext> {
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
    return cloneRuntimeContext(session.runtimeContext ?? emptySessionRuntimeContext())
  }

  async patchRuntimeContext(
    command: PatchSessionRuntimeContextCommand
  ): Promise<SessionRuntimeContext> {
    const { projectId, sessionId, expectedRevision, patch, sessionStatus } = command
    this.options.assertMutable(projectId, sessionId, 'mutate')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Session runtime context expected revision must be a non-negative integer.')
    }
    if (
      Object.keys(patch).some(
        (owner) => owner !== 'plan' && owner !== 'permission' && owner !== 'delegatedWork'
      )
    ) {
      throw new Error('Session runtime context patch contains an unknown authority owner.')
    }

    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
    const current = session.runtimeContext ?? emptySessionRuntimeContext()
    if (current.revision !== expectedRevision) {
      throw new SessionRuntimeContextRevisionConflictError(expectedRevision, current.revision)
    }
    command.beforePersist?.()

    const candidate: Record<string, unknown> = { ...current }
    for (const [owner, value] of Object.entries(patch)) {
      if (value === undefined) delete candidate[owner]
      else candidate[owner] = value
    }
    candidate.revision = current.revision + 1
    const runtimeContext = sanitizeSessionRuntimeContext(candidate)
    if (!runtimeContext) throw new Error('Session runtime context patch is not JSON-safe.')

    const persisted = await saveSessionWithRevision(this.options.repository, {
      ...session,
      ...(sessionStatus ? { status: sessionStatus } : {}),
      runtimeContext,
      updatedAt: Math.max(session.updatedAt + 1, Date.now())
    })
    this.recordSession(persisted)
    this.options.notifyRuntimeContextSessionUpdated(persisted)
    return cloneRuntimeContext(runtimeContext)
  }

  async appendUserMessage(
    command: AppendUserMessageToInteractionCommand
  ): Promise<PersistedChatMessage> {
    const { projectId, sessionId, interactionId } = command
    const content = command.content.trim()
    if (!content) throw new Error('User Message content must be non-empty.')
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
    const current = session.runtimeContext ?? emptySessionRuntimeContext()
    const runtimeContextPatch = command.runtimeContextPatch
    if (
      runtimeContextPatch &&
      (!Number.isSafeInteger(runtimeContextPatch.expectedRevision) ||
        runtimeContextPatch.expectedRevision < 0)
    ) {
      throw new Error('Session runtime context expected revision must be a non-negative integer.')
    }
    if (runtimeContextPatch && current.revision !== runtimeContextPatch.expectedRevision) {
      throw new SessionRuntimeContextRevisionConflictError(
        runtimeContextPatch.expectedRevision,
        current.revision
      )
    }
    command.beforePersist?.(session)
    const timestamp = Math.max(session.updatedAt + 1, Date.now())
    const message: PersistedChatMessage = {
      id: `message-${randomUUID()}`,
      role: 'user',
      content,
      status: 'complete',
      eventIds: [],
      responseToMessageId: interactionId,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const patch =
      typeof runtimeContextPatch?.patch === 'function'
        ? runtimeContextPatch.patch(message)
        : runtimeContextPatch?.patch
    if (patch && Object.keys(patch).some((owner) => owner !== 'plan' && owner !== 'permission')) {
      throw new Error('Session runtime context patch contains an unknown authority owner.')
    }
    const runtimeContext = (() => {
      if (!patch) return session.runtimeContext
      const candidate: Record<string, unknown> = { ...current }
      for (const [owner, value] of Object.entries(patch)) {
        if (value === undefined) delete candidate[owner]
        else candidate[owner] = value
      }
      candidate.revision = current.revision + 1
      const sanitized = sanitizeSessionRuntimeContext(candidate)
      if (!sanitized) throw new Error('Session runtime context patch is not JSON-safe.')
      return sanitized
    })()
    const durable = materializeSessionConversationGraph({
      ...session,
      ...(runtimeContextPatch?.sessionStatus ? { status: runtimeContextPatch.sessionStatus } : {}),
      messages: [...session.messages, message],
      ...(runtimeContext ? { runtimeContext } : {}),
      updatedAt: timestamp
    })
    const persisted = await saveSessionWithRevision(this.options.repository, durable)
    this.recordSession(persisted)
    if (runtimeContextPatch) this.options.notifyRuntimeContextSessionUpdated(persisted)
    return message
  }

  async setDelegationPolicy(
    projectId: string,
    sessionId: string,
    policy: DelegationPolicy
  ): Promise<PersistedChatSession> {
    if (policy !== 'allow' && policy !== 'deny') {
      throw new Error('Delegation policy must be allow or deny.')
    }
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot update delegation policy for a ${loaded.status} Session.`)
    }
    const durableSession: PersistedChatSession = {
      ...loaded.session,
      delegationPolicy: policy,
      updatedAt: Math.max(loaded.session.updatedAt + 1, Date.now())
    }
    const persisted = await saveSessionWithRevision(this.options.repository, durableSession)
    this.recordSession(persisted)
    return persisted
  }

  async setEnabledComputeHosts(
    projectId: string,
    sessionId: string,
    providerIds: readonly string[]
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const loaded = await this.options.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot update enabled Compute Hosts for a ${loaded.status} Session.`)
    }
    const durableSession: PersistedChatSession = {
      ...loaded.session,
      enabledComputeHosts: [...providerIds],
      updatedAt: Math.max(loaded.session.updatedAt + 1, Date.now())
    }
    const persisted = await saveSessionWithRevision(this.options.repository, durableSession)
    this.recordSession(persisted)
    return persisted
  }

  async pruneEnabledComputeHosts(
    sessions: readonly PersistedChatSession[],
    validProviderIds: ReadonlySet<string>
  ): Promise<PersistedChatSession[]> {
    const durableSessions: PersistedChatSession[] = []
    const attemptedSessions: Array<{
      session: PersistedChatSession
      rollbackRevision: number
    }> = []
    try {
      for (const session of sessions) {
        const current = session.enabledComputeHosts ?? []
        const enabledComputeHosts = current.filter((providerId) => validProviderIds.has(providerId))
        if (enabledComputeHosts.length === current.length) {
          durableSessions.push(session)
          continue
        }
        this.options.assertMutable(session.projectId, session.id, 'mutate')
        const durableSession: PersistedChatSession = {
          ...session,
          enabledComputeHosts,
          updatedAt: Math.max(session.updatedAt + 1, Date.now())
        }
        const rollback = { session, rollbackRevision: sessionRevision(session) }
        attemptedSessions.push(rollback)
        const persisted = await saveSessionWithRevision(this.options.repository, durableSession)
        rollback.rollbackRevision = sessionRevision(persisted)
        this.recordSession(persisted)
        durableSessions.push(persisted)
      }
      return durableSessions
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const { session, rollbackRevision } of attemptedSessions) {
        try {
          const persisted = await saveSessionWithRevision(
            this.options.repository,
            session,
            rollbackRevision
          )
          this.recordSession(persisted)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Compute Host pruning failed and affected Sessions could not all be restored.'
        )
      }
      throw error
    }
  }

  async saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {}
  ): Promise<PersistedChatSession> {
    return this.saveSessionWithAuthority(session, options)
  }

  async saveSessionSpecialistBinding(
    session: PersistedChatSession,
    specialistId: string | undefined,
    specialistBindingPending = false
  ): Promise<PersistedChatSession> {
    return this.saveSessionWithAuthority(
      {
        ...session,
        specialistId,
        specialistBindingPending: specialistBindingPending ? true : undefined
      },
      { conflictRebaseFields: ['specialistId', 'specialistBindingPending'] }
    )
  }

  private async saveSessionWithAuthority(
    session: PersistedChatSession,
    options: MainSaveSessionOptions = {}
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(session.projectId, session.id, 'save')
    const authoritative = await this.options.repository.loadSessionWithDiagnostics(
      session.projectId,
      session.id
    )
    if (authoritative.status === 'unreadable') {
      throw new Error(
        'Cannot save Session projection because main-owned runtime context is unreadable.'
      )
    }
    const authority = authoritative.status === 'found' ? authoritative.session : undefined
    const { session: submittedSession, expectedRevision } = resolveRevisionedSessionSave(
      authority,
      session,
      options.conflictRebaseFields
    )

    const rendererOwnedSession: PersistedChatSession = { ...submittedSession }
    delete rendererOwnedSession.runtimeContext
    delete rendererOwnedSession.archivedAt
    const specialistBindingOwnedByCaller =
      options.conflictRebaseFields?.includes('specialistId') === true &&
      options.conflictRebaseFields.includes('specialistBindingPending')
    const specialistBindingChanged =
      authority !== undefined &&
      specialistBindingOwnedByCaller &&
      (rendererOwnedSession.specialistId !== authority.specialistId ||
        rendererOwnedSession.specialistBindingPending !== authority.specialistBindingPending)
    // The renderer mirrors these fields for interaction state, but only Main's dedicated binding
    // transaction may change an existing durable Session. Preserve both desired and pending across
    // unrelated whole-session renderer saves so they cannot be split by a stale projection.
    if (authority && !specialistBindingOwnedByCaller) {
      delete rendererOwnedSession.specialistId
      delete rendererOwnedSession.specialistBindingPending
    }
    const delegationPolicyChanged =
      authority !== undefined &&
      (rendererOwnedSession.delegationPolicy === 'deny' ? 'deny' : 'allow') !==
        (authority.delegationPolicy === 'deny' ? 'deny' : 'allow')
    if (authority) delete rendererOwnedSession.delegationPolicy
    const permissionOwnedStatus =
      authority?.runtimeContext?.permission?.state === 'pending'
        ? 'waiting-permission'
        : rendererOwnedSession.status === 'waiting-permission'
          ? (authority?.status ?? 'idle')
          : undefined
    const mainOwnedStatus = permissionOwnedStatus
      ? permissionOwnedStatus
      : authority?.status === 'waiting-plan-approval' ||
          rendererOwnedSession.status === 'waiting-plan-approval'
        ? (authority?.status ?? 'idle')
        : undefined
    const relayProjection = mergeMainOwnedRelayProjection(rendererOwnedSession, authority)
    const mergedSession: PersistedChatSession = {
      ...rendererOwnedSession,
      ...relayProjection,
      ...(authority?.runtimeContext ? { runtimeContext: authority.runtimeContext } : {}),
      ...(authority?.archivedAt ? { archivedAt: authority.archivedAt } : {}),
      ...(authority && !specialistBindingOwnedByCaller
        ? {
            specialistId: authority.specialistId,
            specialistBindingPending: authority.specialistBindingPending
          }
        : {}),
      ...(authority ? { branchSource: authority.branchSource } : {}),
      ...(authority
        ? { delegationPolicy: authority.delegationPolicy === 'deny' ? 'deny' : 'allow' }
        : {}),
      ...(authority
        ? {
            enabledComputeHosts: authority.enabledComputeHosts
              ? [...authority.enabledComputeHosts]
              : undefined
          }
        : {}),
      ...(mainOwnedStatus ? { status: mainOwnedStatus } : {}),
      updatedAt:
        authority?.runtimeContext ||
        mainOwnedStatus ||
        authority?.enabledComputeHosts !== undefined ||
        authority?.specialistBindingPending !== undefined ||
        specialistBindingChanged ||
        delegationPolicyChanged
          ? Math.max(rendererOwnedSession.updatedAt, (authority?.updatedAt ?? -1) + 1, Date.now())
          : rendererOwnedSession.updatedAt
    }

    let materializedSession = materializeSessionConversationGraph(mergedSession)
    if (authority) {
      const authoritativeGraph = materializeSessionConversationGraph(authority).conversationGraph
      if (materializedSession.conversationGraph && authoritativeGraph) {
        materializedSession = {
          ...materializedSession,
          conversationGraph: mergeMainOwnedDelegateSubtree(
            materializedSession.conversationGraph,
            authoritativeGraph
          )
        }
      }
    }
    let durableSession = this.options.uploads
      ? await this.options.uploads.upgradeLegacySessionUploads(materializedSession, {
          mode: 'live-save'
        })
      : materializedSession
    const key = `${submittedSession.projectId}:${submittedSession.id}`
    let bindingTopology = sessionBindingTopologyHash(durableSession)
    let bindingValidation: FinalizedArtifactBindingValidation =
      this.validatedBindingTopologies.get(key) === bindingTopology
        ? { status: 'valid' }
        : await validateFinalizedArtifactBindings(
            this.options.provenance,
            durableSession,
            this.options.log
          )
    if (bindingValidation.status === 'conflict') {
      const conflictRebaseFields = options.conflictRebaseFields ?? []
      if (conflictRebaseFields.length === 0) throw bindingValidation.error

      const latest = await this.options.repository.loadSessionWithDiagnostics(
        submittedSession.projectId,
        submittedSession.id
      )
      if (latest.status !== 'found') throw bindingValidation.error
      const rebasedSession = rebaseSafeSessionFields(
        latest.session,
        durableSession,
        conflictRebaseFields
      )
      durableSession = this.options.uploads
        ? await this.options.uploads.upgradeLegacySessionUploads(rebasedSession, {
            mode: 'live-save'
          })
        : rebasedSession
      bindingTopology = sessionBindingTopologyHash(durableSession)
      bindingValidation =
        this.validatedBindingTopologies.get(key) === bindingTopology
          ? { status: 'valid' }
          : await validateFinalizedArtifactBindings(
              this.options.provenance,
              durableSession,
              this.options.log
            )
      if (bindingValidation.status === 'conflict') throw bindingValidation.error
    }

    const persistedSession = await saveSessionWithRevision(
      this.options.repository,
      durableSession,
      expectedRevision
    )
    this.recordSession(persistedSession)
    if (bindingValidation.status === 'valid') {
      this.validatedBindingTopologies.set(key, bindingTopology)
    }
    await this.options.provenance?.captureFinalizedMessages(persistedSession)
    let changedSources: ProjectFileSource[]
    try {
      changedSources = await this.options.fileIndex.syncSession(persistedSession)
    } catch (error) {
      this.markMetadataIncomplete()
      this.options.notifyFilesChanged({
        projectId: submittedSession.projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      throw error
    }
    if (changedSources.length > 0) {
      this.options.notifyFilesChanged({
        projectId: submittedSession.projectId,
        sessionId: submittedSession.id,
        sources: changedSources,
        kind: 'upsert'
      })
    }
    return persistedSession
  }
}

export { SessionPersistenceStateOwner, SessionRuntimeContextRevisionConflictError }
export type {
  AppendUserMessageToInteractionCommand,
  PatchSessionRuntimeContextCommand,
  SessionMetadata,
  SessionMetadataSnapshot
}
