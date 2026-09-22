import { isDeepStrictEqual } from 'node:util'
import type { AcpPermissionRequest, AcpRuntimeEvent } from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import {
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type MessageAttribution,
  type PersistedActiveRun,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import { hasDurableRuntimeSessionAdmission } from '../../shared/runtime-session-admission'
import {
  applyRuntimeSessionEvents,
  attachRuntimeSessionArtifacts,
  type RuntimeSessionScope
} from '../../shared/runtime-session-projection'
import { matchPlanDelivery } from '../session-plan/plan-delivery'

const DEFAULT_FLUSH_INTERVAL_MS = 2_000
const MAX_RETAINED_TURNS = 500
const MAX_RETAINED_PUBLICATIONS = 500

export type RuntimeSessionTurnScope = RuntimeSessionScope & {
  projectId: string
  sessionId: string
  executionId: string
}

export type RuntimeSessionArtifactPublication = {
  appSessionId: string
  artifactClaimId: string
  runId: string
  promptMessageId: string
  artifacts: readonly ArtifactFile[]
  executionId: string
}

export type RuntimeSessionAdmission = {
  providerSessionId?: string
  providerContinuityToken?: string
  agentFrameworkId?: AgentFrameworkId
  agentBackendId?: string
  agentModel?: string
  reviewOwner?: 'task' | 'renderer'
  // Supplied only by the live app continuation after claiming this durable delivery.
  planDeliveryCommandId?: string
  // Main-only identity of the fenced reliable message; never serialized as provider binding.
  delegatedMessageId?: string
  // Main-owned application turns create their prompt and execution authority in one commit.
  applicationPrompt?: { text: string; attribution: MessageAttribution }
}

export type RuntimeSessionArtifactPublicationReceipt = {
  projectId: string
  sessionId: string
  promptMessageId: string
  artifactClaimId: string
  runId: string
  messageId: string
  artifacts: ArtifactFile[]
}

export class RuntimeSessionArtifactPublicationError extends Error {
  constructor(
    message: string,
    readonly committed: RuntimeSessionArtifactPublicationReceipt,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RuntimeSessionArtifactPublicationError'
  }
}

const unconfirmedAttachmentMessage = (
  identity: RuntimeSessionArtifactPublicationReceipt
): string => {
  const artifactVersionIds = identity.artifacts.map(({ id, versionId }) => versionId ?? id)
  return `Artifacts were finalized; Session attachment is unconfirmed. Recovery identities: runId=${JSON.stringify(identity.runId)}, messageId=${JSON.stringify(identity.messageId)}, artifactVersionIds=${JSON.stringify(artifactVersionIds)}.`
}

type RuntimeSessionOwnerDependencies = {
  loadSession(scope: RuntimeSessionTurnScope): Promise<PersistedChatSession | undefined>
  mutateSession(
    scope: RuntimeSessionTurnScope,
    mutate: (latest: PersistedChatSession) => PersistedChatSession
  ): Promise<PersistedChatSession>
  finalizeArtifacts(request: { claimId: string; messageId: string }): Promise<ArtifactFile[]>
  onCommitted?(session: PersistedChatSession): void
  scheduleFlush?(flush: () => void, delayMs: number): () => void
  now?: () => number
  flushIntervalMs?: number
}

type Turn = {
  scope: RuntimeSessionTurnScope
  runStartedAt: number
  promptRuntimeSegmentId: string
  pending: AcpRuntimeEvent[]
  acceptedEventIds: Set<string>
  terminalEventIds: Set<string>
  tail: Promise<void>
  cancelScheduledFlush?: () => void
  terminalObserved: boolean
  replayConsumptionPending: boolean
  elicitationReceipts: Map<string, number | undefined>
}

type PublicationAttempt = {
  key: string
  scope: RuntimeSessionTurnScope
  eventId: string
  timestamp: number
  publication: RuntimeSessionArtifactPublication
  messageId?: string
  finalizedArtifacts?: ArtifactFile[]
  receipt?: RuntimeSessionArtifactPublicationReceipt
  tail?: Promise<RuntimeSessionArtifactPublicationReceipt>
}

const turnKey = (sessionId: string, promptMessageId: string): string =>
  `${sessionId.length}:${sessionId}${promptMessageId}`

const canonicalArtifactDescriptors = (artifacts: readonly ArtifactFile[]): string[] =>
  artifacts
    .map((artifact) =>
      JSON.stringify({
        id: artifact.id,
        projectId: artifact.projectId,
        sessionId: artifact.sessionId,
        messageId: artifact.messageId,
        runId: artifact.runId,
        name: artifact.name,
        path: artifact.path,
        fileUrl: artifact.fileUrl,
        mimeType: artifact.mimeType,
        size: artifact.size,
        mtimeMs: artifact.mtimeMs,
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
        versionNumber: artifact.versionNumber,
        checksum: artifact.checksum,
        createdAt: artifact.createdAt,
        producerRunId: artifact.producerRunId,
        environment: artifact.environment
      })
    )
    .sort()

const sameArtifactDescriptorSet = (
  left: readonly ArtifactFile[],
  right: readonly ArtifactFile[]
): boolean => {
  const canonicalLeft = canonicalArtifactDescriptors(left)
  const canonicalRight = canonicalArtifactDescriptors(right)
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((descriptor, index) => descriptor === canonicalRight[index])
  )
}

