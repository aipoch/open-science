import type { PersistedConversationGraph } from '../../shared/conversation-graph'
import type { DelegatedMessageCommand } from '../../shared/session-persistence'
import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkRecord
} from '../../shared/session-persistence'
import type {
  AdmitMessageCommandInput,
  CompleteChildTurnInput,
  SettleMessageInput,
  StartMessageDispatchInput,
  StartPendingMessageTurnInput
} from '../delegation/session-records'

export class DelegatedWorkAttemptConflictError extends Error {
  readonly code = 'attempt-conflict' as const

  constructor() {
    super('Attempt write rejected because its capability is no longer current and running.')
    this.name = 'DelegatedWorkAttemptConflictError'
  }
}

const runningAttempt = (
  records: readonly DelegatedWorkRecord[],
  frameId: string,
  attemptId: string
): { record: DelegatedWorkRecord; attempt: DelegatedWorkAttemptRecord } => {
  const record = records.find((candidate) => candidate.agentFrameId === frameId)
  if (!record) throw new Error(`Delegate Frame not found: ${frameId}`)
  const attempt = record.attempts.at(-1)
  if (!attempt) throw new Error(`Delegate Frame ${record.agentFrameId} has no Attempt.`)
  if (attempt.id !== attemptId || attempt.status !== 'running') {
    throw new DelegatedWorkAttemptConflictError()
  }
  return { record, attempt }
}

/** Owns reliable-message transitions independently from the Session persistence facade. */
export class SessionMessageDeliveryPersistenceOwner {
  private assertWritable(quarantined: boolean): void {
    if (quarantined) throw new Error('Reliable message owner is quarantined.')
  }

  startChildTurn(
    graph: PersistedConversationGraph,
    records: DelegatedWorkRecord[],
    commands: DelegatedMessageCommand[],
    input: StartPendingMessageTurnInput
  ): void {
    const { record, attempt } = runningAttempt(records, input.frameId, input.attemptId)
    const pending = commands.find(({ messageId }) => messageId === input.pendingMessageId)
    if (
      !pending ||
      pending.sourceFrameId === input.frameId ||
      pending.targetFrameId !== input.frameId ||
      pending.targetAttemptId !== input.attemptId
    ) {
      throw new Error('Pending child Turn has no authenticated Main caller source.')
    }
    if (
      graph.messages.some(({ id }) => id === input.promptMessageId) ||
      graph.runtimeSegments.some(({ id }) => id === input.runtimeSegmentId)
    ) {
      throw new Error('Pending child Turn contains a duplicate durable identity.')
    }
    const frame = graph.frames.find(({ id }) => id === input.frameId)
    const branch = graph.branches.find(({ id }) => id === frame?.activeBranchId)
    if (!frame || !branch) throw new Error('Pending child Turn has no active Branch.')
    graph.runtimeSegments.push({
      id: input.runtimeSegmentId,
      agentFrameId: input.frameId,
      frameworkId: input.frameworkId,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      startedAt: input.startedAt
    })
    graph.messages.push({
      id: input.promptMessageId,
      role: 'user',
      content: pending.text,
      status: 'complete',
      eventIds: [],
      delegatedCallerSource: {
        rootMessageId: pending.callerRootMessageId,
        toolInvocationId: pending.requestId
      },
      agentFrameId: input.frameId,
      introducedOnBranchId: branch.id,
      ...(branch.headMessageId ? { parentMessageId: branch.headMessageId } : {}),
      revisionRootMessageId: input.promptMessageId,
      runtimeSegmentId: input.runtimeSegmentId,
      createdAt: input.startedAt,
      updatedAt: input.startedAt
    })
    branch.headMessageId = input.promptMessageId
    branch.updatedAt = input.startedAt
    const attempts = record.attempts as DelegatedWorkAttemptRecord[]
    attempts[attempts.length - 1] = {
      ...attempt,
      runtimeSegmentIds: [...attempt.runtimeSegmentIds, input.runtimeSegmentId]
    }
  }

