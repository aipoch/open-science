import type { ArtifactFile } from '../../shared/artifacts'
import type {
  DelegatedArtifactEvidence,
  DelegatedArtifactProjectionScope,
  DelegatedReviewEvidence,
  DelegatedWorkDurableRecords,
  DurableDelegateResult,
  DurableDelegateObservation,
  DurableSnapshot,
  ReadOnlyAgentFrameDetail
} from './durable-delegated-work'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import { associateStructuredOutputEvidence } from './structured-output'

type DurableChild = DurableSnapshot['records'][number]
type DurableAttempt = DurableChild['attempts'][number]

class DelegatedWorkProjectionOwner {
  constructor(
    private readonly records: DelegatedWorkDurableRecords,
    private readonly artifactEvidence?: DelegatedArtifactEvidence,
    private readonly reviewEvidence?: DelegatedReviewEvidence
  ) {}

  attemptScope(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt
  ): DelegatedArtifactProjectionScope | undefined {
    const runtimeSegmentId = attempt.runtimeSegmentIds.at(-1)
    const terminalMessage = attempt.terminalMessageId
      ? snapshot.messages.find((message) => message.id === attempt.terminalMessageId)
      : undefined
    const promptMessages = snapshot.messages.filter(
      (message) => message.frameId === child.frameId && message.role === 'user'
    )
    const runtimePrompt = promptMessages.find(
      (message) =>
        !!message.runtimeSegmentId && attempt.runtimeSegmentIds.includes(message.runtimeSegmentId)
    )
    const promptMessageId = terminalMessage?.responseToMessageId ?? runtimePrompt?.id
    if (!runtimeSegmentId || !promptMessageId) return undefined
    return {
      session: snapshot.session,
      executionId: attempt.id,
      attemptId: attempt.id,
      rootFrameId: snapshot.rootFrameId,
      agentFrameId: child.frameId,
      messageBranchId: child.messageBranchId,
      runtimeSegmentId,
      promptMessageId,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      runtimeSegmentIds: [...attempt.runtimeSegmentIds],
      ...(attempt.terminalMessageId ? { terminalMessageId: attempt.terminalMessageId } : {})
    }
  }

  private messageScope(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt,
    message: DurableSnapshot['messages'][number]
  ): DelegatedArtifactProjectionScope | undefined {
    if (!message.runtimeSegmentId || !message.responseToMessageId) return undefined
    return {
      session: snapshot.session,
      executionId: attempt.id,
      attemptId: attempt.id,
      rootFrameId: snapshot.rootFrameId,
      agentFrameId: child.frameId,
      messageBranchId: child.messageBranchId,
      runtimeSegmentId: message.runtimeSegmentId,
      promptMessageId: message.responseToMessageId,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      runtimeSegmentIds: [message.runtimeSegmentId],
      terminalMessageId: message.id
    }
  }