const defaultScheduleFlush = (flush: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(flush, delayMs)
  return () => clearTimeout(timer)
}

const assertScopeMatchesSession = (
  scope: RuntimeSessionTurnScope,
  session: PersistedChatSession,
  requireActiveRun = false,
  promptRuntimeSegmentId = scope.runtimeSegmentId
): void => {
  if (session.id !== scope.sessionId || session.projectId !== scope.projectId) {
    throw new Error('Runtime Session scope does not match the durable Session owner.')
  }
  if (
    (requireActiveRun && session.activeRun?.promptMessageId !== scope.promptMessageId) ||
    (session.activeRun && session.activeRun.promptMessageId !== scope.promptMessageId)
  ) {
    throw new Error('Runtime Session turn is unknown or superseded.')
  }
  const graph = session.conversationGraph
  const frame = graph?.frames.find((candidate) => candidate.id === scope.agentFrameId)
  const branch = graph?.branches.find((candidate) => candidate.id === scope.messageBranchId)
  const segment = graph?.runtimeSegments.find(
    (candidate) => candidate.id === scope.runtimeSegmentId
  )
  const prompt = graph?.messages.find((candidate) => candidate.id === scope.promptMessageId)
  if (
    !graph ||
    !frame ||
    !branch ||
    branch.agentFrameId !== frame.id ||
    !segment ||
    segment.agentFrameId !== frame.id ||
    !prompt ||
    prompt.role !== 'user' ||
    prompt.agentFrameId !== frame.id ||
    prompt.introducedOnBranchId !== branch.id ||
    prompt.runtimeSegmentId !== promptRuntimeSegmentId
  ) {
    throw new Error('Runtime Session turn has no durable prompt path.')
  }
}

// Application callers supply intent, not a prepared Session snapshot. The runtime owns both
// the durable prompt and its active run, so no caller or renderer can omit half of admission.
const admitApplicationPrompt = (
  session: PersistedChatSession,
  scope: RuntimeSessionTurnScope,
  admission: RuntimeSessionAdmission,
  now: number
): PersistedChatSession => {
  const application = admission.applicationPrompt
  if (!application) return session
  if (application.attribution.kind !== 'application')
    throw new Error('Runtime application prompt requires application attribution.')
  if (session.archivedAt !== undefined)
    throw new Error('Cannot admit an application prompt to an archived Session.')
  if (session.activeRun && session.activeRun.promptMessageId !== scope.promptMessageId)
    throw new Error('Session already has an active run.')
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === scope.agentFrameId)
  if (
    graph?.activeFrameId !== scope.agentFrameId ||
    frame?.activeBranchId !== scope.messageBranchId ||
    graph.runtimeSegments.filter(({ agentFrameId }) => agentFrameId === scope.agentFrameId).at(-1)
      ?.id !== scope.runtimeSegmentId
  )
    throw new Error('Application prompt conversation path changed before admission.')
  const existing = graph.messages.find(({ id }) => id === scope.promptMessageId)
  if (
    existing &&
    (existing.role !== 'user' ||
      existing.content !== application.text ||
      !isDeepStrictEqual(existing.attribution, application.attribution))
  )
    throw new Error('Application prompt conflicts with its durable message.')
  const startedAt = Math.max(now, session.updatedAt + 1)
  const next = materializeSessionConversationGraph({
    ...session,
    status: 'running',
    error: undefined,
    messages: existing
      ? resolveActiveConversationMessages(graph)
      : [
          ...resolveActiveConversationMessages(graph),
          {
            id: scope.promptMessageId,
            role: 'user',
            content: application.text,
            status: 'complete',
            eventIds: [],
            attribution: application.attribution,
            createdAt: startedAt,
            updatedAt: startedAt
          }
        ],
    activeRun: session.activeRun ?? { promptMessageId: scope.promptMessageId, startedAt },
    updatedAt: startedAt
  })
  delete next.resumeRecovery
  return next
}

