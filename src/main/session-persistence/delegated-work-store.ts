import type { PersistedConversationGraph } from '../../shared/conversation-graph'
import { artifactCreatedAtMs } from '../../shared/artifacts'
import {
  materializeSessionConversationGraph,
  sanitizeSessionRuntimeContext
} from '../../shared/session-persistence'
import type {
  LoadAllSessionsResult,
  PersistedArtifact,
  PersistedChatSession,
  SessionLoadFailure,
  SessionLoadWarning,
  SessionRuntimeContext,
  DelegatedWorkAttemptRecord,
  DelegatedWorkRecord,
  DelegatedMessageCommand,
  DelegatedQuestionRequest
} from '../../shared/session-persistence'
import type {
  AttachDelegatedMessageArtifactsInput,
  ChildRecord,
  SessionKey
} from '../delegation/session-records'
import { saveSessionWithRevision } from './save-session'
import { loadSessionMutationAuthority } from './repository'
import { SessionRuntimeContextRevisionConflictError } from './state-owner'

type DelegatedWorkSessionRepository = {
  loadAllWithDiagnostics(options?: { mode?: 'repair' | 'read-only' }): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
    warnings?: SessionLoadWarning[]
    failure?: SessionLoadFailure
  }>
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  saveSession(session: PersistedChatSession): Promise<PersistedChatSession | void>
}

type SessionDelegatedWorkStoreOptions = {
  repository: DelegatedWorkSessionRepository
  runExclusive: <Result>(
    key: SessionKey | undefined,
    work: () => Promise<Result>
  ) => Promise<Result>
  assertMutable: (projectId: string, sessionId: string) => void
  markStartupRecoveryComplete: () => void
  notifySessionUpdated: (session: PersistedChatSession) => void
}

const emptySessionRuntimeContext = (): SessionRuntimeContext => ({ version: 1, revision: 0 })

const delegatedRecords = (context: SessionRuntimeContext): DelegatedWorkRecord[] =>
  structuredClone(context.delegatedWork?.records ?? []) as DelegatedWorkRecord[]

const currentAttempt = (record: DelegatedWorkRecord): DelegatedWorkAttemptRecord => {
  const attempt = record.attempts.at(-1)
  if (!attempt) throw new Error(`Delegate Frame ${record.agentFrameId} has no Attempt.`)
  return attempt
}

const withDelegatedWorkRecords = (
  context: SessionRuntimeContext,
  records: readonly DelegatedWorkRecord[]
): NonNullable<SessionRuntimeContext['delegatedWork']> => ({
  ...context.delegatedWork,
  records
})

const recoverInterruptedDelegatedWorkSession = (
  session: PersistedChatSession,
  endedAt = Math.max(session.updatedAt + 1, Date.now())
): {
  session: PersistedChatSession
  interrupted: readonly { frameId: string; attemptId: string }[]
} => {
  const current = session.runtimeContext
  if (!current?.delegatedWork) return { session, interrupted: [] }
  const records = delegatedRecords(current)
  const running = records.filter((record) => currentAttempt(record).status === 'running')
  if (running.length === 0) return { session, interrupted: [] }
  const materialized = materializeSessionConversationGraph(session)
  const graph = structuredClone(materialized.conversationGraph)
  if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
  const interrupted: Array<{ frameId: string; attemptId: string }> = []
  for (const record of running) {
    const attempt = currentAttempt(record)
    const attempts = record.attempts as DelegatedWorkAttemptRecord[]
    attempts[attempts.length - 1] = {
      ...attempt,
      status: 'cancelled',
      endedAt,
      cancellationReason: 'runtime_interrupted'
    }
    const frame = graph.frames.find((candidate) => candidate.id === record.agentFrameId)
    if (!frame) throw new Error(`Delegate Frame not found: ${record.agentFrameId}`)
    frame.status = 'cancelled'
    frame.completedAt = endedAt
    for (const segmentId of attempt.runtimeSegmentIds) {
      const segment = graph.runtimeSegments.find((candidate) => candidate.id === segmentId)
      if (segment && segment.endedAt === undefined) segment.endedAt = endedAt
    }
    interrupted.push({ frameId: record.agentFrameId, attemptId: attempt.id })
  }
  const runtimeContext = sanitizeSessionRuntimeContext({
    ...current,
    revision: current.revision + 1,
    delegatedWork: withDelegatedWorkRecords(current, records)
  })
  if (!runtimeContext) throw new Error('Delegated Work recovery produced invalid state.')
  return {
    session: { ...materialized, conversationGraph: graph, runtimeContext, updatedAt: endedAt },
    interrupted
  }
}

const persistedArtifactsEqual = (left: PersistedArtifact, right: PersistedArtifact): boolean =>
  Object.entries(right).every(([field, value]) => left[field as keyof PersistedArtifact] === value)