  async projectSnapshotResult(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt = currentAttempt(child)
  ): Promise<DurableDelegateResult | undefined> {
    if (attempt.status === 'running') return undefined
    const terminalMessage = attempt.terminalMessageId
      ? snapshot.messages.find((message) => message.id === attempt.terminalMessageId)
      : undefined
    const structuredEvidence = associateStructuredOutputEvidence(
      snapshot.messages,
      child.frameId,
      attempt.id
    )
    return {
      frameId: child.frameId,
      attemptId: attempt.id,
      name: child.title,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      status: attempt.status,
      ...(attempt.terminalMessageId ? { terminalMessageId: attempt.terminalMessageId } : {}),
      ...(terminalMessage ? { response: terminalMessage.content } : {}),
      artifactsCreated: await this.projectArtifacts(snapshot, child, attempt),
      ...(attempt.cancellationReason ? { cancellationReason: attempt.cancellationReason } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
      ...(structuredEvidence
        ? structuredEvidence.accepted
          ? {
              structuredOutput: structuredClone(structuredEvidence.accepted.value),
              structuredOutputUnsatisfied: false
            }
          : { structuredOutputUnsatisfied: true }
        : {})
    }
  }

  isAwaitingUser(snapshot: DurableSnapshot, child: DurableChild, attempt: DurableAttempt): boolean {
    return snapshot.questionRequests.some(
      (request) =>
        request.sourceFrameId === child.frameId &&
        request.sourceAttemptId === attempt.id &&
        request.status === 'pending'
    )
  }

  async projectSnapshotObservation(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt
  ): Promise<DurableDelegateObservation> {
    const awaitingUser = this.isAwaitingUser(snapshot, child, attempt)
    if (!awaitingUser) {
      const terminal = await this.projectSnapshotResult(snapshot, child, attempt)
      if (terminal) return terminal
    }
    return {
      frameId: child.frameId,
      attemptId: attempt.id,
      name: child.title,
      agentName:
        attempt.resolvedAgent.kind === 'specialist'
          ? attempt.resolvedAgent.displayName
          : 'Main Agent',
      status: awaitingUser ? 'awaiting_user' : 'running'
    }
  }

  async projectResult(frameId: string): Promise<DurableDelegateResult | undefined> {
    const snapshot = await this.records.snapshot()
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    return child ? this.projectSnapshotResult(snapshot, child) : undefined
  }

  async readAgentFrame(
    session: DurableSnapshot['session'],
    frameId: string
  ): Promise<ReadOnlyAgentFrameDetail | undefined> {
    const snapshot = await this.records.snapshot()
    if (!sameSession(snapshot.session, session)) return undefined
    const child = snapshot.records.find((candidate) => candidate.frameId === frameId)
    if (!child) return undefined
    const attempt = currentAttempt(child)
    const messages = await Promise.all(
      snapshot.messages
        .filter((message) => message.frameId === frameId)
        .map(async (message) => {
          const { role, content } = message
          const owningAttempt = child.attempts.find(
            (candidate) =>
              candidate.terminalMessageId === message.id ||
              (message.runtimeSegmentId
                ? candidate.runtimeSegmentIds.includes(message.runtimeSegmentId)
                : false)
          )
          const artifacts = owningAttempt
            ? await this.projectMessageArtifacts(snapshot, child, owningAttempt, message)
            : []
          const reviews =
            owningAttempt?.status === 'completed' && owningAttempt.terminalMessageId
              ? await this.reviewEvidence?.project({
                  session: snapshot.session,
                  attemptId: owningAttempt.id,
                  agentFrameId: child.frameId,
                  messageBranchId: child.messageBranchId,
                  terminalMessageId: owningAttempt.terminalMessageId,
                  artifactVersionIds: artifacts.flatMap((artifact) =>
                    artifact.versionId ? [artifact.versionId] : []
                  )
                })
              : undefined
          return Object.freeze({
            role,
            content,
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(reviews && reviews.length > 0 ? { reviews } : {})
          })
        })
    )
    return Object.freeze({
      frameId,
      title: child.title,
      status: attempt.status,
      resolvedAgent: Object.freeze(structuredClone(attempt.resolvedAgent)),
      messages: Object.freeze(messages)
    })
  }

  private async projectArtifacts(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt
  ): Promise<readonly ArtifactFile[]> {
    const scope = this.attemptScope(snapshot, child, attempt)
    return scope && this.artifactEvidence ? this.artifactEvidence.project(scope) : []
  }

  private async projectMessageArtifacts(
    snapshot: DurableSnapshot,
    child: DurableChild,
    attempt: DurableAttempt,
    message: DurableSnapshot['messages'][number]
  ): Promise<readonly ArtifactFile[]> {
    const scope = this.messageScope(snapshot, child, attempt, message)
    if (scope && this.artifactEvidence) return this.artifactEvidence.project(scope)
    return message.id === attempt.terminalMessageId
      ? this.projectArtifacts(snapshot, child, attempt)
      : []
  }
}

export { DelegatedWorkProjectionOwner }
