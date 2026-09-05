import { createHash } from 'node:crypto'

import type { AgentUserChoiceRequest, AgentUserChoiceResult } from '../../shared/elicitation'
import type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type {
  DelegatedQuestionAnswer,
  DelegatedWorkDurableRecords,
  DurableChild,
  DurableDelegatedQuestionRequest,
  DurableResolvedAgent
} from './delegated-work-record-types'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { terminalizeUnsuccessfulAttempt } from './attempt-runtime-transcript'
import type { DelegateCapacityReservation } from './execution-port'
import type { SessionKey } from './session-records'

type UpdateQuestionDraftInput = Readonly<{
  requestId: string
  draftAnswers: readonly DelegatedQuestionAnswer[]
  questionIndex: number
}>

type ConfirmQuestionInput = Readonly<{
  requestId: string
  answers: readonly DelegatedQuestionAnswer[]
}>

type DelegatedUserQuestionOwnerOptions = Readonly<{
  records: DelegatedWorkDurableRecords
  now: () => number
  createId: (kind: 'attempt' | 'message' | 'question') => string
  admission: <Result>(operation: () => Promise<Result>) => Promise<Result>
  resolveAgent: (profileId: string) => Promise<DurableResolvedAgent>
  reserve: () => Promise<DelegateCapacityReservation>
  waitForAttemptCompletion: (frameId: string, attemptId: string) => Promise<void>
  launchContinuation: (input: {
    child: DurableChild
    session: SessionKey
    reservation: DelegateCapacityReservation
    message: string
  }) => void
}>

const assertQuestionAnswers = (
  request: DurableDelegatedQuestionRequest,
  answers: readonly DelegatedQuestionAnswer[]
): void => {
  if (
    answers.length !== request.questions.length ||
    new Set(answers.map((answer) => answer.questionIndex)).size !== answers.length ||
    answers.some(
      (answer) =>
        !Number.isSafeInteger(answer.questionIndex) ||
        answer.questionIndex < 0 ||
        answer.questionIndex >= request.questions.length ||
        typeof answer.value !== 'string' ||
        !answer.value.trim() ||
        answer.value.length > 4_000
    )
  ) {
    throw new DurableDelegatedWorkError(
      'admission_rejection',
      'delegated question confirmation requires one complete answer per question'
    )
  }
}

const questionContinuationMessage = (
  request: DurableDelegatedQuestionRequest,
  answers: readonly DelegatedQuestionAnswer[]
): string => {
  const byIndex = new Map(answers.map((answer) => [answer.questionIndex, answer.value.trim()]))
  return [
    'The user answered your delegated questions:',
    ...request.questions.map(
      (question, index) => `${index + 1}. ${question.question}\nAnswer: ${byIndex.get(index)}`
    )
  ].join('\n\n')
}

class DelegatedUserQuestionOwner {
  constructor(private readonly options: DelegatedUserQuestionOwnerOptions) {}

