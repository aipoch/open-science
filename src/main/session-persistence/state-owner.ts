import { resolveResearchMembership } from './research-membership'
import {
  setResearchMembershipRequestSchema,
  type SetResearchMembershipRequest
} from '../../shared/session-replay'
import { preserveMainTurnOutcomes, recordRestartTurnOutcome } from './turn-outcome-authority'
import {
  setTurnOutcome,
  legacySessionStateForOutcome,
  type TurnOutcome
} from '../../shared/session-persistence'
import { SessionPromptPreparationOwner } from './prompt-preparation-owner'
import { rebaseTaskSessionBinding, rebaseTaskTurnOntoLatestSession } from './task-admission'
import { SessionConversationCommandDeferredError } from '../../shared/session-conversation-command'
import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { createHash, randomUUID } from 'node:crypto'

import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedConversationGraph } from '../../shared/conversation-graph'
import type { ProjectFilesChangedEvent, ProjectFileSource } from '../../shared/project-files'
import {
  materializeSessionConversationGraph,
  normalizeDelegationPolicy,
  sanitizePlanHistoryProjections,
  sanitizeSessionRuntimeContext,
  SessionConfigurationBusyError,
  sessionRevision,
  SessionRevisionConflictError,
  type DelegationPolicy,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSessionStatus,
  type SaveSessionOptions,
  type FailTaskSessionRunRequest,
  type SettleTaskSessionCompletionRequest,
  type BindTaskSessionRequest,
  type AdmitTaskSessionTurnRequest,
  type StageTaskSessionCompletionRequest,
  type SessionRuntimeContext,
  type SessionRuntimeContextPatch
} from '../../shared/session-persistence'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { FinalizedArtifactBindingConflictError } from '../artifacts/provenance-message-snapshot'
import { sessionComputeHostAccessPolicy } from '../compute/session-compute-host-access'
import { diagnosticErrorFields, type Logger } from '../logger'
import {
  rebaseSafeSessionFields,
  resolveRevisionedSessionSave,
  type MainSaveSessionOptions
} from './revision-conflict'
import { mergeMainOwnedRelayProjection } from './relay-projection'
import { loadSessionMutationAuthority as loadAuthority } from './repository'
import { saveSessionWithRevision, SessionProjectionAfterCommitError } from './save-session'
import { isDeepStrictEqual } from 'node:util'
import { preserveImportedSession } from './imported-session'
import type { AcpRuntimeEvent } from '../../shared/acp'

export type RuntimeTerminalCommitRequest = Readonly<{
  projectId: string
  sessionId: string
  promptMessageId: string
  executionId: string
}>

type SessionMetadata = Readonly<Pick<PersistedChatSession, 'id' | 'projectId' | 'title'>>

type SessionMetadataSnapshot = Readonly<{
  sessions: readonly SessionMetadata[]
  isComplete: boolean
}>

type SessionSaveAuthority = Readonly<{
  taskRunCommit: boolean
  // Ends with the IPC caller lease that issued the save; preparation receipts follow it.
  callerSignal?: AbortSignal
}>