// A restored provider context starts a new Runtime Segment without rewriting the original
// user Message's provenance. A durable Resume admits that path once; its persisted witness also
// authorizes later decision continuations on the same selected execution Segment.
const resolvePromptRuntimeSegmentId = (
  session: PersistedChatSession,
  scope: RuntimeSessionTurnScope
): string => {
  const graph = session.conversationGraph
  const prompt = graph?.messages.find(({ id }) => id === scope.promptMessageId)
  if (!prompt?.runtimeSegmentId || prompt.runtimeSegmentId === scope.runtimeSegmentId)
    return scope.runtimeSegmentId
  const frame = graph?.frames.find(({ id }) => id === scope.agentFrameId)
  const segment = graph?.runtimeSegments
    .filter(({ agentFrameId }) => agentFrameId === scope.agentFrameId)
    .at(-1)
  const originalSegment = graph?.runtimeSegments.find(({ id }) => id === prompt.runtimeSegmentId)
  const hasRecovery =
    session.resumeRecovery?.kind === 'resume-required' &&
    session.resumeRecovery.promptMessageId === scope.promptMessageId
  const hasAdmission =
    graph &&
    hasDurableRuntimeSessionAdmission(
      session,
      { ...scope, rootFrameId: graph.rootFrameId },
      prompt.runtimeSegmentId
    )
  if (
    (!hasRecovery && !hasAdmission) ||
    graph?.activeFrameId !== scope.agentFrameId ||
    frame?.activeBranchId !== scope.messageBranchId ||
    segment?.id !== scope.runtimeSegmentId ||
    segment.endedAt !== undefined ||
    !originalSegment ||
    originalSegment.agentFrameId !== scope.agentFrameId ||
    segment.startedAt <= originalSegment.startedAt
  )
    throw new Error('Runtime Session continuation has no durable recovery Segment binding.')
  return prompt.runtimeSegmentId
}

// A Conversation Turn can end its provider Attempt while a durable interaction still owns the
// user's decision: an app-owned question, a permission, or a Plan approval. The Session keeps that
// turn parked on its decision, and the decision admits the next Attempt of the same turn.
// The decision is recorded before Main restarts the turn, so the parked state already carries it:
// an answered question stays the parked interaction of its turn, and an approved restored
// permission advances to `continuing` while the Session reports running.
const isParkedTurn = (
  session: PersistedChatSession,
  scope: RuntimeSessionTurnScope,
  planDeliveryCommandId?: string
): boolean => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === scope.agentFrameId)
  if (
    graph?.activeFrameId !== scope.agentFrameId ||
    frame?.activeBranchId !== scope.messageBranchId
  ) {
    return false
  }
  // Approval has already changed (and feedback has its own prompt). The claimed command,
  // rather than the old waiting status, identifies which continuation may re-arm the run.
  if (planDeliveryCommandId) {
    return Boolean(
      matchPlanDelivery(session.runtimeContext?.plan, {
        commandId: planDeliveryCommandId,
        state: 'delivering',
        originatingPromptMessageId: scope.promptMessageId
      })
    )
  }
  const permission = session.runtimeContext?.permission
  if (permission?.state === 'continuing') {
    return permission.originatingPromptMessageId === scope.promptMessageId
  }
  if (permission?.state === 'pending') {
    return (
      session.status.startsWith('waiting-') &&
      permission.originatingPromptMessageId === scope.promptMessageId
    )
  }
  const plan = session.runtimeContext?.plan
  if (plan?.approval === 'pending') {
    return (
      session.status === 'waiting-plan-approval' &&
      plan.originatingPromptMessageId === scope.promptMessageId
    )
  }
  if (!session.status.startsWith('waiting-') && session.status !== 'idle') return false
  return (
    session.conversationGraph?.activities.some(
      (activity) =>
        activity.elicitation?.durable?.kind === 'agent-user-choice' &&
        activity.promptMessageId === scope.promptMessageId &&
        activity.agentFrameId === scope.agentFrameId &&
        activity.messageBranchId === scope.messageBranchId &&
        (session.status.startsWith('waiting-') ||
          (session.runtimeTranscriptLastRun?.promptMessageId === scope.promptMessageId &&
            (activity.elicitation.respondedAt ?? -1) >= session.runtimeTranscriptLastRun.startedAt))
    ) === true
  )
}

