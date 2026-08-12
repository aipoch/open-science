import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkRecord
} from '../../shared/session-persistence'
import type {
  AdmitQuestionInput,
  ConfirmQuestionInput,
  CreatedChild,
  SessionKey,
  UpdateQuestionDraftInput
} from '../delegation/session-records'
import { DelegatedWorkAttemptConflictError } from './message-delivery-owner'
import { SessionDelegatedWorkStore } from './delegated-work-store'

const currentAttempt = (record: DelegatedWorkRecord): DelegatedWorkAttemptRecord => {
  const attempt = record.attempts.at(-1)
  if (!attempt) throw new Error(`Delegate Frame ${record.agentFrameId} has no Attempt.`)
  return attempt
}

// Owns pending-question admission, draft, confirmation, and cancellation policy while the shared
// store commits each transition atomically with the delegated graph and Attempt records.
class SessionDelegatedQuestionPersistenceOwner {
  constructor(private readonly store: SessionDelegatedWorkStore) {}

  admitQuestion(key: SessionKey, input: AdmitQuestionInput): Promise<'admitted' | 'idempotent'> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (graph, records, _session, _commands, _messagesQuarantined, questions, quarantined) => {
        if (quarantined) throw new Error('Delegated question owner is quarantined.')
        const existing = questions.find(
          (candidate) => candidate.requestId === input.request.requestId
        )
        if (existing) {
          if (existing.canonicalDigest !== input.request.canonicalDigest) {
            throw new Error('Delegated question request identity conflicts with another payload.')
          }
          return 'idempotent'
        }
        const frame = graph.frames.find(
          (candidate) =>
            candidate.id === input.request.sourceFrameId && candidate.kind === 'delegate'
        )
        const record = records.find(
          (candidate) => candidate.agentFrameId === input.request.sourceFrameId
        )
        const attempt = record && currentAttempt(record)
        const rootFrame = graph.frames.find((candidate) => candidate.id === graph.rootFrameId)
        const rootPath = resolveActiveConversationMessages({
          ...graph,
          activeFrameId: graph.rootFrameId
        })
        if (
          !frame ||
          frame.parentFrameId !== graph.rootFrameId ||
          frame.originBindingState !== 'validated' ||
          frame.originMessageId !== input.request.rootOriginMessageId ||
          frame.activeBranchId !== input.request.sourceMessageBranchId ||
          rootFrame?.activeBranchId !== input.request.rootBranchId ||
          !rootPath.some((message) => message.id === input.request.rootOriginMessageId) ||
          !attempt ||
          attempt.id !== input.request.sourceAttemptId ||
          attempt.status !== 'running' ||
          !attempt.runtimeSegmentIds.includes(input.request.sourceRuntimeSegmentId)
        ) {
          throw new Error('Delegated question source is outside the active direct-child route.')
        }
        const sequence =
          questions.reduce((maximum, candidate) => Math.max(maximum, candidate.sequence ?? 0), 0) +
          1
        questions.push(structuredClone({ ...input.request, sequence }))
        return 'admitted'
      },
      { rejectNewQuestionQuarantine: true }
    )
  }

  updateQuestionDraft(key: SessionKey, input: UpdateQuestionDraftInput): Promise<void> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (graph, _records, _session, _commands, _messagesQuarantined, questions, quarantined) => {
        if (quarantined) throw new Error('Delegated question owner is quarantined.')
        const index = questions.findIndex((request) => request.requestId === input.requestId)
        const request = questions[index]
        const rootFrame = graph.frames.find((candidate) => candidate.id === graph.rootFrameId)
        const rootPath = resolveActiveConversationMessages({
          ...graph,
          activeFrameId: graph.rootFrameId
        })
        if (!request || request.status !== 'pending') {
          throw new Error('Delegated question is no longer pending.')
        }
        if (
          rootFrame?.activeBranchId !== request.rootBranchId ||
          !rootPath.some((message) => message.id === request.rootOriginMessageId)
        ) {
          throw new Error('Delegated question branch is inactive.')
        }
        questions[index] = {
          ...request,
          draftAnswers: structuredClone(input.draftAnswers),
          draftQuestionIndex: input.questionIndex
        }
      }
    )
  }

  confirmQuestion(key: SessionKey, input: ConfirmQuestionInput): Promise<CreatedChild> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (graph, records, _session, _commands, _messagesQuarantined, questions, quarantined) => {
        if (quarantined) throw new Error('Delegated question owner is quarantined.')
        const questionIndex = questions.findIndex(
          (request) => request.requestId === input.requestId
        )
        const request = questions[questionIndex]
        const record = records.find((candidate) => candidate.agentFrameId === input.frameId)
        const previous = record && currentAttempt(record)
        const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
        const rootFrame = graph.frames.find((candidate) => candidate.id === graph.rootFrameId)
        const rootPath = resolveActiveConversationMessages({
          ...graph,
          activeFrameId: graph.rootFrameId
        })
        if (
          !request ||
          request.status !== 'pending' ||
          request.sourceFrameId !== input.frameId ||
          !record ||
          !previous ||
          previous.id !== input.previousAttemptId ||
          previous.status === 'running' ||
          !frame ||
          rootFrame?.activeBranchId !== request.rootBranchId ||
          !rootPath.some((message) => message.id === request.rootOriginMessageId) ||
          input.initiatingTurnMessageId !== request.rootOriginMessageId
        ) {
          throw new DelegatedWorkAttemptConflictError()
        }
        if (
          records.some((candidate) =>
            candidate.attempts.some((attempt) => attempt.id === input.attemptId)
          ) ||
          graph.messages.some((message) => message.id === input.messageId)
        ) {
          throw new Error('Question continuation contains a duplicate durable identity.')
        }
        const branch = graph.branches.find((candidate) => candidate.id === frame.activeBranchId)
        if (!branch) throw new Error(`Delegate Branch not found: ${frame.activeBranchId}`)
        graph.messages.push({
          id: input.messageId,
          role: 'user',
          content: input.message,
          status: 'complete',
          eventIds: [],
          agentFrameId: input.frameId,
          introducedOnBranchId: branch.id,
          ...(branch.headMessageId ? { parentMessageId: branch.headMessageId } : {}),
          revisionRootMessageId: input.messageId,
          createdAt: input.startedAt,
          updatedAt: input.startedAt
        })
        branch.headMessageId = input.messageId
        branch.updatedAt = input.startedAt
        ;(record.attempts as DelegatedWorkAttemptRecord[]).push({
          id: input.attemptId,
          initiatingTurnMessageId: input.initiatingTurnMessageId,
          status: 'running',
          resolvedAgent: input.resolvedAgent,
          executionModel: input.executionModel,
          runtimeSegmentIds: [],
          startedAt: input.startedAt
        })
        frame.status = 'running'
        delete frame.completedAt
        questions[questionIndex] = {
          ...request,
          status: 'confirmed',
          draftAnswers: structuredClone(input.answers),
          answers: structuredClone(input.answers),
          respondedAt: input.startedAt,
          continuationAttemptId: input.attemptId
        }
        return { frameId: input.frameId, attemptId: input.attemptId, status: 'running' }
      }
    )
  }

  cancelQuestions(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; frameId: string; endedAt: number; reason: string }>
  ): Promise<void> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (_graph, _records, _session, _commands, _messagesQuarantined, questions, quarantined) => {
        if (quarantined) throw new Error('Delegated question owner is quarantined.')
        for (const [index, request] of questions.entries()) {
          if (request.sourceFrameId !== input.frameId || request.status !== 'pending') continue
          questions[index] = {
            ...request,
            status: 'cancelled',
            respondedAt: input.endedAt,
            failure: { code: 'cancelled', message: input.reason }
          }
        }
      }
    )
  }
}

export { SessionDelegatedQuestionPersistenceOwner }
