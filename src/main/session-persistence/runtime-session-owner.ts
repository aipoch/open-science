import type { AcpRuntimeEvent } from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import { isClaudeApiResponseInterruption } from '../../shared/run-error-classification'
import {
  applyRuntimeSessionEvents,
  attachRuntimeSessionArtifacts,
  type RuntimeSessionScope
} from '../../shared/runtime-session-projection'

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
  pending: AcpRuntimeEvent[]
  acceptedEventIds: Set<string>
  terminalEventIds: Set<string>
  tail: Promise<void>
  cancelScheduledFlush?: () => void
  terminalObserved: boolean
  replayConsumptionPending: boolean
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
  requireActiveRun = false
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
    prompt.runtimeSegmentId !== segment.id
  ) {
    throw new Error('Runtime Session turn has no durable prompt path.')
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
    const loaded = await this.dependencies.loadSession(scope)
    if (!loaded) throw new Error('Runtime Session turn is not durable.')
    assertScopeMatchesSession(scope, loaded, true)

    const key = turnKey(scope.sessionId, scope.promptMessageId)
    const existing = this.turns.get(key)
    if (existing) {
      if (existing.scope.executionId !== scope.executionId) {
        const nextRunStartedAt = loaded.activeRun?.startedAt
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
      assertScopeMatchesSession(scope, latest, true)
      const { reviewOwner = 'renderer', ...runtimeBinding } = admission
      const next: PersistedChatSession = {
        ...latest,
        ...runtimeBinding,
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
      runStartedAt: loaded.activeRun!.startedAt,
      pending: [],
      acceptedEventIds: new Set(),
      terminalEventIds: new Set(),
      tail: Promise.resolve(),
      terminalObserved: false,
      replayConsumptionPending: false
    })
    this.trimTurns()
    return session
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
    // These errors hand ownership to a recovery flow. Persisting them as terminal here would clear
    // activeRun before compaction/Resume can continue the same logical turn.
    if (
      event.kind === 'error' &&
      (event.recoverable === 'context-overflow' || isClaudeApiResponseInterruption(event.text))
    ) {
      return
    }
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
        assertScopeMatchesSession(turn.scope, latest)
        const next = applyRuntimeSessionEvents(latest, turn.scope, batch)
        if (consumeReplay) {
          delete next.pendingHistoryReplay
          delete next.branchContextResetRequired
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
        assertScopeMatchesSession(turn.scope, latest)
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
        assertScopeMatchesSession(turn.scope, latest)
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