  completeChildTurn(
    graph: PersistedConversationGraph,
    records: DelegatedWorkRecord[],
    input: CompleteChildTurnInput
  ): void {
    const { attempt } = runningAttempt(records, input.frameId, input.attemptId)
    if (!attempt.runtimeSegmentIds.includes(input.runtimeSegmentId)) {
      throw new Error('Child Turn Runtime Segment is outside the Attempt.')
    }
    const segment = graph.runtimeSegments.find(
      ({ id, agentFrameId }) => id === input.runtimeSegmentId && agentFrameId === input.frameId
    )
    if (!segment) throw new Error('Child Turn Runtime Segment is missing.')
    if (segment.endedAt !== undefined) {
      if (segment.endedAt === input.endedAt) return
      throw new Error('Child Turn Runtime Segment completion is immutable.')
    }
    if (input.endedAt < segment.startedAt) throw new Error('Child Turn ends before it starts.')
    segment.endedAt = input.endedAt
  }

  admit(
    commands: DelegatedMessageCommand[],
    quarantined: boolean,
    input: AdmitMessageCommandInput
  ): 'admitted' | 'idempotent' {
    this.assertWritable(quarantined)
    const existing = commands.find(
      (candidate) =>
        candidate.sourcePrincipal === input.command.sourcePrincipal &&
        candidate.requestId === input.command.requestId
    )
    if (existing) {
      if (existing.canonicalDigest !== input.command.canonicalDigest) {
        throw new Error('Message request identity conflicts with an existing command.')
      }
      return 'idempotent'
    }
    commands.push(structuredClone(input.command))
    return 'admitted'
  }

  startDispatch(
    graph: PersistedConversationGraph,
    commands: DelegatedMessageCommand[],
    quarantined: boolean,
    input: StartMessageDispatchInput
  ): 'started' | 'terminal' | 'blocked' {
    this.assertWritable(quarantined)
    const index = commands.findIndex(({ messageId }) => messageId === input.messageId)
    const command = commands[index]
    if (!command) throw new Error('Message command is unavailable.')
    if (command.receipt.status !== 'queued') return 'terminal'
    const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
    const rootBranch = graph.branches.find(({ id }) => id === rootFrame?.activeBranchId)
    if (
      rootBranch?.id !== input.rootBranchId ||
      `${rootBranch.id}:${rootBranch.createdAt}` !== input.rootBranchRevision
    ) {
      return 'blocked'
    }
    const blocked = commands.some(
      (candidate) =>
        candidate.sourceFrameId === command.sourceFrameId &&
        candidate.targetFrameId === command.targetFrameId &&
        candidate.laneSequence < command.laneSequence &&
        (candidate.receipt.status === 'queued' ||
          (candidate.receipt.status === 'uncertain' && candidate.receipt.resolution === 'pending'))
    )
    if (blocked) return 'blocked'
    if (command.receipt.dispatchStartedAt !== undefined) return 'started'
    commands[index] = {
      ...command,
      receipt: {
        status: 'queued',
        dispatchStartedAt: input.dispatchStartedAt,
        dispatchEpoch: input.dispatchEpoch
      }
    }
    return 'started'
  }

  settle(
    commands: DelegatedMessageCommand[],
    quarantined: boolean,
    input: SettleMessageInput
  ): 'settled' | 'terminal' {
    this.assertWritable(quarantined)
    const index = commands.findIndex(({ messageId }) => messageId === input.messageId)
    const command = commands[index]
    if (!command) throw new Error('Message command is unavailable.')
    if (command.receipt.status !== 'queued') return 'terminal'
    if (input.receipt.status === 'queued') throw new Error('Message settlement must be terminal.')
    commands[index] = { ...command, receipt: structuredClone(input.receipt) }
    return 'settled'
  }

  acknowledge(
    commands: DelegatedMessageCommand[],
    quarantined: boolean,
    messageId: string
  ): 'acknowledged' | 'terminal' {
    this.assertWritable(quarantined)
    const index = commands.findIndex((candidate) => candidate.messageId === messageId)
    const command = commands[index]
    if (!command) throw new Error('Message command is unavailable.')
    if (command.receipt.status !== 'uncertain') return 'terminal'
    commands[index] = {
      ...command,
      receipt: { ...command.receipt, resolution: 'acknowledged' }
    }
    return 'acknowledged'
  }
}
