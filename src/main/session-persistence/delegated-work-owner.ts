import {
  resolveActiveConversationMessages,
  type PersistedConversationGraph
} from '../../shared/conversation-graph'
import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkRecord
} from '../../shared/session-persistence'
import type {
  AttachDelegatedMessageArtifactsInput,
  AttemptAgentEventInput,
  AttemptAgentEvent,
  ChildRecord,
  CompleteChildTurnInput,
  CreateChildrenInput,
  CreatedChild,
  CreatedNamedChild,
  DelegatedWorkRecordCommands,
  AdmitMessageCommandInput,
  SettleMessageInput,
  StartMessageDispatchInput,
  SessionKey,
  StartContinuationAttemptInput,
  StartAttemptRuntimeInput,
  StartPendingMessageTurnInput,
  TransitionAttemptInput,
  AdmitQuestionInput,
  UpdateQuestionDraftInput,
  ConfirmQuestionInput
} from '../delegation/session-records'
import { canonicalStructuredOutputEqual } from '../delegation/structured-output'
import { allocateDelegateNames } from '../delegation/delegated-work-admission'
import { DurableDelegatedWorkError } from '../delegation/durable-delegated-work-error'
import {
  DelegatedWorkAttemptConflictError,
  SessionMessageDeliveryPersistenceOwner
} from './message-delivery-owner'
import {
  recoverInterruptedDelegatedWorkSession,
  SessionDelegatedWorkStore,
  type SessionDelegatedWorkStoreOptions
} from './delegated-work-store'
import { SessionDelegatedQuestionPersistenceOwner } from './delegated-question-owner'

const currentAttempt = (record: DelegatedWorkRecord): DelegatedWorkAttemptRecord => {
  const attempt = record.attempts.at(-1)
  if (!attempt) throw new Error(`Delegate Frame ${record.agentFrameId} has no Attempt.`)
  return attempt
}

const assertCurrentRunningAttempt = (
  records: readonly DelegatedWorkRecord[],
  frameId: string,
  attemptId: string
): { record: DelegatedWorkRecord; attempt: DelegatedWorkAttemptRecord } => {
  const record = records.find((candidate) => candidate.agentFrameId === frameId)
  if (!record) throw new Error(`Delegate Frame not found: ${frameId}`)
  const attempt = currentAttempt(record)
  if (attempt.id !== attemptId || attempt.status !== 'running') {
    throw new DelegatedWorkAttemptConflictError()
  }
  return { record, attempt }
}

// Owns durable Delegated Work CAS mutations behind one small command interface. The coordinator
// contributes only its scheduler and deletion guard, so delegation state cannot bypass Session ordering.
class SessionDelegatedWorkPersistenceOwner implements DelegatedWorkRecordCommands {
  private readonly messageDeliveryOwner = new SessionMessageDeliveryPersistenceOwner()
  private readonly store: SessionDelegatedWorkStore
  private readonly questions: SessionDelegatedQuestionPersistenceOwner

  constructor(options: SessionDelegatedWorkStoreOptions) {
    this.store = new SessionDelegatedWorkStore(options)
    this.questions = new SessionDelegatedQuestionPersistenceOwner(this.store)
  }