type PatchSessionRuntimeContextCommand = Readonly<{
  projectId: string
  sessionId: string
  expectedRevision: number
  patch: SessionRuntimeContextPatch
  archivePlanProjection?: ActivePlanProjection
  sessionStatus?: PersistedSessionStatus
  beforePersist?: (session: PersistedChatSession) => void | Promise<void>
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
    sessionId: string,
    options?: { preserveRuntimeState?: boolean }
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  hasLiveRuntimeSession?(projectId: string, sessionId: string): boolean
  retainRuntimeSessionState?(projectId: string, sessionId: string, retained: boolean): void
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession>
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
  notifyRuntimeTranscriptSessionUpdated?(session: PersistedChatSession): void
  notifyDelegationPolicyUpdated?(session: PersistedChatSession): void
  // Schedules abandoned-preparation release on the Session's operation lane.
  releaseAbandonedPreparation?(scope: { projectId: string; sessionId: string }): void
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

const dedupePlanHistoryProjections = (
  projections: readonly ActivePlanProjection[]
): ActivePlanProjection[] => {
  const seen = new Set<string>()
  return projections
    .toReversed()
    .filter((projection) => {
      if (seen.has(projection.artifactVersionId)) return false
      seen.add(projection.artifactVersionId)
      return true
    })
    .toReversed()
}

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
  private readonly promptPreparations = new SessionPromptPreparationOwner()
  // Ephemeral release facts never enter mutation authority or Session JSON. The original terminal
  // remains owned by its runtime until explicit Retry commits it or a new admission supersedes it.
  private readonly runtimeTerminalFailures = new Map<
    string,
    {
      event: AcpRuntimeEvent
      retry: () => Promise<void>
      waitForWriteRelease?: () => Promise<void>
    }
  >()
  private readonly validatedBindingTopologies = new Map<string, string>()
  private sessionMetadata = new Map<string, SessionMetadata>()
  private isSessionMetadataComplete = false
  constructor(private readonly options: SessionPersistenceStateOwnerOptions) {}
  recordRuntimeTerminalFailure(
    event: AcpRuntimeEvent,
    retry: () => Promise<void>,
    waitForWriteRelease?: () => Promise<void>
  ): void {
    if (
      !event.terminalScope ||
      !event.sessionId ||
      !event.promptMessageId ||
      !event.terminalCommitFailure
    )
      throw new Error('Runtime terminal release requires exact execution authority.')
    this.runtimeTerminalFailures.set(event.sessionId, {
      event: structuredClone(event),
      retry,
      waitForWriteRelease
    })
    this.options.repository.retainRuntimeSessionState?.(
      event.terminalScope.projectId,
      event.sessionId,
      true
    )
  }

  listRuntimeTerminalFailures(): AcpRuntimeEvent[] {
    return [...this.runtimeTerminalFailures.values()].map(({ event }) => structuredClone(event))
  }
  assertRuntimeTerminalWriteAvailable(sessionId: string): Promise<void> | undefined {
    return this.runtimeTerminalFailures.get(sessionId)?.waitForWriteRelease?.()
  }

  projectRuntimeSession(session: PersistedChatSession): PersistedChatSession {
    const failure = this.runtimeTerminalFailures.get(session.id)
    const event = failure?.event
    const scope = event?.terminalScope
    if (!event || !scope || session.projectId !== scope.projectId) return session
    const run = session.activeRun
    if (
      !run ||
      run.promptMessageId !== event.promptMessageId ||
      run.startedAt !== scope.startedAt
    ) {
      return session
    }
    const admission = session.runtimeSessionAdmissions?.find(
      ({ executionId }) => executionId === scope.executionId
    )
    if (
      !admission ||
      admission.promptMessageId !== event.promptMessageId ||
      admission.agentFrameId !== scope.agentFrameId ||
      admission.messageBranchId !== scope.messageBranchId ||
      admission.runtimeSegmentId !== scope.runtimeSegmentId
    ) {
      return session
    }
    return applyRuntimeSessionEvents(
      session,
      {
        promptMessageId: event.promptMessageId!,
        agentFrameId: scope.agentFrameId,
        messageBranchId: scope.messageBranchId,
        runtimeSegmentId: scope.runtimeSegmentId
      },
      [event]
    )
  }

  async retryRuntimeTerminalCommit(request: RuntimeTerminalCommitRequest): Promise<void> {
    const failure = this.runtimeTerminalFailures.get(request.sessionId)
    if (
      !failure ||
      failure.event.promptMessageId !== request.promptMessageId ||
      failure.event.terminalScope?.projectId !== request.projectId ||
      failure.event.terminalScope.executionId !== request.executionId
    )
      return
    // Retry calls the runtime's mutation lane; never invoke it while holding that same lane.
    await failure.retry()
    if (this.runtimeTerminalFailures.get(request.sessionId) === failure)
      this.clearRuntimeTerminalFailure(request.projectId, request.sessionId)
  }
  private clearRuntimeTerminalFailure(projectId: string, sessionId: string): void {
    this.runtimeTerminalFailures.delete(sessionId)
    this.options.repository.retainRuntimeSessionState?.(projectId, sessionId, false)
  }
  beginHydration(): void {
    this.validatedBindingTopologies.clear()
  }
  replaceMetadata(sessions: readonly SessionMetadata[], isComplete: boolean): void {
    this.sessionMetadata = new Map(
      sessions.map((session) => [
        session.id,
        { id: session.id, projectId: session.projectId, title: session.title }
      ])
    )
    this.isSessionMetadataComplete = isComplete
  }
  replaceProjectMetadata(projectId: string, sessions: readonly SessionMetadata[]): void {
    const nextMetadata = new Map(this.sessionMetadata)
    for (const [sessionId, metadata] of nextMetadata) {
      if (metadata.projectId === projectId) nextMetadata.delete(sessionId)
    }
    for (const session of sessions) {
      if (session.projectId !== projectId) {
        throw new Error('Cannot replace Project metadata with a Session owned by another Project.')
      }
      const existing = nextMetadata.get(session.id)
      if (existing && existing.projectId !== projectId) {
        throw new Error('Cannot replace Project metadata with a duplicate Session identity.')
      }
      nextMetadata.set(session.id, {
        id: session.id,
        projectId: session.projectId,
        title: session.title
      })
    }
    this.sessionMetadata = nextMetadata
  }
  recordSession(session: PersistedChatSession): void {
    this.promptPreparations.observe(session)
    // Clear stale live release facts when durable state settles or a newer execution takes over.
    const event = this.runtimeTerminalFailures.get(session.id)?.event
    if (
      event &&
      (!session.activeRun ||
        session.activeRun.promptMessageId !== event.promptMessageId ||
        session.activeRun.startedAt !== event.terminalScope?.startedAt)
    )
      this.clearRuntimeTerminalFailure(session.projectId, session.id)
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
    this.promptPreparations.forget(projectId, sessionId)
    this.clearRuntimeTerminalFailure(projectId, sessionId)
    this.sessionMetadata.delete(sessionId)
    this.invalidateBindingTopology(projectId, sessionId)
  }
  removeProject(projectId: string, sessionIds: readonly string[]): void {
    this.promptPreparations.forget(projectId)
    for (const { event } of this.runtimeTerminalFailures.values()) {
      if (event.terminalScope?.projectId === projectId && event.sessionId)
        this.clearRuntimeTerminalFailure(projectId, event.sessionId)
    }
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
    const loaded = await loadAuthority(this.options.repository, projectId, sessionId)
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
    const loaded = await loadAuthority(this.options.repository, projectId, sessionId)
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
        (owner) =>
          !['plan', 'permission', 'delegatedWork', 'pdfContext', 'sessionContext'].includes(owner)
      )
    ) {
      throw new Error('Session runtime context patch contains an unknown authority owner.')
    }

    const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
    const current = session.runtimeContext ?? emptySessionRuntimeContext()
    if (current.revision !== expectedRevision) {
      throw new SessionRuntimeContextRevisionConflictError(expectedRevision, current.revision)
    }
    await command.beforePersist?.(session)

    const candidate: Record<string, unknown> = { ...current }
    for (const [owner, value] of Object.entries(patch)) {
      if (value === undefined) delete candidate[owner]
      else candidate[owner] = value
    }
    candidate.revision = current.revision + 1
    const runtimeContext = sanitizeSessionRuntimeContext(candidate)
    if (!runtimeContext) throw new Error('Session runtime context patch is not JSON-safe.')

    const archivePlanProjection = command.archivePlanProjection
      ? sanitizePlanHistoryProjections([command.archivePlanProjection])?.[0]
      : undefined
    const matchingArchivePlanProjection =
      archivePlanProjection &&
      Object.hasOwn(patch, 'plan') &&
      current.plan &&
      archivePlanProjection.artifactVersionId === current.plan.artifactVersionId &&
      runtimeContext.plan?.artifactVersionId !== archivePlanProjection.artifactVersionId
        ? archivePlanProjection
        : undefined
    const planHistoryProjections = sanitizePlanHistoryProjections(
      dedupePlanHistoryProjections(
        [
          ...(session.planHistoryProjections ?? []),
          ...(matchingArchivePlanProjection ? [matchingArchivePlanProjection] : [])
        ].filter(
          (projection) => projection.artifactVersionId !== runtimeContext.plan?.artifactVersionId
        )
      )
    )

    const durableSession: PersistedChatSession = {
      ...session,
      ...(sessionStatus ? { status: sessionStatus } : {}),
      runtimeContext,
      updatedAt: Math.max(session.updatedAt + 1, Date.now())
    }
    if (planHistoryProjections) durableSession.planHistoryProjections = planHistoryProjections
    else delete durableSession.planHistoryProjections
    const persisted = await saveSessionWithRevision(this.options.repository, durableSession)
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
    const loaded = await loadAuthority(this.options.repository, projectId, sessionId)
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
    this.options.notifyDelegationPolicyUpdated?.(persisted)
    return persisted
  }

  async updateSessionConfiguration(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(session.projectId, session.id, 'mutate')
    const loaded = await loadAuthority(this.options.repository, session.projectId, session.id)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot update configuration for a ${loaded.status} Session.`)
    }
    if (
      loaded.session.activeRun ||
      (loaded.session.status !== 'idle' && loaded.session.status !== 'error')
    ) {
      throw new SessionConfigurationBusyError(session.id)
    }
    const durableSession: PersistedChatSession = {
      ...loaded.session,
      agentConfiguration: session.agentConfiguration,
      permissionProfile: session.permissionProfile,
      autoReviewEnabled: session.autoReviewEnabled,
      memoryEnabled: session.memoryEnabled,
      delegationPolicy: session.delegationPolicy,
      enabledComputeHosts: session.enabledComputeHosts
        ? [...session.enabledComputeHosts]
        : undefined,
      selectedComputeHosts: session.selectedComputeHosts
        ? [...session.selectedComputeHosts]
        : undefined,
      updatedAt: Math.max(loaded.session.updatedAt + 1, session.updatedAt)
    }
    const persisted = await saveSessionWithRevision(
      this.options.repository,
      durableSession,
      expectedRevision
    )
    this.recordSession(persisted)
    if (persisted.delegationPolicy !== loaded.session.delegationPolicy) {
      this.options.notifyDelegationPolicyUpdated?.(persisted)
    }
    return persisted
  }

  async setEnabledComputeHosts(
    projectId: string,
    sessionId: string,
    providerIdsOrMutation: Parameters<typeof sessionComputeHostAccessPolicy.resolveUpdate>[1]
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const loaded = await loadAuthority(this.options.repository, projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot update enabled Compute Hosts for a ${loaded.status} Session.`)
    }
    const access = sessionComputeHostAccessPolicy.resolveUpdate(
      loaded.session,
      providerIdsOrMutation
    )
    const durableSession: PersistedChatSession = {
      ...loaded.session,
      ...sessionComputeHostAccessPolicy.persisted(access),
      updatedAt: Math.max(loaded.session.updatedAt + 1, Date.now())
    }
    const persisted = await saveSessionWithRevision(this.options.repository, durableSession)
    this.recordSession(persisted)
    return persisted
  }

  async setComputeConcurrencyLimit(
    projectId: string,
    sessionId: string,
    limit: number
  ): Promise<PersistedChatSession> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
      )
    }
    this.options.assertMutable(projectId, sessionId, 'mutate')
    const loaded = await loadAuthority(this.options.repository, projectId, sessionId)
    if (loaded.status !== 'found') {
      throw new Error(`Cannot update Compute concurrency for a ${loaded.status} Session.`)
    }
    const persisted = await saveSessionWithRevision(this.options.repository, {
      ...loaded.session,
      computeConcurrencyLimit: limit,
      updatedAt: Math.max(loaded.session.updatedAt + 1, Date.now())
    })
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
      // This startup reconciliation runs under the coordinator's global lock. Its catalog entries
      // are intentionally restore-normalized; the CAS save preserves that projection while changing
      // only Compute Host fields and still checks the durable revision through the repository.
      for (const session of sessions) {
        const access = sessionComputeHostAccessPolicy.prune(session, validProviderIds)
        if (!access) {
          durableSessions.push(session)
          continue
        }
        this.options.assertMutable(session.projectId, session.id, 'mutate')
        const durableSession: PersistedChatSession = {
          ...session,
          enabledComputeHosts: [...access.enabledProviderIds],
          selectedComputeHosts: [...access.selectedProviderIds],
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

  ownsPromptPreparation(session: PersistedChatSession): boolean {
    return this.promptPreparations.ownsPreparation(session)
  }

  // A renderer that reloads or crashes between prepare-prompt and sendPrompt takes its preparation
  // id with it, so nobody can roll back. Release through restart semantics: undo only fields still
  // equal to the marker's expectation, keep saved messages and concurrent state, invent no outcome.
  async releaseAbandonedPreparation(scope: {
    projectId: string
    sessionId: string
  }): Promise<boolean> {
    const loaded = await loadAuthority(this.options.repository, scope.projectId, scope.sessionId)
    if (loaded.status !== 'found' || !this.promptPreparations.isAbandoned(loaded.session))
      return false
    await this.mutateRuntimeSession(scope, (latest) =>
      this.promptPreparations.isAbandoned(latest)
        ? recordRestartTurnOutcome(latest, latest)
        : latest
    )
    return true
  }

  // Commit restore normalization before attachment makes reads preserve runtime state.
  // Parked/approved Plans also lose their stale run, without a resumeRecovery error.
  async prepareRuntimeResume(scope: { projectId: string; sessionId: string }): Promise<void> {
    const preserveRuntimeState =
      this.runtimeTerminalFailures.has(scope.sessionId) ||
      (this.options.repository.hasLiveRuntimeSession?.(scope.projectId, scope.sessionId) ?? false)
    const restored = await this.options.repository.loadSessionWithDiagnostics(
      scope.projectId,
      scope.sessionId,
      { preserveRuntimeState }
    )
    if (restored.status !== 'found') throw new Error('Session could not be loaded for Resume.')
    if (preserveRuntimeState || this.promptPreparations.ownsPreparation(restored.session)) return
    if (restored.session.promptPreparation) {
      await this.mutateRuntimeSession(scope, (latest) =>
        recordRestartTurnOutcome(restored.session, latest)
      )
      return
    }
    if (restored.session.resumeRecovery?.cause !== 'app-restart') {
      if (restored.session.activeRun) return
      const authority = await loadAuthority(
        this.options.repository,
        scope.projectId,
        scope.sessionId
      )
      if (authority.status !== 'found') return
      // Persist the decoder's validated wait even when the old run marker is already absent.
      // Attached reads preserve runtime state, so the question must be waiting on disk first.
      const restoredQuestionWait =
        restored.session.status === 'waiting-for-user' &&
        authority.session.status !== 'waiting-for-user'
      if (!authority.session.activeRun && !restoredQuestionWait) return
    }
    await this.mutateRuntimeSession(scope, (latest) => {
      if (sessionRevision(latest) !== sessionRevision(restored.session)) {
        throw new Error('Session changed before restart recovery could be committed.')
      }
      return recordRestartTurnOutcome(restored.session, latest)
    })
  }

  async saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {},
    authority: SessionSaveAuthority = { taskRunCommit: false }
  ): Promise<PersistedChatSession> {
    return this.saveSessionWithAuthority(session, options, authority)
  }

  async mutateRuntimeSession(
    scope: { projectId: string; sessionId: string },
    mutate: (session: PersistedChatSession) => PersistedChatSession
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(scope.projectId, scope.sessionId, 'mutate')
    const loaded = await loadAuthority(this.options.repository, scope.projectId, scope.sessionId)
    if (loaded.status !== 'found') {
      try {
        this.options.log.warn('Runtime Session authority unavailable', {
          operation: 'runtime-session-mutation',
          phase: 'load-authority',
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          authorityStatus: loaded.status,
          cachedProjectId: this.sessionMetadata.get(scope.sessionId)?.projectId,
          metadataComplete: this.isSessionMetadataComplete
        })
      } catch {
        // Diagnostics must not replace the original rejection or recreate missing authority.
      }
      throw new Error(`Cannot update a ${loaded.status} runtime Session.`)
    }
    const previous = loaded.session
    const mutation = mutate(structuredClone(previous))
    const transcriptUnchanged =
      isDeepStrictEqual(mutation.conversationGraph, previous.conversationGraph) &&
      isDeepStrictEqual(mutation.messages, previous.messages) &&
      isDeepStrictEqual(mutation.activities, previous.activities) &&
      isDeepStrictEqual(mutation.activityGroups, previous.activityGroups)
    const candidate = transcriptUnchanged ? mutation : materializeSessionConversationGraph(mutation)
    if (candidate.id !== previous.id || candidate.projectId !== previous.projectId) {
      throw new Error('Runtime mutation changed its Session identity.')
    }
    candidate.runtimeTranscriptOwner = 'main'
    if (
      previous.activeRun &&
      !candidate.activeRun &&
      !this.promptPreparations.hasUnadmittedRun(previous)
    )
      candidate.runtimeTranscriptLastRun = previous.activeRun
    if (isDeepStrictEqual(candidate, previous)) return previous
    const validation = await validateFinalizedArtifactBindings(
      this.options.provenance,
      candidate,
      this.options.log
    )
    if (validation.status === 'conflict') throw validation.error
    let persisted: PersistedChatSession
    try {
      persisted = await saveSessionWithRevision(
        this.options.repository,
        candidate,
        previous.revision ?? 0
      )
    } catch (error) {
      if (!(error instanceof SessionProjectionAfterCommitError)) throw error
      persisted = error.committedSession
      this.markMetadataIncomplete()
    }
    this.recordSession(persisted)
    this.invalidateBindingTopology(scope.projectId, scope.sessionId)
    // JSON is the authoritative commit. Derived capture/index/publication failure must not report
    // that this mutation never happened or invite another execution of the provider work.
    try {
      await this.options.provenance?.captureFinalizedMessages(persisted)
      const changedSources = await this.options.fileIndex.syncSession(persisted)
      if (changedSources.length)
        this.options.notifyFilesChanged({
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          sources: changedSources,
          kind: 'upsert'
        })
    } catch (error) {
      this.markMetadataIncomplete()
      try {
        this.options.log.warn(
          'Runtime Session committed; derived file projection remains incomplete.',
          {
            projectId: scope.projectId,
            sessionId: scope.sessionId,
            revision: persisted.revision,
            errorCategory: error instanceof Error ? error.name : typeof error
          }
        )
        this.options.notifyFilesChanged({
          projectId: scope.projectId,
          sources: ['artifact', 'upload'],
          kind: 'reset'
        })
      } catch {
        /* Diagnostics and observer delivery cannot undo a committed mutation. */
      }
    }
    try {
      this.options.notifyRuntimeTranscriptSessionUpdated?.(this.projectRuntimeSession(persisted))
    } catch {
      // A disconnected observer cannot undo the authoritative JSON commit.
    }
    return persisted
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

  async bindTaskSession(command: BindTaskSessionRequest): Promise<PersistedChatSession> {
    const { projectId, id } = command.session
    this.options.assertMutable(projectId, id, 'mutate')
    const loaded = await loadAuthority(this.options.repository, projectId, id)
    if (loaded.status !== 'found')
      throw new Error(`Cannot bind Task provider for a ${loaded.status} Session.`)
    if (loaded.session.archivedAt !== undefined)
      throw new Error('Cannot bind a Task provider to an archived Session.')
    if (loaded.session.runtimeTranscriptOwner === 'main') {
      return this.mutateRuntimeSession({ projectId, sessionId: id }, (latest) =>
        rebaseTaskSessionBinding(latest, command)
      )
    }
    return this.saveSession(rebaseTaskSessionBinding(loaded.session, command))
  }

  async admitTaskTurn(command: AdmitTaskSessionTurnRequest): Promise<PersistedChatSession> {
    const prepared = command.session
    this.options.assertMutable(prepared.projectId, prepared.id, 'mutate')
    const loaded = await loadAuthority(this.options.repository, prepared.projectId, prepared.id)
    if (loaded.status !== 'found')
      throw new Error(`Cannot admit Task turn for a ${loaded.status} Session.`)
    const latest = loaded.session
    if (latest.archivedAt !== undefined)
      throw new Error('Cannot admit a Task turn to an archived Session.')
    if (
      latest.activeRun &&
      latest.activeRun.promptMessageId !== prepared.activeRun?.promptMessageId
    ) {
      throw new Error('Session already has an active run.')
    }
    const latestGraph = materializeSessionConversationGraph(latest).conversationGraph
    const preparedGraph = materializeSessionConversationGraph(prepared).conversationGraph
    if (
      latestGraph.activeFrameId !== preparedGraph.activeFrameId ||
      latestGraph.frames.find((frame) => frame.id === latestGraph.activeFrameId)?.activeBranchId !==
        preparedGraph.frames.find((frame) => frame.id === preparedGraph.activeFrameId)
          ?.activeBranchId
    ) {
      throw new Error('The active conversation branch changed before Task prompt admission.')
    }
    const candidate = rebaseTaskTurnOntoLatestSession(latest, prepared, command.contextReset)
    if (candidate.promptPreparation?.promptMessageId === candidate.activeRun?.promptMessageId)
      delete candidate.promptPreparation
    return latest.runtimeTranscriptOwner === 'main'
      ? this.mutateRuntimeSession(
          { projectId: latest.projectId, sessionId: latest.id },
          () => candidate
        )
      : this.saveSessionWithAuthority(candidate, {}, { taskRunCommit: false }, true)
  }

  async stageTaskCompletion(
    command: StageTaskSessionCompletionRequest
  ): Promise<PersistedChatSession> {
    const session = await this.loadTaskRunAuthority(command, {
      stagedMessage: command.message
    })
    if (session.runtimeTranscriptOwner === 'main') return session
    const activeMessages = resolveActiveConversationMessages(
      materializeSessionConversationGraph(session).conversationGraph
    )
    const rendererSettledMessage =
      session.activeRun === undefined
        ? activeMessages.findLast(
            (message) =>
              message.role === 'agent' &&
              message.status === 'complete' &&
              message.responseToMessageId === command.promptMessageId
          )
        : undefined
    const messageIds = new Set(session.messages.map(({ id }) => id))
    const activities = (session.activities ?? []).map((activity) => structuredClone(activity))
    const activityById = new Map(activities.map((activity) => [activity.id, activity]))
    for (const activity of command.activities) {
      const current = activityById.get(activity.id)
      if (current) {
        Object.assign(current, structuredClone(activity), {
          eventIds: [...new Set([...current.eventIds, ...activity.eventIds])],
          createdAt: Math.min(current.createdAt, activity.createdAt),
          updatedAt: Math.max(current.updatedAt, activity.updatedAt)
        })
      } else {
        const next = structuredClone(activity)
        activities.push(next)
        activityById.set(next.id, next)
      }
    }
    const candidate = materializeSessionConversationGraph({
      ...session,
      messages:
        command.message && !rendererSettledMessage && !messageIds.has(command.message.id)
          ? [...session.messages, structuredClone(command.message)]
          : session.messages,
      activities,
      ...(command.clearPendingHistoryReplay ? { pendingHistoryReplay: undefined } : {}),
      updatedAt: Math.max(session.updatedAt + 1, command.updatedAt)
    })
    return this.persistTaskSession(candidate)
  }

  async settleTaskCompletion(
    command: SettleTaskSessionCompletionRequest
  ): Promise<PersistedChatSession> {
    const session = await this.loadTaskRunAuthority(command, {
      settledMessageId: command.messageId
    })
    return this.persistTaskTerminalState(session, command, {
      status: 'idle',
      error: undefined,
      errorReportable: undefined
    })
  }

  async failTaskRun(command: FailTaskSessionRunRequest): Promise<PersistedChatSession> {
    const session = await this.loadTaskRunAuthority(command, {
      settledMessageId: command.messageId
    })
    return this.persistTaskTerminalState(session, command, {
      status: 'error',
      error: command.error,
      errorReportable: command.errorReportable
    })
  }

  private async loadTaskRunAuthority(
    command: {
      projectId: string
      sessionId: string
      promptMessageId: string
    },
    proof: Readonly<{
      settledMessageId?: string
      stagedMessage?: PersistedChatMessage
    }> = {}
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(command.projectId, command.sessionId, 'mutate')
    const loaded = await loadAuthority(
      this.options.repository,
      command.projectId,
      command.sessionId
    )
    if (loaded.status !== 'found') {
      throw new Error(`Cannot mutate Task completion for a ${loaded.status} Session.`)
    }
    const { settledMessageId, stagedMessage } = proof
    const ownsActiveRun = loaded.session.activeRun?.promptMessageId === command.promptMessageId
    const materializedGraph = materializeSessionConversationGraph(loaded.session).conversationGraph
    const durablePrompt = materializedGraph?.messages.find(
      (message) => message.id === command.promptMessageId && message.role === 'user'
    )
    const ownsSettledMessage =
      loaded.session.activeRun === undefined &&
      settledMessageId !== undefined &&
      loaded.session.messages.some(
        (message) =>
          message.id === settledMessageId && message.responseToMessageId === command.promptMessageId
      )
    const ownsMainSettledMessage =
      loaded.session.runtimeTranscriptOwner === 'main' &&
      settledMessageId !== undefined &&
      durablePrompt !== undefined &&
      materializedGraph?.messages.some(
        (message) =>
          message.id === settledMessageId &&
          message.role === 'agent' &&
          message.status === 'complete' &&
          message.responseToMessageId === command.promptMessageId &&
          message.agentFrameId === durablePrompt.agentFrameId &&
          message.introducedOnBranchId === durablePrompt.introducedOnBranchId &&
          message.runtimeSegmentId === durablePrompt.runtimeSegmentId
      ) === true
    const activeMessages = materializedGraph
      ? resolveActiveConversationMessages(materializedGraph)
      : loaded.session.messages
    const ownsStagedMessage =
      loaded.session.activeRun === undefined &&
      stagedMessage?.role === 'agent' &&
      stagedMessage.status === 'complete' &&
      stagedMessage.responseToMessageId === command.promptMessageId &&
      activeMessages.some((message) => message.id === command.promptMessageId) &&
      activeMessages.some(
        (message) =>
          message.role === 'agent' &&
          message.status === 'complete' &&
          message.responseToMessageId === command.promptMessageId
      )
    const ownsMainSettledRun =
      loaded.session.runtimeTranscriptOwner === 'main' &&
      loaded.session.runtimeTranscriptLastRun?.promptMessageId === command.promptMessageId
    // Startup reconciliation already settled this prompt as interrupted by app restart and removed
    // its durable run; the Task Run journal still needs to record its commit witness idempotently.
    const ownsRestartInterruption =
      loaded.session.activeRun === undefined &&
      loaded.session.resumeRecovery?.cause === 'app-restart' &&
      loaded.session.resumeRecovery.promptMessageId === command.promptMessageId
    if (
      !ownsActiveRun &&
      !ownsSettledMessage &&
      !ownsMainSettledMessage &&
      !ownsStagedMessage &&
      !ownsMainSettledRun &&
      !ownsRestartInterruption
    ) {
      throw new Error('Task completion no longer owns the active Session run.')
    }
    return loaded.session
  }

  private async persistTaskTerminalState(
    session: PersistedChatSession,
    command: SettleTaskSessionCompletionRequest,
    terminal: Pick<PersistedChatSession, 'status' | 'error' | 'errorReportable'>
  ): Promise<PersistedChatSession> {
    if (session.runtimeTranscriptOwner === 'main') {
      // Runtime completion has already committed the exact transcript and publication outcome.
      // A superseding turn owns the Session witness as well as its transcript.
      if (session.activeRun && session.activeRun.promptMessageId !== command.promptMessageId)
        return session
      if (session.activeRun) {
        if (terminal.status !== 'error')
          throw new Error('Main runtime completion has not committed yet.')
        // Failure before runtime admission or interrupted startup has no terminal runtime event.
        // Apply its exact prompt failure as a Main delta; never replay the Task snapshot graph.
        return this.mutateRuntimeSession(
          { projectId: session.projectId, sessionId: session.id },
          (latest) => {
            if (latest.activeRun?.promptMessageId !== command.promptMessageId) return latest
            const materialized = materializeSessionConversationGraph(latest)
            const prompt = materialized.conversationGraph?.messages.find(
              ({ id, role }) => id === command.promptMessageId && role === 'user'
            )
            const failureAt = Math.max(latest.updatedAt + 1, command.updatedAt)
            const terminalized = prompt?.runtimeSegmentId
              ? applyRuntimeSessionEvents(
                  materialized,
                  {
                    promptMessageId: prompt.id,
                    agentFrameId: prompt.agentFrameId,
                    messageBranchId: prompt.introducedOnBranchId,
                    runtimeSegmentId: prompt.runtimeSegmentId
                  },
                  [
                    {
                      id: `task-run-failure:${command.taskRunCommitId}`,
                      kind: 'error',
                      level: 'error',
                      sessionId: latest.id,
                      promptMessageId: prompt.id,
                      timestamp: failureAt,
                      title: 'Task Run failed',
                      text: terminal.error ?? 'Task Run failed.',
                      providerError: terminal.errorReportable === false,
                      ...('interruptionCause' in command &&
                      command.interruptionCause === 'app-restart'
                        ? { interruptionCause: 'app-restart' as const }
                        : {})
                    }
                  ]
                )
              : { ...latest, ...terminal, activeRun: undefined }
            return {
              ...terminalized,
              taskRunCommitId: command.taskRunCommitId,
              updatedAt: Math.max(terminalized.updatedAt, failureAt)
            }
          }
        )
      }
      // Task only records its journal witness for the corresponding completed turn.
      if (
        session.runtimeTranscriptLastRun &&
        session.runtimeTranscriptLastRun.promptMessageId !== command.promptMessageId
      ) {
        return session
      }
      if (session.taskRunCommitId === command.taskRunCommitId) return session
      return this.persistTaskSession({ ...session, taskRunCommitId: command.taskRunCommitId })
    }
    const newArtifacts = command.artifacts.filter(
      ({ id }) => !session.artifacts?.some((artifact) => artifact.id === id)
    )
    const artifactIds = command.artifacts.map(({ id }) => id)
    const messages = session.messages.map((message) =>
      message.id === command.messageId && artifactIds.length > 0
        ? {
            ...message,
            artifactIds: [...new Set([...(message.artifactIds ?? []), ...artifactIds])],
            updatedAt: Math.max(message.updatedAt + 1, command.updatedAt)
          }
        : message
    )
    if (artifactIds.length > 0 && !messages.some(({ id }) => id === command.messageId)) {
      throw new Error('Task completion Artifact owner Message is missing.')
    }
    let candidate: PersistedChatSession = materializeSessionConversationGraph({
      ...session,
      ...terminal,
      activeRun: undefined,
      taskRunCommitId: command.taskRunCommitId,
      messages,
      artifacts: [
        ...(session.artifacts ?? []),
        ...newArtifacts.map((artifact) => structuredClone(artifact))
      ],
      filesRevision:
        newArtifacts.length > 0 ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
      updatedAt: Math.max(session.updatedAt + 1, command.updatedAt)
    })
    const outcome: TurnOutcome =
      terminal.status === 'error'
        ? 'interruptionCause' in command && command.interruptionCause === 'app-restart'
          ? {
              kind: 'interrupted',
              cause: 'app-restart',
              settledAt: command.updatedAt,
              error: terminal.error,
              errorReportable: false,
              recovery: 'resume'
            }
          : {
              kind: 'failed',
              settledAt: command.updatedAt,
              error: terminal.error,
              errorReportable: terminal.errorReportable
            }
        : { kind: 'completed', settledAt: command.updatedAt }
    candidate = session.status.startsWith('waiting-')
      ? {
          ...candidate,
          status: session.status,
          error: session.error,
          errorReportable: session.errorReportable,
          resumeRecovery: session.resumeRecovery
        }
      : {
          ...setTurnOutcome(candidate, command.promptMessageId, outcome),
          ...legacySessionStateForOutcome(outcome, command.promptMessageId)
        }
    const validation = await validateFinalizedArtifactBindings(
      this.options.provenance,
      candidate,
      this.options.log
    )
    if (validation.status === 'conflict') throw validation.error
    const persisted = await this.persistTaskSession(candidate)
    if (validation.status === 'valid') {
      this.validatedBindingTopologies.set(
        `${persisted.projectId}:${persisted.id}`,
        sessionBindingTopologyHash(persisted)
      )
    }
    await this.options.provenance?.captureFinalizedMessages(persisted)
    if (artifactIds.length === 0) return persisted
    let changedSources: ProjectFileSource[]
    try {
      changedSources = await this.options.fileIndex.syncSession(persisted)
    } catch (error) {
      this.markMetadataIncomplete()
      this.options.notifyFilesChanged({
        projectId: persisted.projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      throw error
    }
    if (changedSources.length > 0) {
      this.options.notifyFilesChanged({
        projectId: persisted.projectId,
        sessionId: persisted.id,
        sources: changedSources,
        kind: 'upsert'
      })
    }
    return persisted
  }

  private async persistTaskSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession> {
    let persisted: PersistedChatSession
    try {
      persisted = await saveSessionWithRevision(this.options.repository, session, expectedRevision)
    } catch (error) {
      if (!(error instanceof SessionProjectionAfterCommitError)) throw error
      persisted = error.committedSession
      this.markMetadataIncomplete()
    }
    this.recordSession(persisted)
    return persisted
  }

  async setResearchMembership(input: SetResearchMembershipRequest): Promise<PersistedChatSession> {
    const request = setResearchMembershipRequestSchema.parse(input)
    this.options.assertMutable(request.projectId, request.sessionId, 'mutate')
    const loaded = await loadAuthority(
      this.options.repository,
      request.projectId,
      request.sessionId
    )
    if (loaded.status !== 'found') throw new Error('The discussion Session is unavailable.')
    const current = loaded.session
    if (current.packageOrigin || current.archivedAt !== undefined)
      throw new Error('Research membership requires a writable discussion Session.')
    if (sessionRevision(current) !== request.expectedRevision)
      throw new SessionRevisionConflictError(request.expectedRevision, sessionRevision(current))
    const membership = request.source
      ? await resolveResearchMembership(
          current,
          {
            sourceProjectId: request.source.projectId,
            sourceSessionId: request.source.sourceSessionId,
            sourceImportId: request.source.importId,
            sourceTitle: ''
          },
          (projectId, sessionId) => loadAuthority(this.options.repository, projectId, sessionId)
        )
      : undefined
    if (isDeepStrictEqual(current.researchMembership, membership)) return current
    const candidate = { ...current, researchMembership: membership }
    // Organization changes do not reorder the conversation or alter reading focus.
    if (!membership) delete candidate.researchMembership
    const saved = await this.persistTaskSession(candidate, request.expectedRevision)
    this.options.notifyRuntimeContextSessionUpdated(saved)
    return saved
  }

  private async saveSessionWithAuthority(
    session: PersistedChatSession,
    options: MainSaveSessionOptions = {},
    saveAuthority: SessionSaveAuthority = { taskRunCommit: false },
    mainTurnAdmission = false
  ): Promise<PersistedChatSession> {
    this.options.assertMutable(session.projectId, session.id, 'save')
    const { projectId, id: sessionId } = session
    if (
      saveAuthority.callerSignal &&
      options.conversationCommands?.some(({ kind }) => kind === 'prepare-prompt')
    )
      this.promptPreparations.watchCaller(saveAuthority.callerSignal, (scope) =>
        this.options.releaseAbandonedPreparation?.(scope)
      )
    let authoritative = await loadAuthority(this.options.repository, projectId, sessionId)
    if (
      authoritative.status === 'found' &&
      this.promptPreparations.isAbandoned(authoritative.session)
    ) {
      await this.releaseAbandonedPreparation({ projectId, sessionId })
      authoritative = await loadAuthority(this.options.repository, projectId, sessionId)
    }
    if (
      authoritative.status === 'found' &&
      authoritative.session.runtimeTranscriptOwner === 'main' &&
      ((authoritative.session.promptPreparation &&
        !this.promptPreparations.ownsPreparation(authoritative.session)) ||
        (authoritative.session.activeRun &&
          !this.promptPreparations.hasUnadmittedRun(authoritative.session))) &&
      !this.runtimeTerminalFailures.has(sessionId) &&
      !this.options.repository.hasLiveRuntimeSession?.(projectId, sessionId)
    ) {
      // A preference save after restart must not publish the abandoned run back to the renderer.
      // Commit the same recovery used by Resume before rebasing user intent onto its authority.
      await this.prepareRuntimeResume({ projectId, sessionId })
      authoritative = await loadAuthority(this.options.repository, projectId, sessionId)
    }
    if (authoritative.status === 'unreadable') {
      throw new Error(
        'Cannot save Session projection because main-owned runtime context is unreadable.'
      )
    }
    const authority = authoritative.status === 'found' ? authoritative.session : undefined
    if (
      !authority &&
      options.conversationCommands?.some(
        (command) =>
          command.kind === 'prepare-prompt' ||
          command.kind === 'rollback-prompt' ||
          command.preparationId
      )
    )
      throw new Error('Conversation Branch changed before the user Message was admitted.')
    // Membership is supplied only on first creation. Every later renderer snapshot preserves
    // Main's durable grouping, including explicit removal by the dedicated command.
    const researchMembership = authority
      ? authority.researchMembership
      : session.researchMembership
        ? await resolveResearchMembership(
            session,
            session.researchMembership,
            (sourceProjectId, sourceSessionId) =>
              loadAuthority(this.options.repository, sourceProjectId, sourceSessionId)
          )
        : undefined
    session = { ...session, researchMembership }
    session = preserveMainTurnOutcomes(session, authority)
    const prepareMainOwnership =
      authority && options.conversationCommands?.some(({ kind }) => kind === 'prepare-prompt')
    if (prepareMainOwnership && authority.packageOrigin) {
      // Imported research may be viewed but cannot acquire a new mutable transcript owner.
      throw new Error('Imported research history is read-only.')
    }
    if (authority && (authority.runtimeTranscriptOwner === 'main' || prepareMainOwnership)) {
      // A renderer snapshot is presentation, not a second runtime writer. Apply only named user
      // preferences and graph commands to the latest authority. Never borrow its revision for the
      // incoming graph (even if that graph has newer timestamps).
      const fields = options.conflictRebaseFields ?? []
      let candidate = fields.length
        ? rebaseSafeSessionFields(authority, session, fields)
        : authority
      // Snapshot reset flags and timestamps are not user intents. A stale save must not re-arm a
      // consumed provider replay or create another revision merely to acknowledge an observation.
      candidate = { ...candidate, updatedAt: authority.updatedAt }
      if (authority.branchContextResetRequired === undefined)
        delete candidate.branchContextResetRequired
      else candidate.branchContextResetRequired = authority.branchContextResetRequired
      if (!isDeepStrictEqual(candidate, authority))
        candidate.updatedAt = Math.max(authority.updatedAt + 1, Date.now())
      if (options.conversationCommands?.length) {
        try {
          candidate = preserveMainTurnOutcomes(
            this.promptPreparations.apply(
              candidate,
              options.conversationCommands,
              saveAuthority.callerSignal
            ),
            authority,
            false
          )
        } catch (error) {
          // A renderer edit can arrive after the UI becomes idle but before Main commits the
          // terminal runtime projection. Keep the command pending; independent named preferences
          // in this same save still belong to the current renderer intent and must be committed.
          // The next terminal save retries the command against an authority with no active run.
          // Real branch identity conflicts still reject.
          if (error instanceof SessionConversationCommandDeferredError)
            return this.mutateRuntimeSession({ projectId, sessionId }, () => candidate)
          throw error
        }
        if (this.options.uploads)
          candidate = await this.options.uploads.upgradeLegacySessionUploads(candidate, {
            mode: 'live-save'
          })
      }
      return this.mutateRuntimeSession({ projectId, sessionId }, () => candidate)
    }
    session = {
      ...session,
      forkOrigin: authority?.forkOrigin,
      forkHeadMessageId: authority?.forkHeadMessageId
    }
    if (authority?.packageOrigin) session = preserveImportedSession(authority, session)
    else if (session.packageOrigin) session = { ...session, packageOrigin: undefined }
    const { session: submittedSession, expectedRevision } = resolveRevisionedSessionSave(
      authority,
      session,
      options.conflictRebaseFields
    )

    const rendererOwnedSession: PersistedChatSession = { ...submittedSession }
    // Adoption belongs to the awaited Main runtime admission path, not a caller-provided flag.
    if (!authority?.runtimeTranscriptOwner) {
      delete rendererOwnedSession.runtimeTranscriptOwner
      delete rendererOwnedSession.runtimeTranscriptReviewOwner
      delete rendererOwnedSession.runtimeTranscriptLastRun
      delete rendererOwnedSession.runtimeSessionAdmissions
      delete rendererOwnedSession.runtimeConversationCommandIds
    }
    delete rendererOwnedSession.promptPreparation
    delete rendererOwnedSession.runtimeContext
    delete rendererOwnedSession.archivedAt
    if (authority) delete rendererOwnedSession.planHistoryProjections
    const taskRunCommitId =
      saveAuthority.taskRunCommit && rendererOwnedSession.taskRunCommitId
        ? rendererOwnedSession.taskRunCommitId
        : authority?.taskRunCommitId
    // This witness participates in Task's cross-file commit protocol. Whole-Session saves from
    // renderer/web surfaces may preserve it, but only the Task surface may advance it.
    delete rendererOwnedSession.taskRunCommitId
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
    if (authority) delete rendererOwnedSession.delegationPolicy
    if (authority) delete rendererOwnedSession.computeConcurrencyLimit
    let conversationAuthority: PersistedChatSession | undefined
    if (authority && options.conversationCommands?.length) {
      try {
        conversationAuthority = preserveMainTurnOutcomes(
          this.promptPreparations.apply(
            authority,
            options.conversationCommands,
            saveAuthority.callerSignal
          ),
          authority,
          false
        )
      } catch (error) {
        if (!(error instanceof SessionConversationCommandDeferredError)) throw error
        // The optimistic renderer graph must not bypass a command deferred by an active run.
        // Preserve independent preference intent while the pending commands await settlement.
        conversationAuthority = authority
      }
    }
    // Session state belongs to Main even before runtime transcript adoption. Historical state
    // remains readable, but renderer saves cannot replace it or establish a new running/error
    // Session. Only the validated Main turn-admission path may commit its prepared state here;
    // this authority is private and cannot be supplied through renderer save options.
    const stateAuthority = mainTurnAdmission
      ? submittedSession
      : (conversationAuthority ?? authority)
    const mainOwnedState = {
      status: stateAuthority?.status ?? ('idle' as const),
      error: stateAuthority?.error,
      errorReportable: stateAuthority?.errorReportable,
      resumeRecovery: stateAuthority?.resumeRecovery
    }
    // Once Main has durable Session-details ownership, a stale whole-Session renderer save may
    // continue the transcript but cannot roll back generated/manual copy or its attempt/usage
    // record. New and legacy Sessions can still establish their initial fallback on the first save;
    // all later edits use the dedicated SessionDetailsOwner transaction.
    const mainOwnedSessionDetails =
      authority &&
      (authority.sessionDetailsSource !== undefined ||
        authority.sessionDetailsGeneration !== undefined)
        ? {
            title: authority.title,
            description: authority.description,
            sessionDetailsSource: authority.sessionDetailsSource,
            sessionDetailsGeneration: authority.sessionDetailsGeneration
          }
        : undefined
    const commandProjection = conversationAuthority
      ? {
          conversationGraph: conversationAuthority.conversationGraph,
          messages: conversationAuthority.messages,
          activities: conversationAuthority.activities,
          activityGroups: conversationAuthority.activityGroups,
          activeRun: conversationAuthority.activeRun,
          promptPreparation: conversationAuthority.promptPreparation,
          runtimeConversationCommandIds: conversationAuthority.runtimeConversationCommandIds,
          pendingHistoryReplay: conversationAuthority.pendingHistoryReplay,
          branchContextResetRequired: conversationAuthority.branchContextResetRequired
        }
      : {}
    const relayProjection = mergeMainOwnedRelayProjection(
      { ...rendererOwnedSession, ...commandProjection },
      authority
    )
    const mergedSession: PersistedChatSession = {
      ...rendererOwnedSession,
      ...commandProjection,
      ...relayProjection,
      ...mainOwnedSessionDetails,
      ...(authority?.runtimeContext ? { runtimeContext: authority.runtimeContext } : {}),
      ...(authority?.archivedAt ? { archivedAt: authority.archivedAt } : {}),
      ...(authority?.planHistoryProjections
        ? { planHistoryProjections: authority.planHistoryProjections }
        : {}),
      ...(taskRunCommitId ? { taskRunCommitId } : {}),
      ...(authority && !specialistBindingOwnedByCaller
        ? {
            specialistId: authority.specialistId,
            specialistBindingPending: authority.specialistBindingPending
          }
        : {}),
      ...(authority ? { branchSource: authority.branchSource } : {}),
      ...(authority
        ? { delegationPolicy: normalizeDelegationPolicy(authority.delegationPolicy) }
        : {}),
      ...(authority
        ? {
            enabledComputeHosts: authority.enabledComputeHosts
              ? [...authority.enabledComputeHosts]
              : undefined,
            selectedComputeHosts: authority.selectedComputeHosts
              ? [...authority.selectedComputeHosts]
              : undefined
          }
        : {}),
      ...(authority ? { computeConcurrencyLimit: authority.computeConcurrencyLimit } : {}),
      ...mainOwnedState,
      promptPreparation: conversationAuthority
        ? conversationAuthority.promptPreparation
        : authority?.promptPreparation,
      // Merging unchanged Main-owned authority is storage maintenance, not conversation activity.
      // Preserve the newest real activity time so opening a lazily loaded Session cannot move it into
      // the Workspace Active section. The dedicated Specialist binding transaction remains an
      // explicit mutation and therefore advances the timestamp here.
      updatedAt: specialistBindingChanged
        ? Math.max(rendererOwnedSession.updatedAt, (authority?.updatedAt ?? -1) + 1, Date.now())
        : Math.max(
            rendererOwnedSession.updatedAt,
            authority?.updatedAt ?? -1,
            conversationAuthority?.updatedAt ?? -1
          )
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

      const { projectId, id: sessionId } = submittedSession
      const latest = await loadAuthority(this.options.repository, projectId, sessionId)
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
  SessionMetadataSnapshot,
  SessionSaveAuthority
}