// The run to arm when the decision on a parked turn admits its continuation. The continued Attempt
// must be newer than the run it replaces so run identities stay ordered for renderer commands, and
// a turn parked on another turn's decision, or a settled one, is never re-admitted.
const continuationRunFor = (
  session: PersistedChatSession,
  scope: RuntimeSessionTurnScope,
  now: number,
  planDeliveryCommandId?: string
): PersistedActiveRun | undefined => {
  if (session.activeRun) return undefined
  if (!isParkedTurn(session, scope, planDeliveryCommandId)) return undefined
  return {
    promptMessageId: scope.promptMessageId,
    startedAt: Math.max(now, (session.runtimeTranscriptLastRun?.startedAt ?? 0) + 1)
  }
}

// A reliable parent delivery starts another execution of its originating turn. Its durable
// command is the authority; a caller-supplied provenance Segment alone cannot re-arm a turn.
const admitDelegatedMessage = (
  session: PersistedChatSession,
  scope: RuntimeSessionTurnScope,
  admission: RuntimeSessionAdmission,
  now: number
): PersistedChatSession => {
  if (!admission.delegatedMessageId) return session
  const graph = session.conversationGraph
  const root = graph?.frames.find(({ id }) => id === graph.rootFrameId)
  const branch = graph?.branches.find(({ id }) => id === root?.activeBranchId)
  const delegated = session.runtimeContext?.delegatedWork
  const command = delegated?.messageCommands?.find(
    ({ messageId }) => messageId === admission.delegatedMessageId
  )
  const prompt = graph?.messages.find(({ id }) => id === scope.promptMessageId)
  if (
    session.activeRun ||
    session.status !== 'idle' ||
    delegated?.messageCommandsQuarantine ||
    !command ||
    command.direction !== 'to_parent' ||
    command.targetFrameId !== scope.agentFrameId ||
    command.rootOriginMessageId !== scope.promptMessageId ||
    command.rootBranchId !== scope.messageBranchId ||
    command.receipt.status !== 'queued' ||
    command.receipt.dispatchStartedAt === undefined ||
    !command.receipt.dispatchEpoch ||
    root?.id !== scope.agentFrameId ||
    graph?.activeFrameId !== root.id ||
    branch?.id !== scope.messageBranchId ||
    `${branch.id}:${branch.createdAt}` !== command.rootBranchRevision ||
    !prompt?.runtimeSegmentId ||
    scope.runtimeSegmentId !== `delegated-message-${command.messageId}` ||
    graph.runtimeSegments.some(({ id }) => id === scope.runtimeSegmentId)
  )
    throw new Error('Runtime Session has no admissible parent message command.')
  // Validate the original path before introducing the new execution's Segment.
  assertScopeMatchesSession({ ...scope, runtimeSegmentId: prompt.runtimeSegmentId }, session)
  const startedAt = Math.max(now, (session.runtimeTranscriptLastRun?.startedAt ?? 0) + 1)
  return {
    ...session,
    status: 'running',
    activeRun: { promptMessageId: scope.promptMessageId, startedAt },
    conversationGraph: {
      ...graph,
      runtimeSegments: [
        ...graph.runtimeSegments,
        {
          id: scope.runtimeSegmentId,
          agentFrameId: scope.agentFrameId,
          frameworkId:
            admission.agentFrameworkId ??
            session.agentFrameworkId ??
            graph.runtimeSegments.find(({ id }) => id === prompt.runtimeSegmentId)!.frameworkId,
          startedAt
        }
      ]
    }
  }
}

export class RuntimeSessionOwner {
  private readonly turns = new Map<string, Turn>()
  private readonly publications = new Map<string, PublicationAttempt>()
  private readonly now: () => number