  createChildren(
    key: SessionKey,
    input: CreateChildrenInput
  ): Promise<readonly CreatedNamedChild[]> {
    return this.store.mutate(key, input.expectedRevision, (graph, records, session) => {
      if (session.delegationPolicy === 'deny') {
        throw DurableDelegatedWorkError.delegationDisabled()
      }
      if (input.children.length === 0)
        throw new Error('Child creation requires at least one child.')
      const parent = graph.frames.find((frame) => frame.id === input.parentFrameId)
      if (!parent || parent.kind !== 'root') {
        throw new Error('Delegate children must be created by the root Main Agent Frame.')
      }
      const parentPath = resolveActiveConversationMessages({ ...graph, activeFrameId: parent.id })
      if (!parentPath.some((message) => message.id === input.originMessageId)) {
        throw new Error('Delegate origin Message is not on the parent current Branch.')
      }
      const parentPathMessageIds = new Set(parentPath.map((message) => message.id))
      const existingIds = new Set([
        ...graph.frames.map(({ id }) => id),
        ...graph.branches.map(({ id }) => id),
        ...graph.messages.map(({ id }) => id),
        ...records.flatMap((record) => record.attempts.map(({ id }) => id))
      ])
      const batchIds = input.children.flatMap((child) => [
        child.frameId,
        child.branchId,
        child.messageId,
        child.attemptId
      ])
      if (
        new Set(batchIds).size !== batchIds.length ||
        batchIds.some((id) => existingIds.has(id))
      ) {
        throw new Error('Delegate child creation contains a duplicate durable identity.')
      }
      const finalNames = allocateDelegateNames(
        input.children.map((child) => child.name),
        graph.frames
          .filter(
            (frame) =>
              frame.kind === 'delegate' &&
              frame.parentFrameId === input.parentFrameId &&
              frame.originMessageId !== undefined &&
              parentPathMessageIds.has(frame.originMessageId)
          )
          .map((frame) => frame.delegateName ?? frame.agentName ?? frame.id)
      )
      for (const [index, child] of input.children.entries()) {
        if (child.initiatingTurnMessageId !== input.originMessageId) {
          throw new Error('Initial delegated Attempt must belong to its admitting root Turn.')
        }
        const finalName = finalNames[index]
        graph.frames.push({
          id: child.frameId,
          parentFrameId: input.parentFrameId,
          originMessageId: input.originMessageId,
          originBindingState: 'validated',
          kind: 'delegate',
          ...(child.resolvedAgent.kind === 'specialist'
            ? { agentName: child.resolvedAgent.displayName }
            : {}),
          delegateName: finalName,
          status: 'running',
          activeBranchId: child.branchId,
          createdAt: child.startedAt
        })
        graph.branches.push({
          id: child.branchId,
          agentFrameId: child.frameId,
          headMessageId: child.messageId,
          createdAt: child.startedAt,
          updatedAt: child.startedAt
        })
        graph.messages.push({
          id: child.messageId,
          role: 'user',
          content: child.task,
          delegatedTask: child.task,
          ...(child.inputs?.length ? { delegatedInputVersionIds: [...child.inputs] } : {}),
          delegatedCallerSource: child.callerSource,
          ...(child.structuredOutputEvidence
            ? { structuredOutputEvidence: structuredClone(child.structuredOutputEvidence) }
            : {}),
          status: 'complete',
          eventIds: [],
          agentFrameId: child.frameId,
          introducedOnBranchId: child.branchId,
          revisionRootMessageId: child.messageId,
          createdAt: child.startedAt,
          updatedAt: child.startedAt
        })
        records.push({
          agentFrameId: child.frameId,
          attempts: [
            {
              id: child.attemptId,
              initiatingTurnMessageId: child.initiatingTurnMessageId,
              status: 'running',
              resolvedAgent: child.resolvedAgent,
              ...(child.executionModel ? { executionModel: child.executionModel } : {}),
              runtimeSegmentIds: [],
              startedAt: child.startedAt
            }
          ]
        })
      }
      return input.children.map((child, index) => ({
        frameId: child.frameId,
        attemptId: child.attemptId,
        name: finalNames[index],
        status: 'running' as const
      }))
    })
  }