const appendUnique = (existing: string[] | undefined, incoming: readonly string[]): string[] => {
  const result = [...(existing ?? [])]
  const seen = new Set(result)
  for (const value of incoming) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

// Serializes the durable graph, record, message-command, and question-request generations as one CAS
// mutation. Higher-level owners supply policy while this adapter owns storage and recovery mechanics.
class SessionDelegatedWorkStore {
  constructor(private readonly options: SessionDelegatedWorkStoreOptions) {}

  private async loadRuntimeContextSession(
    projectId: string,
    sessionId: string,
    operation: 'read' | 'patch'
  ): Promise<PersistedChatSession> {
    const loaded = await loadSessionMutationAuthority(this.options.repository, projectId, sessionId)
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

  mutate<Result>(
    key: SessionKey,
    expectedRevision: number,
    mutate: (
      graph: PersistedConversationGraph,
      records: DelegatedWorkRecord[],
      session: PersistedChatSession,
      messageCommands: DelegatedMessageCommand[],
      messageCommandsQuarantined: boolean,
      questionRequests: DelegatedQuestionRequest[],
      questionRequestsQuarantined: boolean
    ) => Result,
    options: Readonly<{ rejectNewQuestionQuarantine?: boolean }> = {}
  ): Promise<Result> {
    return this.options.runExclusive(key, async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Session runtime context expected revision must be a non-negative integer.')
      }
      this.options.assertMutable(key.projectId, key.sessionId)
      const session = await this.loadRuntimeContextSession(key.projectId, key.sessionId, 'patch')
      const current = session.runtimeContext ?? emptySessionRuntimeContext()
      if (current.revision !== expectedRevision) {
        throw new SessionRuntimeContextRevisionConflictError(expectedRevision, current.revision)
      }
      const materialized = materializeSessionConversationGraph(session)
      const graph = structuredClone(materialized.conversationGraph)
      if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
      const records = delegatedRecords(current)
      const messageCommands = Array.from(
        structuredClone(current.delegatedWork?.messageCommands ?? [])
      )
      const messageCommandsQuarantined =
        current.delegatedWork?.messageCommandsQuarantine !== undefined
      const questionRequests = Array.from(
        structuredClone(current.delegatedWork?.questionRequests ?? [])
      )
      const questionRequestsQuarantined =
        current.delegatedWork?.questionRequestsQuarantine !== undefined
      const result = mutate(
        graph,
        records,
        materialized,
        messageCommands,
        messageCommandsQuarantined,
        questionRequests,
        questionRequestsQuarantined
      )
      const runtimeContext = sanitizeSessionRuntimeContext({
        ...current,
        revision: current.revision + 1,
        delegatedWork: {
          ...withDelegatedWorkRecords(current, records),
          ...(messageCommandsQuarantined
            ? { messageCommandsQuarantine: current.delegatedWork?.messageCommandsQuarantine }
            : { messageCommands }),
          ...(questionRequestsQuarantined
            ? { questionRequestsQuarantine: current.delegatedWork?.questionRequestsQuarantine }
            : questionRequests.length > 0 || current.delegatedWork?.questionRequests !== undefined
              ? { questionRequests }
              : {})
        }
      })
      if (!runtimeContext) throw new Error('Delegated Work mutation produced invalid state.')
      if (
        options.rejectNewQuestionQuarantine &&
        !questionRequestsQuarantined &&
        runtimeContext.delegatedWork?.questionRequestsQuarantine !== undefined
      ) {
        throw new Error('Delegated Work mutation produced an invalid delegated question owner.')
      }
      const updatedAt = Math.max(session.updatedAt + 1, Date.now())
      const updated = {
        ...materialized,
        conversationGraph: graph,
        runtimeContext,
        updatedAt
      }
      const persisted = await saveSessionWithRevision(this.options.repository, updated)
      this.options.notifySessionUpdated(persisted)
      return result
    })
  }

  attachDelegatedMessageArtifacts(
    key: SessionKey,
    input: AttachDelegatedMessageArtifactsInput
  ): Promise<void> {
    return this.options.runExclusive(key, async () => {
      this.options.assertMutable(key.projectId, key.sessionId)
      const session = await this.loadRuntimeContextSession(key.projectId, key.sessionId, 'patch')
      const materialized = materializeSessionConversationGraph(session)
      const graph = structuredClone(materialized.conversationGraph)
      if (!graph) throw new Error('Session Conversation Graph could not be materialized.')
      const record = delegatedRecords(session.runtimeContext ?? emptySessionRuntimeContext()).find(
        ({ agentFrameId }) => agentFrameId === input.frameId
      )
      const attempt = record?.attempts.find(({ id }) => id === input.attemptId)
      if (!record || !attempt) throw new Error('Delegated Artifact owner Attempt is missing.')
      const owner = graph.messages.find(
        ({ id, agentFrameId, role, status }) =>
          id === input.messageId &&
          agentFrameId === input.frameId &&
          role === 'agent' &&
          status === 'complete'
      )
      if (
        !owner?.runtimeSegmentId ||
        !attempt.runtimeSegmentIds.includes(owner.runtimeSegmentId) ||
        input.artifacts.length === 0
      ) {
        throw new Error('Delegated Artifact owner is outside the completed Turn.')
      }
      const artifactIds = input.artifacts.map(({ versionId, id }) => versionId ?? id)
      const nextOwnerIds = appendUnique(owner.artifactIds, artifactIds)
      const nextArtifacts = [
        ...(materialized.artifacts ?? []).map((artifact) => structuredClone(artifact))
      ]
      const ownerCreatedAt = owner.completedAt ?? owner.createdAt
      const fallbackCreatedAt =
        Number.isFinite(ownerCreatedAt) && ownerCreatedAt >= 0 ? ownerCreatedAt : undefined
      let artifactsChanged = false
      for (const artifact of input.artifacts) {
        const createdAt = artifactCreatedAtMs(artifact.createdAt) ?? fallbackCreatedAt
        const persisted: PersistedArtifact = {
          id: artifact.versionId ?? artifact.id,
          ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
          ...(artifact.versionId ? { versionId: artifact.versionId } : {}),
          ...(artifact.versionNumber !== undefined
            ? { versionNumber: artifact.versionNumber }
            : {}),
          kind: 'managed-file',
          path: artifact.path,
          fileUrl: artifact.fileUrl,
          name: artifact.name,
          ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
          size: artifact.size,
          ...(createdAt === undefined ? {} : { createdAt }),
          mtimeMs: artifact.mtimeMs,
          ...(artifact.checksum ? { sha256: artifact.checksum } : {})
        }
        const index = nextArtifacts.findIndex(({ id }) => id === persisted.id)
        if (index < 0) {
          nextArtifacts.push(persisted)
          artifactsChanged = true
        } else if (!persistedArtifactsEqual(nextArtifacts[index], persisted)) {
          nextArtifacts[index] = persisted
          artifactsChanged = true
        }
      }
      const ownerChanged = nextOwnerIds.length !== (owner.artifactIds?.length ?? 0)
      if (!ownerChanged && !artifactsChanged) return
      owner.artifactIds = nextOwnerIds
      const updated = {
        ...materialized,
        conversationGraph: graph,
        artifacts: nextArtifacts,
        filesRevision: (materialized.filesRevision ?? 0) + 1,
        updatedAt: Math.max(materialized.updatedAt + 1, Date.now())
      }
      const persisted = await saveSessionWithRevision(this.options.repository, updated)
      this.options.notifySessionUpdated(persisted)
    })
  }

  readChildren(key: SessionKey, parentFrameId: string): Promise<readonly ChildRecord[]> {
    return this.options.runExclusive(key, async () => {
      const session = await this.loadRuntimeContextSession(key.projectId, key.sessionId, 'read')
      const materialized = materializeSessionConversationGraph(session)
      const graph = materialized.conversationGraph
      if (!graph) return []
      const records = delegatedRecords(session.runtimeContext ?? emptySessionRuntimeContext())
      return records.flatMap((record): ChildRecord[] => {
        const frame = graph.frames.find(
          (candidate) =>
            candidate.id === record.agentFrameId && candidate.parentFrameId === parentFrameId
        )
        if (!frame) return []
        const attempt = currentAttempt(record)
        return [
          {
            frameId: frame.id,
            parentFrameId,
            title: frame.delegateName ?? frame.agentName ?? frame.id,
            status: attempt.status,
            record: structuredClone(record)
          }
        ]
      })
    })
  }

  recoverInterruptedDelegatedWork(): Promise<readonly { frameId: string; attemptId: string }[]> {
    return this.options.runExclusive(undefined, async () => {
      const scan = await this.options.repository.loadAllWithDiagnostics({ mode: 'read-only' })
      if (!scan.isComplete) {
        throw new Error('Cannot recover Delegated Work from an incomplete Session catalog.')
      }
      const interrupted: Array<{ frameId: string; attemptId: string }> = []
      for (const session of scan.result.sessions) {
        const recovery = recoverInterruptedDelegatedWorkSession(session)
        if (recovery.interrupted.length === 0) continue
        const persisted = await saveSessionWithRevision(this.options.repository, recovery.session)
        this.options.notifySessionUpdated(persisted)
        interrupted.push(...recovery.interrupted)
      }
      this.options.markStartupRecoveryComplete()
      return interrupted
    })
  }
}

export {
  delegatedRecords,
  emptySessionRuntimeContext,
  recoverInterruptedDelegatedWorkSession,
  SessionDelegatedWorkStore
}
export type { SessionDelegatedWorkStoreOptions }