  constructor(private readonly dependencies: RuntimeSessionOwnerDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async begin(
    scope: RuntimeSessionTurnScope,
    admission: RuntimeSessionAdmission = {}
  ): Promise<PersistedChatSession> {
    // A detached answer is emitted after the provider stop and queued by the same turn.
    // Commit that decision before replacing its execution, rather than racing the batch timer.
    const previousTurn = this.turns.get(turnKey(scope.sessionId, scope.promptMessageId))
    if (previousTurn?.terminalObserved) {
      await this.flush(scope.sessionId, scope.promptMessageId)
    }
    let loaded = await this.dependencies.loadSession(scope)
    if (!loaded) throw new Error('Runtime Session turn is not durable.')
    const sameExecution =
      previousTurn?.scope.executionId === scope.executionId &&
      previousTurn.scope.agentFrameId === scope.agentFrameId &&
      previousTurn.scope.messageBranchId === scope.messageBranchId &&
      previousTurn.scope.runtimeSegmentId === scope.runtimeSegmentId
    if (!sameExecution) {
      loaded = admitApplicationPrompt(loaded, scope, admission, this.now())
      loaded = admitDelegatedMessage(loaded, scope, admission, this.now())
    }
    const continuationRun = continuationRunFor(
      loaded,
      scope,
      this.now(),
      admission.planDeliveryCommandId
    )
    const promptRuntimeSegmentId = sameExecution
      ? previousTurn.promptRuntimeSegmentId
      : admission.delegatedMessageId
        ? loaded.conversationGraph!.messages.find(({ id }) => id === scope.promptMessageId)!
            .runtimeSegmentId!
        : resolvePromptRuntimeSegmentId(loaded, scope)
    assertScopeMatchesSession(scope, loaded, continuationRun === undefined, promptRuntimeSegmentId)
    const admittedRun = loaded.activeRun ?? continuationRun

    const key = turnKey(scope.sessionId, scope.promptMessageId)
    const existing = this.turns.get(key)
    if (existing) {
      if (existing.scope.executionId !== scope.executionId) {
        const nextRunStartedAt = admittedRun?.startedAt
        if (
          !existing.terminalObserved ||
          existing.pending.length > 0 ||
          nextRunStartedAt === undefined ||
          nextRunStartedAt <= existing.runStartedAt
        ) {
          throw new Error('Runtime Session turn is already owned by another execution.')
        }
        existing.cancelScheduledFlush?.()
        this.turns.delete(key)
      } else {
        return loaded
      }
    }
    for (const turn of this.turns.values()) {
      if (turn.scope.sessionId === scope.sessionId) {
        if (turn.terminalObserved && turn.pending.length === 0) {
          this.turns.delete(turnKey(turn.scope.sessionId, turn.scope.promptMessageId))
          continue
        }
        throw new Error('Runtime Session turn is superseded by another registered turn.')
      }
    }
    // The coordinator stamps Main's runtime ownership in this identity mutation. Await it before
    // provider dispatch so a renderer save can never become the first durable writer for the turn.
    const session = await this.dependencies.mutateSession(scope, (latest) => {
      latest = admitApplicationPrompt(latest, scope, admission, this.now())
      latest = admitDelegatedMessage(latest, scope, admission, this.now())
      // Re-derive against the durable record Main is about to write: only a still-parked turn may
      // be continued, and its re-armed run has to be newer than the run it replaces.
      const resumedRun = continuationRunFor(
        latest,
        scope,
        this.now(),
        admission.planDeliveryCommandId
      )
      if (
        !admission.delegatedMessageId &&
        resolvePromptRuntimeSegmentId(latest, scope) !== promptRuntimeSegmentId
      )
        throw new Error('Runtime Session prompt Segment changed before admission.')
      assertScopeMatchesSession(scope, latest, resumedRun === undefined, promptRuntimeSegmentId)
      const {
        reviewOwner = 'renderer',
        planDeliveryCommandId: _planDeliveryCommandId,
        delegatedMessageId: _delegatedMessageId,
        applicationPrompt: _applicationPrompt,
        ...runtimeBinding
      } = admission
      void _planDeliveryCommandId
      void _delegatedMessageId
      void _applicationPrompt
      const durableAdmission = {
        executionId: scope.executionId,
        promptMessageId: scope.promptMessageId,
        promptRuntimeSegmentId,
        rootFrameId: latest.conversationGraph!.rootFrameId,
        agentFrameId: scope.agentFrameId,
        messageBranchId: scope.messageBranchId,
        runtimeSegmentId: scope.runtimeSegmentId
      }
      const previousAdmission = latest.runtimeSessionAdmissions?.find(
        ({ executionId }) => executionId === scope.executionId
      )
      if (
        previousAdmission &&
        Object.entries(durableAdmission).some(
          ([key, value]) => previousAdmission[key as keyof typeof durableAdmission] !== value
        )
      )
        throw new Error('Runtime Session execution conflicts with its durable admission.')
      const next: PersistedChatSession = {
        ...latest,
        ...(resumedRun ? { activeRun: resumedRun, status: 'running' as const } : {}),
        ...runtimeBinding,
        runtimeSessionAdmissions: previousAdmission
          ? latest.runtimeSessionAdmissions
          : [...(latest.runtimeSessionAdmissions ?? []), durableAdmission],
        runtimeTranscriptReviewOwner: {
          promptMessageId: scope.promptMessageId,
          owner: reviewOwner
        },
        updatedAt: Math.max(latest.updatedAt, this.now())
      }
      if (next.resumeRecovery?.promptMessageId === scope.promptMessageId) {
        delete next.resumeRecovery
      }
      return next
    })
    this.turns.set(key, {
      scope: { ...scope },
      // Admission guarantees a run: the turn already owns one, or its continuation re-armed it.
      runStartedAt: session.activeRun!.startedAt,
      promptRuntimeSegmentId,
      pending: [],
      acceptedEventIds: new Set(),
      terminalEventIds: new Set(),
      tail: Promise.resolve(),
      terminalObserved: false,
      elicitationReceipts: new Map(
        (session.conversationGraph?.activities ?? [])
          .filter(
            (activity) =>
              activity.promptMessageId === scope.promptMessageId &&
              activity.elicitation?.continuationPending
          )
          .map((activity) => [activity.id, activity.elicitation?.respondedAt])
      ),
      replayConsumptionPending: false
    })
    this.trimTurns()
    return session
  }

  async preparePermissionTranscript(
    request: AcpPermissionRequest,
    promptMessageId: string
  ): Promise<PersistedChatSession | undefined> {
    const key = turnKey(request.sessionId, promptMessageId)
    const turn = this.turns.get(key)
    const flushed = await this.flush(request.sessionId, promptMessageId)
    if (request.isMcp !== true) return flushed
    if (!turn) throw new Error('Permission request has no registered Runtime Session execution.')
    // The ACP permission RPC contains the actual tool call. Its preceding notification can still
    // be suspended behind provider-acceptance persistence, so flushing that lane alone is not proof.
    const committed = await this.dependencies.mutateSession(turn.scope, (latest) => {
      assertScopeMatchesSession(turn.scope, latest, true, turn.promptRuntimeSegmentId)
      const graph = latest.conversationGraph!
      const frame = graph.frames.find(({ id }) => id === turn.scope.agentFrameId)
      if (
        this.turns.get(key) !== turn ||
        turn.terminalObserved ||
        latest.activeRun?.startedAt !== turn.runStartedAt ||
        graph.activeFrameId !== turn.scope.agentFrameId ||
        frame?.activeBranchId !== turn.scope.messageBranchId
      )
        throw new Error('Permission request belongs to a superseded Runtime Session execution.')
      const existing = graph.activities.find(({ id }) => id === request.toolCallId)
      if (existing) {
        if (
          existing.promptMessageId !== promptMessageId ||
          existing.agentFrameId !== turn.scope.agentFrameId ||
          existing.messageBranchId !== turn.scope.messageBranchId ||
          existing.runtimeSegmentId !== turn.scope.runtimeSegmentId ||
          (existing.status !== 'pending' && existing.status !== 'in_progress')
        )
          throw new Error('Permission tool call conflicts with its durable activity identity.')
        return latest
      }
      if (request.status && request.status !== 'pending' && request.status !== 'in_progress')
        throw new Error('Permission request cannot reopen a terminal tool call.')
      return applyRuntimeSessionEvents(latest, turn.scope, [
        {
          id: `permission-tool:${request.requestId}`,
          kind: 'tool',
          level: 'info',
          timestamp: Math.max(this.now(), turn.runStartedAt),
          sessionId: request.sessionId,
          promptMessageId,
          toolCallId: request.toolCallId,
          title: request.title,
          providerToolName: request.providerToolName ?? request.mcpIdentity,
          toolKind: request.toolKind,
          toolLocations: request.toolLocations,
          rawInput: request.rawInput,
          status: request.status ?? 'in_progress'
        }
      ])
    })
    this.notifyCommitted(committed)
    return committed
  }

  async consumeReplay(
    sessionId: string,
    promptMessageId: string
  ): Promise<PersistedChatSession | undefined> {
    const turn = this.turns.get(turnKey(sessionId, promptMessageId))
    if (!turn) return undefined
    turn.replayConsumptionPending = true
    return this.flush(sessionId, promptMessageId)
  }

  accept(event: AcpRuntimeEvent): void {
    if (!event.sessionId || !event.promptMessageId || event.publicationOwner === 'main') return
    // Thought chunks are private reasoning and are intentionally excluded from the durable
    // transcript projection. Do not queue them for the runtime-session flush loop: a long turn can
    // otherwise keep cloning and scheduling persistence batches for data that is discarded anyway.
    if (event.kind === 'thought') return
    const turn = this.turns.get(turnKey(event.sessionId, event.promptMessageId))
    if (
      !turn ||
      event.timestamp < turn.runStartedAt ||
      turn.acceptedEventIds.has(event.id) ||
      turn.terminalEventIds.has(event.id)
    )
      return
    turn.acceptedEventIds.add(event.id)
    turn.pending.push(structuredClone(event))
    if (event.kind === 'stop' || event.kind === 'error') {
      turn.terminalObserved = true
      // Terminal events are committed before being republished to renderer observers. Retain their
      // identities for this bounded turn lifetime so the publication callback cannot requeue the
      // same terminal after a successful flush has released streaming-event deduplication state.
      turn.terminalEventIds.add(event.id)
    }
    if (!turn.cancelScheduledFlush) {
      const schedule = this.dependencies.scheduleFlush ?? defaultScheduleFlush
      turn.cancelScheduledFlush = schedule(() => {
        turn.cancelScheduledFlush = undefined
        void this.flush(turn.scope.sessionId, turn.scope.promptMessageId).catch(() => undefined)
      }, this.dependencies.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
    }
  }

  flush(sessionId: string, promptMessageId: string): Promise<PersistedChatSession | undefined> {
    const turn = this.turns.get(turnKey(sessionId, promptMessageId))
    if (!turn) return Promise.resolve(undefined)
    turn.cancelScheduledFlush?.()
    turn.cancelScheduledFlush = undefined
    const operation = turn.tail.then(() => this.flushTurn(turn))
    turn.tail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async flushTurn(turn: Turn): Promise<PersistedChatSession | undefined> {
    let committed: PersistedChatSession | undefined
    while (turn.pending.length > 0 || turn.replayConsumptionPending) {
      const batch = turn.pending.slice()
      const consumeReplay = turn.replayConsumptionPending
      committed = await this.dependencies.mutateSession(turn.scope, (latest) => {
        assertScopeMatchesSession(turn.scope, latest, false, turn.promptRuntimeSegmentId)
        const next = applyRuntimeSessionEvents(latest, turn.scope, batch)
        if (consumeReplay) {
          delete next.pendingHistoryReplay
          delete next.branchContextResetRequired
          // Only decisions from before this Attempt were delivered by its prompt. A new question
          // answered during this Attempt belongs to a later continuation and keeps its receipt.
          const settle = <T extends NonNullable<PersistedChatSession['activities']>[number]>(
            activity: T
          ): T => {
            if (
              !activity.elicitation?.continuationPending ||
              !turn.elicitationReceipts.has(activity.id) ||
              turn.elicitationReceipts.get(activity.id) !== activity.elicitation.respondedAt
            )
              return activity
            const { continuationPending: _pending, ...elicitation } = activity.elicitation
            void _pending
            return { ...activity, elicitation }
          }
          if (next.conversationGraph) {
            next.conversationGraph = {
              ...next.conversationGraph,
              activities: next.conversationGraph.activities.map(settle)
            }
            // Flat activities intentionally omit turn identity. Derive them from the settled
            // graph so the persisted receipt and renderer projection cannot disagree.
            next.activities = resolveActiveConversationActivities(next.conversationGraph).activities
          }
          next.updatedAt = Math.max(next.updatedAt, this.now())
        }
        return next
      })
      turn.pending = turn.pending.slice(batch.length)
      if (consumeReplay) turn.replayConsumptionPending = false
      this.notifyCommitted(committed)
    }
    // Durable Message eventIds now own replay deduplication for flushed events. Keep only IDs that
    // arrived during the last mutation so an active streaming turn does not retain one Set entry
    // for every token/event.
    turn.acceptedEventIds = new Set(turn.pending.map(({ id }) => id))
    return committed
  }

  async publish(
    publication: RuntimeSessionArtifactPublication,
    event: { eventId?: string; timestamp?: number } = {}
  ): Promise<RuntimeSessionArtifactPublicationReceipt> {
    const turn = this.turns.get(turnKey(publication.appSessionId, publication.promptMessageId))
    if (!turn) throw new Error('Artifact publication has no registered Runtime Session turn.')
    if (publication.executionId !== turn.scope.executionId) {
      throw new Error('Artifact publication belongs to a superseded Runtime Session execution.')
    }
    const key = `${turnKey(publication.appSessionId, publication.promptMessageId)}:${publication.artifactClaimId}`
    let attempt = this.publications.get(key)
    if (attempt) {
      if (
        attempt.scope.executionId !== publication.executionId ||
        attempt.publication.runId !== publication.runId ||
        !sameArtifactDescriptorSet(attempt.publication.artifacts, publication.artifacts)
      ) {
        throw new Error('Artifact claim identity was reused with different publication facts.')
      }
    } else {
      attempt = {
        key,
        scope: turn.scope,
        eventId: event.eventId ?? `artifact:${publication.artifactClaimId}`,
        timestamp: event.timestamp ?? this.now(),
        publication: { ...publication, artifacts: [...publication.artifacts] }
      }
      this.publications.set(key, attempt)
      this.trimPublications()
    }
    if (attempt.receipt) return attempt.receipt
    if (!attempt.tail) {
      attempt.tail = this.publishAttempt(turn, attempt).finally(() => {
        attempt!.tail = undefined
      })
    }
    return attempt.tail
  }

  private async publishAttempt(
    turn: Turn,
    attempt: PublicationAttempt
  ): Promise<RuntimeSessionArtifactPublicationReceipt> {
    await this.flush(turn.scope.sessionId, turn.scope.promptMessageId)

    if (!attempt.messageId) {
      let stagedMessageId: string | undefined
      const staged = await this.dependencies.mutateSession(turn.scope, (latest) => {
        assertScopeMatchesSession(turn.scope, latest, false, turn.promptRuntimeSegmentId)
        const attached = attachRuntimeSessionArtifacts(latest, turn.scope, {
          // This durable marker proves which claim was attached before irreversible finalization.
          // The actual runtime event id is attached with the finalized descriptors below.
          eventId: `artifact-claim:${attempt.publication.artifactClaimId}`,
          runId: attempt.publication.runId,
          artifacts: attempt.publication.artifacts,
          timestamp: attempt.timestamp
        })
        stagedMessageId = attached.messageId
        return attached.session
      })
      if (!stagedMessageId)
        throw new Error('Artifact publication did not resolve an owner Message.')
      attempt.messageId = stagedMessageId
      this.notifyCommitted(staged)
    }

    if (!attempt.finalizedArtifacts) {
      attempt.finalizedArtifacts = await this.dependencies.finalizeArtifacts({
        claimId: attempt.publication.artifactClaimId,
        messageId: attempt.messageId
      })
    }

    const committedIdentity = {
      projectId: turn.scope.projectId,
      sessionId: turn.scope.sessionId,
      promptMessageId: turn.scope.promptMessageId,
      artifactClaimId: attempt.publication.artifactClaimId,
      runId: attempt.publication.runId,
      messageId: attempt.messageId,
      artifacts: [...attempt.finalizedArtifacts]
    }
    try {
      const session = await this.dependencies.mutateSession(turn.scope, (latest) => {
        assertScopeMatchesSession(turn.scope, latest, false, turn.promptRuntimeSegmentId)
        return attachRuntimeSessionArtifacts(latest, turn.scope, {
          messageId: attempt.messageId,
          eventId: attempt.eventId,
          runId: attempt.publication.runId,
          artifacts: attempt.finalizedArtifacts!,
          timestamp: attempt.timestamp
        }).session
      })
      const receipt = committedIdentity
      attempt.receipt = receipt
      this.trimPublications()
      this.notifyCommitted(session)
      return receipt
    } catch (cause) {
      throw new RuntimeSessionArtifactPublicationError(
        unconfirmedAttachmentMessage(committedIdentity),
        committedIdentity,
        { cause }
      )
    }
  }

  private notifyCommitted(session: PersistedChatSession): void {
    try {
      this.dependencies.onCommitted?.(session)
    } catch {
      // Notification is observational and cannot erase a durable commit.
    }
  }

  private trimTurns(): void {
    if (this.turns.size <= MAX_RETAINED_TURNS) return
    for (const [key, turn] of this.turns) {
      if (!turn.terminalObserved || turn.pending.length > 0) continue
      this.turns.delete(key)
      if (this.turns.size <= MAX_RETAINED_TURNS) return
    }
  }

  private trimPublications(): void {
    if (this.publications.size <= MAX_RETAINED_PUBLICATIONS) return
    for (const [key, attempt] of this.publications) {
      if (!attempt.receipt) continue
      this.publications.delete(key)
      if (this.publications.size <= MAX_RETAINED_PUBLICATIONS) return
    }
  }
}