  startContinuationAttempt(
    key: SessionKey,
    input: StartContinuationAttemptInput
  ): Promise<CreatedChild> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (graph, records, _session, commands, quarantined) => {
        if (quarantined) throw new Error('Reliable message owner is quarantined.')
        const record = records.find((candidate) => candidate.agentFrameId === input.frameId)
        if (!record) throw new Error(`Delegate Frame not found: ${input.frameId}`)
        const previous = currentAttempt(record)
        if (previous.id !== input.previousAttemptId || previous.status === 'running') {
          throw new DelegatedWorkAttemptConflictError()
        }
        if (
          records.some((candidate) =>
            candidate.attempts.some(({ id }) => id === input.attemptId)
          ) ||
          graph.messages.some(({ id }) => id === input.messageId)
        ) {
          throw new Error('Continuation contains a duplicate durable identity.')
        }
        const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
        if (!frame) throw new Error(`Delegate Frame not found: ${input.frameId}`)
        const rootPath = resolveActiveConversationMessages({
          ...graph,
          activeFrameId: graph.rootFrameId
        })
        if (
          input.initiatingTurnMessageId !== input.callerSource.rootMessageId ||
          !rootPath.some((message) => message.id === input.initiatingTurnMessageId)
        ) {
          throw new Error('Continuation Attempt initiating Turn is outside the active root Branch.')
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
          delegatedCallerSource: input.callerSource,
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
          ...(input.executionModel ? { executionModel: input.executionModel } : {}),
          runtimeSegmentIds: [],
          startedAt: input.startedAt
        })
        frame.status = 'running'
        delete frame.completedAt
        commands.push(structuredClone(input.messageCommand))
        return { frameId: input.frameId, attemptId: input.attemptId, status: 'running' }
      }
    )
  }

  admitQuestion(key: SessionKey, input: AdmitQuestionInput): Promise<'admitted' | 'idempotent'> {
    return this.questions.admitQuestion(key, input)
  }

  updateQuestionDraft(key: SessionKey, input: UpdateQuestionDraftInput): Promise<void> {
    return this.questions.updateQuestionDraft(key, input)
  }

  confirmQuestion(key: SessionKey, input: ConfirmQuestionInput): Promise<CreatedChild> {
    return this.questions.confirmQuestion(key, input)
  }

  cancelQuestions(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; frameId: string; endedAt: number; reason: string }>
  ): Promise<void> {
    return this.questions.cancelQuestions(key, input)
  }

  startAttemptRuntime(key: SessionKey, input: StartAttemptRuntimeInput): Promise<void> {
    return this.store.mutate(key, input.expectedRevision, (graph, records) => {
      const { record, attempt } = assertCurrentRunningAttempt(
        records,
        input.frameId,
        input.attemptId
      )
      if (graph.runtimeSegments.some((segment) => segment.id === input.runtimeSegmentId)) {
        throw new Error(`Runtime Segment already exists: ${input.runtimeSegmentId}`)
      }
      const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
      const branch = graph.branches.find((candidate) => candidate.id === frame?.activeBranchId)
      const promptMessage = graph.messages.find(
        (message) => message.id === branch?.headMessageId && message.role === 'user'
      )
      if (!frame || !branch || !promptMessage) {
        throw new Error('Delegated runtime has no current Frame, Branch, or prompt Message.')
      }
      graph.runtimeSegments.push({
        id: input.runtimeSegmentId,
        agentFrameId: input.frameId,
        frameworkId: input.frameworkId,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.backendId ? { backendId: input.backendId } : {}),
        ...(input.agentName ? { agentName: input.agentName } : {}),
        ...(input.model ? { model: input.model } : {}),
        startedAt: input.startedAt
      })
      promptMessage.runtimeSegmentId = input.runtimeSegmentId
      const attempts = record.attempts as DelegatedWorkAttemptRecord[]
      attempts[attempts.length - 1] = {
        ...attempt,
        runtimeSegmentIds: [...attempt.runtimeSegmentIds, input.runtimeSegmentId]
      }
    })
  }

  applyAgentEvent(key: SessionKey, input: AttemptAgentEventInput): Promise<void> {
    const events: readonly AttemptAgentEvent[] = 'kind' in input.event ? [input.event] : input.event
    return this.store.mutate(key, input.expectedRevision, (graph, records) => {
      assertCurrentRunningAttempt(records, input.frameId, input.attemptId)
      const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
      if (!frame) throw new Error(`Delegate Frame not found: ${input.frameId}`)
      const branch = graph.branches.find((candidate) => candidate.id === frame.activeBranchId)
      if (!branch) throw new Error(`Delegate Branch not found: ${frame.activeBranchId}`)
      for (const event of events) {
        if (event.kind === 'message') {
          const segment = graph.runtimeSegments.find(
            (candidate) =>
              candidate.id === event.runtimeSegmentId && candidate.agentFrameId === input.frameId
          )
          if (!segment) throw new Error('Agent event Runtime Segment is outside the Attempt Frame.')
          const nextMessage: PersistedConversationGraph['messages'][number] = {
            ...event.message,
            agentFrameId: input.frameId,
            introducedOnBranchId: branch.id,
            ...(branch.headMessageId ? { parentMessageId: branch.headMessageId } : {}),
            ...(event.message.role === 'user' ? { revisionRootMessageId: event.message.id } : {}),
            runtimeSegmentId: event.runtimeSegmentId
          }
          const existing = graph.messages.find((message) => message.id === event.message.id)
          if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(nextMessage)) continue
            throw new Error(`Message already exists: ${event.message.id}`)
          }
          graph.messages.push(nextMessage)
          branch.headMessageId = event.message.id
          branch.updatedAt = Math.max(branch.updatedAt, event.message.updatedAt)
        } else if (event.kind === 'activity') {
          if (
            !graph.messages.some(
              (message) =>
                message.id === event.promptMessageId && message.agentFrameId === input.frameId
            ) ||
            !graph.runtimeSegments.some(
              (segment) =>
                segment.id === event.runtimeSegmentId && segment.agentFrameId === input.frameId
            )
          ) {
            throw new Error('Activity provenance is outside the Attempt Frame.')
          }
          const nextActivity: PersistedConversationGraph['activities'][number] = {
            ...event.activity,
            agentFrameId: input.frameId,
            messageBranchId: branch.id,
            promptMessageId: event.promptMessageId,
            runtimeSegmentId: event.runtimeSegmentId
          }
          const existing = graph.activities.find((activity) => activity.id === event.activity.id)
          if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(nextActivity)) continue
            throw new Error(`Activity already exists: ${event.activity.id}`)
          }
          graph.activities.push(nextActivity)
        } else {
          if (
            !graph.messages.some(
              (message) =>
                message.id === event.promptMessageId && message.agentFrameId === input.frameId
            )
          ) {
            throw new Error('Activity Group provenance is outside the Attempt Frame.')
          }
          const nextActivityGroup: PersistedConversationGraph['activityGroups'][number] = {
            ...event.activityGroup,
            agentFrameId: input.frameId,
            messageBranchId: branch.id,
            promptMessageId: event.promptMessageId
          }
          const existing = graph.activityGroups.find((group) => group.id === event.activityGroup.id)
          if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(nextActivityGroup)) continue
            throw new Error(`Activity Group already exists: ${event.activityGroup.id}`)
          }
          graph.activityGroups.push(nextActivityGroup)
        }
      }
    })
  }

  transitionAttempt(key: SessionKey, input: TransitionAttemptInput): Promise<void> {
    return this.store.mutate(key, input.expectedRevision, (graph, records) => {
      const { record, attempt } = assertCurrentRunningAttempt(
        records,
        input.frameId,
        input.attemptId
      )
      if (input.endedAt < attempt.startedAt) throw new Error('Attempt end precedes its start.')
      if (input.status === 'completed' && !input.terminalMessageId) {
        throw new Error('A completed Attempt requires a terminal Message.')
      }
      if (input.status === 'cancelled' && !input.cancellationReason) {
        throw new Error('A cancelled Attempt requires a cancellation reason.')
      }
      if (input.status === 'error' && !input.error) {
        throw new Error('An errored Attempt requires error detail.')
      }
      if (
        input.terminalMessageId &&
        !graph.messages.some(
          (message) =>
            message.id === input.terminalMessageId && message.agentFrameId === input.frameId
        )
      ) {
        throw new Error('Terminal Message is outside the Attempt Frame.')
      }
      const attempts = record.attempts as DelegatedWorkAttemptRecord[]
      attempts[attempts.length - 1] = {
        ...attempt,
        status: input.status,
        endedAt: input.endedAt,
        ...(input.terminalMessageId ? { terminalMessageId: input.terminalMessageId } : {}),
        ...(input.cancellationReason ? { cancellationReason: input.cancellationReason } : {}),
        ...(input.error ? { error: input.error } : {})
      }
      const frame = graph.frames.find((candidate) => candidate.id === input.frameId)
      if (!frame) throw new Error(`Delegate Frame not found: ${input.frameId}`)
      frame.status = input.status
      frame.completedAt = input.endedAt
      for (const segmentId of attempt.runtimeSegmentIds) {
        const segment = graph.runtimeSegments.find((candidate) => candidate.id === segmentId)
        if (segment && segment.endedAt === undefined) segment.endedAt = input.endedAt
      }
    })
  }

  submitStructuredOutput(
    key: SessionKey,
    input: import('../delegation/session-records').SubmitStructuredOutputInput
  ): Promise<'accepted' | 'idempotent'> {
    return this.store.mutate(key, input.expectedRevision, (graph, records) => {
      assertCurrentRunningAttempt(records, input.frameId, input.attemptId)
      const message = graph.messages.find(
        (candidate) =>
          candidate.agentFrameId === input.frameId &&
          candidate.structuredOutputEvidence?.attemptId === input.attemptId
      )
      const evidence = message?.structuredOutputEvidence
      if (!message || !evidence || evidence.schemaDigest !== input.schemaDigest) {
        throw new Error('Structured output contract is unavailable.')
      }
      if (evidence.accepted) {
        if (
          canonicalStructuredOutputEqual(
            evidence.accepted.value as import('../delegation/structured-output').JsonValue,
            input.value
          )
        )
          return 'idempotent'
        throw new Error('A different structured output was already accepted.')
      }
      message.structuredOutputEvidence = {
        ...evidence,
        accepted: { value: structuredClone(input.value), acceptedAt: input.acceptedAt }
      }
      return 'accepted'
    })
  }

  admitMessageCommand(
    key: SessionKey,
    input: AdmitMessageCommandInput
  ): Promise<'admitted' | 'idempotent'> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (_graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.admit(commands, quarantined, input)
    )
  }

  startMessageDispatch(
    key: SessionKey,
    input: StartMessageDispatchInput
  ): Promise<'started' | 'terminal' | 'blocked'> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.startDispatch(graph, commands, quarantined, input)
    )
  }

  settleMessage(key: SessionKey, input: SettleMessageInput): Promise<'settled' | 'terminal'> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (_graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.settle(commands, quarantined, input)
    )
  }

  acknowledgeUncertainMessage(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; messageId: string }>
  ): Promise<'acknowledged' | 'terminal'> {
    return this.store.mutate(
      key,
      input.expectedRevision,
      (_graph, _records, _session, commands, quarantined) =>
        this.messageDeliveryOwner.acknowledge(commands, quarantined, input.messageId)
    )
  }

  startPendingMessageTurn(key: SessionKey, input: StartPendingMessageTurnInput): Promise<void> {
    return this.store.mutate(key, input.expectedRevision, (graph, records, _session, commands) =>
      this.messageDeliveryOwner.startChildTurn(graph, records, commands, input)
    )
  }

  completeChildTurn(key: SessionKey, input: CompleteChildTurnInput): Promise<void> {
    return this.store.mutate(key, input.expectedRevision, (graph, records) =>
      this.messageDeliveryOwner.completeChildTurn(graph, records, input)
    )
  }

  attachDelegatedMessageArtifacts(
    key: SessionKey,
    input: AttachDelegatedMessageArtifactsInput
  ): Promise<void> {
    return this.store.attachDelegatedMessageArtifacts(key, input)
  }

  readChildren(key: SessionKey, parentFrameId: string): Promise<readonly ChildRecord[]> {
    return this.store.readChildren(key, parentFrameId)
  }

  recoverInterruptedDelegatedWork(): Promise<readonly { frameId: string; attemptId: string }[]> {
    return this.store.recoverInterruptedDelegatedWork()
  }
}

export { recoverInterruptedDelegatedWorkSession, SessionDelegatedWorkPersistenceOwner }
export type { SessionDelegatedWorkStoreOptions as SessionDelegatedWorkPersistenceOwnerOptions }
