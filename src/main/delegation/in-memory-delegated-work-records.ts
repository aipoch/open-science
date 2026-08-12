import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type {
  DelegatedWorkDurableRecords,
  DurableMessage,
  DurableMessageCommand,
  DurableSnapshot
} from './durable-delegated-work'
import { canonicalStructuredOutputEqual } from './structured-output'
import { allocateDelegateNames } from './delegated-work-admission'

type SessionKey = DurableSnapshot['session']
type DurableChild = DurableSnapshot['records'][number]
type DurableAttempt = DurableChild['attempts'][number]

const createInMemoryDelegatedWorkRecords = (input: {
  session: SessionKey
  rootFrameId: string
  originMessageId: string
  originMessageIds?: readonly string[]
}): DelegatedWorkDurableRecords => {
  const state: {
    session: SessionKey
    rootFrameId: string
    rootBranchId: string
    rootBranchRevision: string
    originMessageIds: string[]
    records: DurableChild[]
    messages: DurableMessage[]
    messageCommands: DurableMessageCommand[]
    questionRequests: DurableSnapshot['questionRequests'][number][]
  } = {
    session: { ...input.session },
    rootFrameId: input.rootFrameId,
    rootBranchId: 'root-branch',
    rootBranchRevision: 'root-branch:0',
    originMessageIds: [...(input.originMessageIds ?? [input.originMessageId])],
    records: [],
    messages: [],
    messageCommands: [],
    questionRequests: []
  }
  const findRunning = (frameId: string, attemptId: string): DurableAttempt => {
    const child = state.records.find((candidate) => candidate.frameId === frameId)
    const attempt = child && currentAttempt(child)
    if (!attempt || attempt.id !== attemptId || attempt.status !== 'running') {
      throw new Error('Delegated Attempt is not current and running.')
    }
    return attempt
  }
  return {
    async admitChildren(admission) {
      if (
        !sameSession(state.session, admission.caller.session) ||
        admission.caller.frameId !== state.rootFrameId ||
        !state.originMessageIds.includes(admission.caller.originMessageId)
      ) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'delegation caller or origin Message is outside the active root conversation'
        )
      }
      if (admission.children.length === 0) {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'delegation requires one or more children'
        )
      }
      const frameIds = admission.children.map((child) => child.frameId)
      const attemptIds = admission.children.map((child) => child.attemptId)
      const messageIds = admission.children.map((child) => child.userMessageId)
      if (
        new Set(frameIds).size !== frameIds.length ||
        new Set(attemptIds).size !== attemptIds.length ||
        new Set(messageIds).size !== messageIds.length ||
        state.records.some((child) => frameIds.includes(child.frameId)) ||
        state.records.some((child) =>
          child.attempts.some((attempt) => attemptIds.includes(attempt.id))
        ) ||
        state.messages.some((message) => messageIds.includes(message.id))
      ) {
        throw new Error('Duplicate delegated-work identity.')
      }
      const finalNames = allocateDelegateNames(
        admission.children.map((child) => child.name),
        state.records
          .filter(
            (child) =>
              child.parentFrameId === admission.caller.frameId &&
              state.originMessageIds.includes(child.originMessageId)
          )
          .map((child) => child.title)
      )
      state.records.push(
        ...admission.children.map((child, index) => ({
          frameId: child.frameId,
          parentFrameId: admission.caller.frameId,
          originMessageId: admission.caller.originMessageId,
          originBindingState: 'validated' as const,
          title: finalNames[index],
          task: child.request.task,
          outputSchema: child.request.outputSchema,
          inputs: [...(child.request.inputs ?? [])],
          messageBranchId: `branch-${child.frameId}`,
          attempts: [
            {
              id: child.attemptId,
              initiatingTurnMessageId: admission.caller.originMessageId,
              status: 'running' as const,
              resolvedAgent: structuredClone(child.resolvedAgent),
              ...(child.executionModel
                ? { executionModel: structuredClone(child.executionModel) }
                : {}),
              runtimeSegmentIds: [],
              startedAt: child.startedAt
            }
          ]
        }))
      )
      state.messages.push(
        ...admission.children.map((child) => ({
          id: child.userMessageId,
          frameId: child.frameId,
          role: 'user' as const,
          content: child.request.task,
          createdAt: child.startedAt,
          ...(child.structuredOutputEvidence
            ? { structuredOutputEvidence: structuredClone(child.structuredOutputEvidence) }
            : {})
        }))
      )
      return admission.children.map((child, index) => ({
        frameId: child.frameId,
        attemptId: child.attemptId,
        name: finalNames[index]
      }))
    },
    async continueChild(input) {
      const child = state.records.find((candidate) => candidate.frameId === input.frameId)
      const previous = child && currentAttempt(child)
      if (
        !child ||
        !previous ||
        previous.id !== input.previousAttemptId ||
        previous.status === 'running'
      ) {
        throw new DurableDelegatedWorkError(
          'conflict',
          `child ${input.frameId} is not at the expected terminal Attempt`
        )
      }
      if (
        state.records.some((record) =>
          record.attempts.some((attempt) => attempt.id === input.attemptId)
        ) ||
        state.messages.some((message) => message.id === input.userMessageId)
      ) {
        throw new Error('Duplicate continuation identity.')
      }
      child.attempts.push({
        id: input.attemptId,
        initiatingTurnMessageId: input.initiatingTurnMessageId,
        status: 'running',
        resolvedAgent: structuredClone(input.resolvedAgent),
        ...(input.executionModel ? { executionModel: structuredClone(input.executionModel) } : {}),
        runtimeSegmentIds: [],
        startedAt: input.startedAt
      })
      state.messages.push({
        id: input.userMessageId,
        frameId: input.frameId,
        role: 'user',
        content: input.message,
        createdAt: input.startedAt
      })
      state.messageCommands.push(structuredClone(input.messageCommand))
    },
    async admitQuestion(request) {
      const existing = state.questionRequests.find(
        (candidate) => candidate.requestId === request.requestId
      )
      if (existing) {
        if (existing.canonicalDigest !== request.canonicalDigest) {
          throw new DurableDelegatedWorkError(
            'conflict',
            'delegated question request identity was already used for a different payload'
          )
        }
        return 'idempotent'
      }
      const child = state.records.find((candidate) => candidate.frameId === request.sourceFrameId)
      const attempt = child && currentAttempt(child)
      if (
        !child ||
        !attempt ||
        attempt.id !== request.sourceAttemptId ||
        attempt.status !== 'running' ||
        !attempt.runtimeSegmentIds.includes(request.sourceRuntimeSegmentId) ||
        child.messageBranchId !== request.sourceMessageBranchId ||
        child.originMessageId !== request.rootOriginMessageId ||
        state.rootBranchId !== request.rootBranchId ||
        !state.originMessageIds.includes(child.originMessageId)
      ) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'delegated question source is outside the active direct-child route'
        )
      }
      const sequence =
        state.questionRequests.reduce(
          (maximum, candidate) => Math.max(maximum, candidate.sequence ?? 0),
          0
        ) + 1
      state.questionRequests.push(structuredClone({ ...request, sequence }))
      return 'admitted'
    },
    async updateQuestionDraft(requestId, draftAnswers, questionIndex) {
      const index = state.questionRequests.findIndex((request) => request.requestId === requestId)
      const request = state.questionRequests[index]
      if (!request || request.status !== 'pending') {
        throw new DurableDelegatedWorkError('conflict', 'delegated question is no longer pending')
      }
      if (
        state.rootBranchId !== request.rootBranchId ||
        !state.originMessageIds.includes(request.rootOriginMessageId)
      ) {
        throw new DurableDelegatedWorkError(
          'authorization',
          'delegated question branch is inactive'
        )
      }
      state.questionRequests[index] = {
        ...request,
        draftAnswers: structuredClone(draftAnswers),
        draftQuestionIndex: questionIndex
      }
    },
    async confirmQuestion(input) {
      const requestIndex = state.questionRequests.findIndex(
        (request) => request.requestId === input.requestId
      )
      const request = state.questionRequests[requestIndex]
      const child = state.records.find((candidate) => candidate.frameId === input.frameId)
      const previous = child && currentAttempt(child)
      if (
        !request ||
        request.status !== 'pending' ||
        request.sourceFrameId !== input.frameId ||
        !child ||
        !previous ||
        previous.id !== input.previousAttemptId ||
        previous.status === 'running' ||
        state.rootBranchId !== request.rootBranchId ||
        !state.originMessageIds.includes(request.rootOriginMessageId)
      ) {
        throw new DurableDelegatedWorkError(
          'conflict',
          'delegated question route cannot admit a continuation'
        )
      }
      if (
        state.records.some((record) =>
          record.attempts.some((attempt) => attempt.id === input.attemptId)
        ) ||
        state.messages.some((message) => message.id === input.userMessageId)
      ) {
        throw new DurableDelegatedWorkError('conflict', 'duplicate question continuation identity')
      }
      child.attempts.push({
        id: input.attemptId,
        initiatingTurnMessageId: input.initiatingTurnMessageId,
        status: 'running',
        resolvedAgent: structuredClone(input.resolvedAgent),
        executionModel: structuredClone(input.executionModel),
        runtimeSegmentIds: [],
        startedAt: input.startedAt
      })
      state.messages.push({
        id: input.userMessageId,
        frameId: input.frameId,
        role: 'user',
        content: input.message,
        createdAt: input.startedAt
      })
      state.questionRequests[requestIndex] = {
        ...request,
        status: 'confirmed',
        draftAnswers: structuredClone(input.answers),
        answers: structuredClone(input.answers),
        respondedAt: input.startedAt,
        continuationAttemptId: input.attemptId
      }
    },
    async cancelQuestions(frameId, endedAt, reason) {
      state.questionRequests = state.questionRequests.map((request) =>
        request.sourceFrameId === frameId && request.status === 'pending'
          ? {
              ...request,
              status: 'cancelled' as const,
              respondedAt: endedAt,
              failure: { code: 'cancelled', message: reason }
            }
          : request
      )
    },
    async startRuntime(frameId, attemptId, runtimeSegmentId) {
      findRunning(frameId, attemptId).runtimeSegmentIds.push(runtimeSegmentId)
      const child = state.records.find((candidate) => candidate.frameId === frameId)!
      const promptMessage = [...state.messages]
        .reverse()
        .find((message) => message.frameId === frameId && message.role === 'user')
      if (!promptMessage) throw new Error('Delegated Attempt has no prompt Message.')
      promptMessage.runtimeSegmentId = runtimeSegmentId
      return {
        rootFrameId: state.rootFrameId,
        messageBranchId: child.messageBranchId,
        promptMessageId: promptMessage.id,
        runtimeSegmentId
      }
    },
    async stageTerminalMessage(frameId, attemptId, message) {
      findRunning(frameId, attemptId)
      if (message.frameId !== frameId || message.role !== 'assistant') {
        throw new Error('Terminal Message does not belong to the delegated Attempt.')
      }
      const existing = state.messages.find((candidate) => candidate.id === message.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(message)) {
        throw new Error('Terminal Message identity is already in use.')
      }
      if (!existing) state.messages.push({ ...message })
    },
    async terminalize(terminal) {
      const attempt = findRunning(terminal.frameId, terminal.attemptId)
      attempt.status = terminal.status
      attempt.endedAt = terminal.endedAt
      if (terminal.status === 'completed') {
        if (!state.messages.some((message) => message.id === terminal.terminalMessage.id)) {
          state.messages.push({ ...terminal.terminalMessage })
        }
        attempt.terminalMessageId = terminal.terminalMessage.id
      } else if (terminal.status === 'cancelled') {
        attempt.cancellationReason = terminal.cancellationReason
      } else {
        attempt.error = { ...terminal.error }
      }
    },
    async startPendingTurn(
      frameId,
      attemptId,
      pendingMessageId,
      promptMessageId,
      runtimeSegmentId
    ) {
      findRunning(frameId, attemptId).runtimeSegmentIds.push(runtimeSegmentId)
      const child = state.records.find((candidate) => candidate.frameId === frameId)!
      const pending = state.messageCommands.find(
        ({ messageId, targetFrameId, targetAttemptId }) =>
          messageId === pendingMessageId &&
          targetFrameId === frameId &&
          targetAttemptId === attemptId
      )
      if (!pending) throw new Error('Pending child Turn has no durable message command.')
      state.messages.push({
        id: promptMessageId,
        frameId,
        role: 'user',
        content: pending.text,
        createdAt: pending.queuedAt
      })
      return {
        rootFrameId: state.rootFrameId,
        messageBranchId: child.messageBranchId,
        promptMessageId,
        runtimeSegmentId
      }
    },
    async completeTurn(frameId, attemptId, runtimeSegmentId) {
      const attempt = findRunning(frameId, attemptId)
      if (!attempt.runtimeSegmentIds.includes(runtimeSegmentId)) {
        throw new Error('Child Turn Runtime Segment is outside the Attempt.')
      }
    },
    async submitOutput(frameId, attemptId, schemaDigest, value, acceptedAt) {
      findRunning(frameId, attemptId)
      const message = state.messages.find(
        (candidate) => candidate.structuredOutputEvidence?.attemptId === attemptId
      )
      const evidence = message?.structuredOutputEvidence
      if (!message || !evidence || evidence.schemaDigest !== schemaDigest) {
        throw new DurableDelegatedWorkError('conflict', 'structured output contract is unavailable')
      }
      if (evidence.accepted) {
        if (canonicalStructuredOutputEqual(evidence.accepted.value, value)) return 'idempotent'
        throw new DurableDelegatedWorkError(
          'conflict',
          'a different structured output was already accepted'
        )
      }
      message.structuredOutputEvidence = {
        ...evidence,
        accepted: { value: structuredClone(value), acceptedAt }
      }
      return 'accepted'
    },
    async admitMessage(command) {
      const existing = state.messageCommands.find(
        (candidate) =>
          candidate.sourcePrincipal === command.sourcePrincipal &&
          candidate.requestId === command.requestId
      )
      if (existing) {
        if (existing.canonicalDigest !== command.canonicalDigest) {
          throw new DurableDelegatedWorkError(
            'conflict',
            'message request_id was already used for a different request'
          )
        }
        return 'idempotent'
      }
      if (state.messageCommands.some(({ messageId }) => messageId === command.messageId)) {
        throw new Error(`Message command already exists: ${command.messageId}`)
      }
      state.messageCommands.push(structuredClone(command))
      return 'admitted'
    },
    async markMessageDispatchStarted(
      messageId,
      dispatchStartedAt,
      dispatchEpoch,
      rootBranchId,
      rootBranchRevision
    ) {
      const index = state.messageCommands.findIndex((command) => command.messageId === messageId)
      const command = state.messageCommands[index]
      if (!command) throw new Error(`Message command not found: ${messageId}`)
      if (command.receipt.status !== 'queued') return 'terminal'
      if (state.rootBranchId !== rootBranchId || state.rootBranchRevision !== rootBranchRevision)
        return 'blocked'
      const blocked = state.messageCommands.some(
        (candidate) =>
          candidate.sourceFrameId === command.sourceFrameId &&
          candidate.targetFrameId === command.targetFrameId &&
          candidate.laneSequence < command.laneSequence &&
          (candidate.receipt.status === 'queued' ||
            (candidate.receipt.status === 'uncertain' &&
              candidate.receipt.resolution === 'pending'))
      )
      if (blocked) return 'blocked'
      if (command.receipt.dispatchStartedAt !== undefined) return 'started'
      state.messageCommands[index] = {
        ...command,
        receipt: { status: 'queued', dispatchStartedAt, dispatchEpoch }
      }
      return 'started'
    },
    async settleMessage(messageId, receipt) {
      const index = state.messageCommands.findIndex((command) => command.messageId === messageId)
      const command = state.messageCommands[index]
      if (!command) throw new Error(`Message command not found: ${messageId}`)
      if (command.receipt.status !== 'queued') return 'terminal'
      state.messageCommands[index] = { ...command, receipt: structuredClone(receipt) }
      return 'settled'
    },
    async acknowledgeUncertain(messageId) {
      const index = state.messageCommands.findIndex((command) => command.messageId === messageId)
      const command = state.messageCommands[index]
      if (!command) throw new Error(`Message command not found: ${messageId}`)
      if (command.receipt.status !== 'uncertain') return 'terminal'
      if (command.receipt.resolution === 'acknowledged') return 'acknowledged'
      state.messageCommands[index] = {
        ...command,
        receipt: { ...command.receipt, resolution: 'acknowledged' }
      }
      return 'acknowledged'
    },
    snapshot: async () => structuredClone(state)
  }
}

export { createInMemoryDelegatedWorkRecords }