  async request(
    caller: AuthenticatedDelegateCaller,
    request: AgentUserChoiceRequest,
    explicitRequestId?: string
  ): Promise<AgentUserChoiceResult> {
    if (
      caller.role !== 'delegate' ||
      !caller.attemptId ||
      !caller.toolInvocationId.trim() ||
      request.sessionId !== caller.session.sessionId
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegated user question requires a trusted direct-child capability'
      )
    }
    const snapshot = await this.options.records.snapshot()
    if (!sameSession(snapshot.session, caller.session)) {
      throw new DurableDelegatedWorkError('authorization', 'delegated question Session mismatch')
    }
    const requestId = explicitRequestId?.trim() || this.options.createId('question')
    const canonicalDigest = createHash('sha256')
      .update(JSON.stringify(request.questions))
      .digest('hex')
    const existing = snapshot.questionRequests.find(
      (candidate) => candidate.requestId === requestId
    )
    if (existing) {
      if (
        existing.canonicalDigest !== canonicalDigest ||
        existing.sourceFrameId !== caller.frameId ||
        existing.sourceAttemptId !== caller.attemptId
      ) {
        throw new DurableDelegatedWorkError(
          'conflict',
          'delegated user question request identity was reused with different content or source'
        )
      }
      return { action: 'pending' }
    }
    const child = snapshot.records.find((candidate) => candidate.frameId === caller.frameId)
    const attempt = child && currentAttempt(child as DurableChild)
    const runtimeSegmentId = attempt?.runtimeSegmentIds.at(-1)
    if (
      !child ||
      child.parentFrameId !== snapshot.rootFrameId ||
      child.originBindingState !== 'validated' ||
      !snapshot.originMessageIds.includes(child.originMessageId) ||
      !attempt ||
      attempt.id !== caller.attemptId ||
      attempt.status !== 'running' ||
      !runtimeSegmentId
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegated user question source is not the active direct-child Attempt'
      )
    }
    await this.options.records.admitQuestion({
      requestId,
      canonicalDigest,
      sourceFrameId: child.frameId,
      sourceAttemptId: attempt.id,
      sourceRuntimeSegmentId: runtimeSegmentId,
      sourceMessageBranchId: child.messageBranchId,
      rootOriginMessageId: child.originMessageId,
      rootBranchId: snapshot.rootBranchId,
      sourceName: child.title,
      questions: structuredClone(request.questions),
      askedAt: this.options.now(),
      status: 'pending',
      draftAnswers: [],
      draftQuestionIndex: 0
    })
    return { action: 'pending' }
  }

  async updateDraft(session: SessionKey, input: UpdateQuestionDraftInput): Promise<void> {
    const snapshot = await this.options.records.snapshot()
    if (!sameSession(snapshot.session, session)) {
      throw new DurableDelegatedWorkError('authorization', 'delegated question Session mismatch')
    }
    const request = snapshot.questionRequests.find(
      (candidate) => candidate.requestId === input.requestId
    )
    if (!request || request.status !== 'pending') {
      throw new DurableDelegatedWorkError('conflict', 'delegated question is no longer pending')
    }
    if (
      !Number.isSafeInteger(input.questionIndex) ||
      input.questionIndex < 0 ||
      input.questionIndex >= request.questions.length ||
      input.draftAnswers.some(
        (answer) =>
          !Number.isSafeInteger(answer.questionIndex) ||
          answer.questionIndex < 0 ||
          answer.questionIndex >= request.questions.length ||
          typeof answer.value !== 'string' ||
          !answer.value.trim() ||
          answer.value.length > 4_000
      )
    ) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'delegated question draft is invalid'
      )
    }
    await this.options.records.updateQuestionDraft(
      input.requestId,
      input.draftAnswers,
      input.questionIndex
    )
  }

  async confirm(
    session: SessionKey,
    input: ConfirmQuestionInput
  ): Promise<Readonly<{ requestId: string; continuationAttemptId: string }>> {
    const snapshot = await this.options.records.snapshot()
    if (!sameSession(snapshot.session, session)) {
      throw new DurableDelegatedWorkError('authorization', 'delegated question Session mismatch')
    }
    const request = snapshot.questionRequests.find(
      (candidate) => candidate.requestId === input.requestId
    )
    if (!request || request.status !== 'pending') {
      throw new DurableDelegatedWorkError('conflict', 'delegated question is no longer pending')
    }
    if (
      snapshot.rootBranchId !== request.rootBranchId ||
      !snapshot.originMessageIds.includes(request.rootOriginMessageId)
    ) {
      throw new DurableDelegatedWorkError('authorization', 'delegated question branch is inactive')
    }
    assertQuestionAnswers(request, input.answers)
    const child = snapshot.records.find(
      (candidate) => candidate.frameId === request.sourceFrameId
    ) as DurableChild | undefined
    const previous = child && currentAttempt(child)
    if (!child || !previous || previous.id !== request.sourceAttemptId) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'delegated question source changed before confirmation'
      )
    }
    await this.options.waitForAttemptCompletion(child.frameId, previous.id)
    const latestSnapshot = await this.options.records.snapshot()
    const latest = latestSnapshot.records.find(
      (candidate) => candidate.frameId === child.frameId
    ) as DurableChild | undefined
    const latestAttempt = latest && currentAttempt(latest)
    if (
      !latest ||
      !latestAttempt ||
      latestAttempt.id !== request.sourceAttemptId ||
      latestAttempt.status === 'running'
    ) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'delegated question source Attempt cannot accept a continuation'
      )
    }
    const resolvedAgent =
      latestAttempt.resolvedAgent.kind === 'main'
        ? ({ kind: 'main' } as const)
        : await this.options.resolveAgent(latestAttempt.resolvedAgent.profileId)
    const executionModel = latestAttempt.executionModel ?? latest.attempts[0]?.executionModel
    if (!executionModel) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'historical delegated work has no stable Subagent model snapshot'
      )
    }
    const reservation = await this.options.reserve()
    const attemptId = this.options.createId('attempt')
    const message = questionContinuationMessage(request, input.answers)
    let committed = false
    try {
      await this.options.admission(() =>
        this.options.records.confirmQuestion({
          requestId: request.requestId,
          frameId: latest.frameId,
          previousAttemptId: latestAttempt.id,
          attemptId,
          userMessageId: this.options.createId('message'),
          message,
          answers: input.answers,
          resolvedAgent,
          executionModel,
          startedAt: this.options.now(),
          initiatingTurnMessageId: request.rootOriginMessageId
        })
      )
      committed = true
      const committedSnapshot = await this.options.records.snapshot()
      const continued = committedSnapshot.records.find(
        (candidate) => candidate.frameId === latest.frameId
      ) as DurableChild | undefined
      if (!continued || currentAttempt(continued).id !== attemptId) {
        throw new DurableDelegatedWorkError(
          'conflict',
          'delegated continuation changed before launch'
        )
      }
      this.options.launchContinuation({ child: continued, session, reservation, message })
    } catch (error) {
      try {
        if (committed) {
          await terminalizeUnsuccessfulAttempt(this.options.records, async () => undefined, {
            frameId: latest.frameId,
            attemptId,
            endedAt: this.options.now(),
            error
          })
        }
      } finally {
        await reservation.releaseAll()
      }
      if (committed || error instanceof DurableDelegatedWorkError) throw error
      throw new DurableDelegatedWorkError(
        'conflict',
        'delegated question changed while confirmation was committed'
      )
    }
    return { requestId: request.requestId, continuationAttemptId: attemptId }
  }
}

export { DelegatedUserQuestionOwner }
