import type { Prisma, PrismaClient } from '@prisma/client'

import {
  earliestCurrentDelegatedAttemptStartedAt,
  hasAnswerableDelegatedQuestion,
  hasCurrentRunningDelegatedAttempt
} from '../../shared/delegated-work-projection'
import {
  isHiddenControlMessage,
  isHumanUserMessage,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSessionStatus,
  type SessionSummary,
  type SessionUsageProjection
} from '../../shared/session-persistence'

const PROJECTION_STATE_ID = 'session-projection'
const PROJECTION_VERSION = 3
const SESSION_NUMBER_SEQUENCE_ID = 'global'
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const MAX_SQLITE_INT = 2_147_483_647
const PERSISTED_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'waiting-for-user',
  'waiting-permission',
  'waiting-plan-approval',
  'error'
] satisfies readonly PersistedSessionStatus[])

type ProjectionClient = () => Promise<PrismaClient>

type SessionProjection = Readonly<{
  summary: Omit<SessionSummary, 'number'>
  turnUsage: Array<{
    messageId: string
    frameworkId: string | null
    providerId: string | null
    model: string | null
    completedAtMs: bigint
    inputTokens: bigint
    cacheTokens: bigint
    cachedReadTokens: bigint | null
    cachedWriteTokens: bigint | null
    outputTokens: bigint
    modelCallCount: number | null
    isRootFrame: boolean
  }>
  modelCalls: Array<{
    messageId: string
    callId: string
    callIndex: number
    sourceInvocationId: string | null
    frameworkId: string | null
    providerId: string | null
    backendId: string | null
    model: string | null
    inputTokens: bigint
    cacheTokens: bigint
    cachedReadTokens: bigint | null
    cachedWriteTokens: bigint | null
    outputTokens: bigint
    contextUsedTokens: bigint | null
    contextWindowSize: bigint | null
  }>
  sessionDetailsUsage: Array<{
    eventId: string
    source: 'session-details'
    frameworkId: string
    providerId: string | null
    model: string | null
    completedAtMs: bigint
    inputTokens: bigint
    cacheTokens: bigint
    cachedReadTokens: bigint | null
    cachedWriteTokens: bigint | null
    outputTokens: bigint
    modelCallCount: number | null
  }>
  runs: Array<{ messageId: string; createdAtMs: bigint }>
  artifactRefs: Array<{ artifactId: string; artifactCreatedAtMs: bigint | null }>
}>

const assertProjectionStorageShape = (projection: SessionProjection): void => {
  const assertText = (value: unknown, field: string): void => {
    if (typeof value !== 'string') {
      throw new Error(`Session projection ${field} must be a string.`)
    }
  }
  const assertNonEmptyText = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Session projection ${field} must be a non-empty string.`)
    }
  }
  const assertStatus = (value: unknown, field: string): void => {
    if (typeof value !== 'string' || !PERSISTED_SESSION_STATUSES.has(value)) {
      throw new Error(`Session projection ${field} must be a persisted Session status.`)
    }
  }
  const assertInt = (value: number, field: string): void => {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SQLITE_INT) {
      throw new Error(`Session projection ${field} must fit a non-negative SQLite Int.`)
    }
  }
  const assertSafeNumber = (value: number, field: string): void => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Session projection ${field} must be a non-negative safe integer.`)
    }
  }
  const assertBigInt = (value: bigint, field: string): void => {
    if (value < 0n || value > MAX_SAFE_INTEGER_BIGINT) {
      throw new Error(`Session projection ${field} must be a non-negative safe integer.`)
    }
  }
  const assertNullableNonEmptyText = (value: string | null, field: string): void => {
    if (value !== null) assertNonEmptyText(value, field)
  }
  const assertNullableBigInt = (value: bigint | null, field: string): void => {
    if (value !== null) assertBigInt(value, field)
  }
  const assertNullablePositiveBigInt = (value: bigint | null, field: string): void => {
    if (value !== null && (value <= 0n || value > MAX_SAFE_INTEGER_BIGINT)) {
      throw new Error(`Session projection ${field} must be a positive safe integer.`)
    }
  }
  const assertUnique = (values: string[], field: string): void => {
    if (new Set(values).size !== values.length) {
      throw new Error(`Session projection ${field} must be unique.`)
    }
  }

  for (const field of ['id', 'projectId'] as const) {
    assertNonEmptyText(projection.summary[field], field)
  }
  assertText(projection.summary.title, 'title')
  assertStatus(projection.summary.status, 'status')
  assertStatus(projection.summary.presentedStatus, 'presentedStatus')
  for (const field of ['activeMessageCount', 'artifactCount', 'filesRevision'] as const) {
    assertInt(projection.summary[field], field)
  }
  for (const field of ['revision', 'createdAt', 'updatedAt'] as const) {
    assertSafeNumber(projection.summary[field], field)
  }
  if (projection.summary.archivedAt !== undefined) {
    assertSafeNumber(projection.summary.archivedAt, 'archivedAt')
  }
  if (projection.summary.presentedActivityAt !== undefined) {
    assertSafeNumber(projection.summary.presentedActivityAt, 'presentedActivityAt')
  }

  for (const usage of projection.turnUsage) {
    assertNonEmptyText(usage.messageId, 'turnUsage.messageId')
    assertNullableNonEmptyText(usage.frameworkId, 'turnUsage.frameworkId')
    assertNullableNonEmptyText(usage.providerId, 'turnUsage.providerId')
    assertNullableNonEmptyText(usage.model, 'turnUsage.model')
    assertBigInt(usage.completedAtMs, 'turnUsage.completedAtMs')
    assertBigInt(usage.inputTokens, 'turnUsage.inputTokens')
    assertBigInt(usage.cacheTokens, 'turnUsage.cacheTokens')
    assertNullableBigInt(usage.cachedReadTokens, 'turnUsage.cachedReadTokens')
    assertNullableBigInt(usage.cachedWriteTokens, 'turnUsage.cachedWriteTokens')
    assertBigInt(usage.outputTokens, 'turnUsage.outputTokens')
    if (usage.modelCallCount !== null) assertInt(usage.modelCallCount, 'turnUsage.modelCallCount')
  }
  for (const usage of projection.sessionDetailsUsage) {
    assertNonEmptyText(usage.eventId, 'sessionDetailsUsage.eventId')
    assertNonEmptyText(usage.frameworkId, 'sessionDetailsUsage.frameworkId')
    assertNullableNonEmptyText(usage.providerId, 'sessionDetailsUsage.providerId')
    assertNullableNonEmptyText(usage.model, 'sessionDetailsUsage.model')
    assertBigInt(usage.completedAtMs, 'sessionDetailsUsage.completedAtMs')
    assertBigInt(usage.inputTokens, 'sessionDetailsUsage.inputTokens')
    assertBigInt(usage.cacheTokens, 'sessionDetailsUsage.cacheTokens')
    assertNullableBigInt(usage.cachedReadTokens, 'sessionDetailsUsage.cachedReadTokens')
    assertNullableBigInt(usage.cachedWriteTokens, 'sessionDetailsUsage.cachedWriteTokens')
    assertBigInt(usage.outputTokens, 'sessionDetailsUsage.outputTokens')
    if (usage.modelCallCount !== null) {
      assertInt(usage.modelCallCount, 'sessionDetailsUsage.modelCallCount')
      if (usage.modelCallCount === 0) {
        throw new Error('Session projection sessionDetailsUsage.modelCallCount must be positive.')
      }
    }
  }
  assertUnique(
    projection.turnUsage.map(({ messageId }) => messageId),
    'turnUsage.messageId'
  )
  for (const call of projection.modelCalls) {
    assertNonEmptyText(call.messageId, 'modelCall.messageId')
    assertNonEmptyText(call.callId, 'modelCall.callId')
    assertInt(call.callIndex, 'modelCall.callIndex')
    assertNullableNonEmptyText(call.sourceInvocationId, 'modelCall.sourceInvocationId')
    assertNullableNonEmptyText(call.frameworkId, 'modelCall.frameworkId')
    assertNullableNonEmptyText(call.providerId, 'modelCall.providerId')
    assertNullableNonEmptyText(call.backendId, 'modelCall.backendId')
    assertNullableNonEmptyText(call.model, 'modelCall.model')
    assertBigInt(call.inputTokens, 'modelCall.inputTokens')
    assertBigInt(call.cacheTokens, 'modelCall.cacheTokens')
    assertNullableBigInt(call.cachedReadTokens, 'modelCall.cachedReadTokens')
    assertNullableBigInt(call.cachedWriteTokens, 'modelCall.cachedWriteTokens')
    assertBigInt(call.outputTokens, 'modelCall.outputTokens')
    assertNullableBigInt(call.contextUsedTokens, 'modelCall.contextUsedTokens')
    assertNullablePositiveBigInt(call.contextWindowSize, 'modelCall.contextWindowSize')
  }
  assertUnique(
    projection.modelCalls.map(({ callId }) => callId),
    'modelCall.callId'
  )
  assertUnique(
    projection.modelCalls.map(({ messageId, callIndex }) => `${messageId}\0${callIndex}`),
    'modelCall.messageId/callIndex'
  )
  for (const run of projection.runs) {
    assertNonEmptyText(run.messageId, 'run.messageId')
    assertBigInt(run.createdAtMs, 'run.createdAtMs')
  }
  assertUnique(
    projection.runs.map(({ messageId }) => messageId),
    'run.messageId'
  )
  for (const artifact of projection.artifactRefs) {
    assertNonEmptyText(artifact.artifactId, 'artifactRef.artifactId')
    if (artifact.artifactCreatedAtMs !== null) {
      assertBigInt(artifact.artifactCreatedAtMs, 'artifactRef.artifactCreatedAtMs')
    }
  }
}

const finiteNonNegativeInteger = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0

const toBigInt = (value: number | undefined): bigint => BigInt(finiteNonNegativeInteger(value))

const toOptionalBigInt = (value: number | undefined): bigint | null =>
  value === undefined ? null : toBigInt(value)

const chunksOf = <Value>(values: readonly Value[], size: number): Value[][] => {
  const chunks: Value[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const presentedStatus = (session: PersistedChatSession): PersistedSessionStatus => {
  if (
    session.runtimeContext?.permission?.state === 'pending' ||
    session.status === 'waiting-permission'
  ) {
    return 'waiting-permission'
  }
  if (session.status === 'waiting-for-user') return 'waiting-for-user'
  if (session.status === 'waiting-plan-approval') {
    return 'waiting-plan-approval'
  }
  if (hasAnswerableDelegatedQuestion(session)) return 'waiting-for-user'
  if (
    session.status === 'running' ||
    (session.status.startsWith('waiting-') && session.activeRun !== undefined) ||
    hasCurrentRunningDelegatedAttempt(session)
  ) {
    return 'running'
  }
  return session.status.startsWith('waiting-') ? 'idle' : session.status
}

const projectionMessages = (
  session: PersistedChatSession
): ReadonlyArray<{
  message: PersistedChatMessage
  isRootFrame: boolean
  runtimeSegmentId?: string
}> => {
  const graph = session.conversationGraph
  return graph
    ? graph.messages.map((message) => ({
        message,
        isRootFrame: message.agentFrameId === graph.rootFrameId,
        ...(message.runtimeSegmentId ? { runtimeSegmentId: message.runtimeSegmentId } : {})
      }))
    : session.messages.map((message) => ({ message, isRootFrame: true }))
}

const hasPendingArtifact = (session: PersistedChatSession): boolean => {
  const pendingArtifactIds = new Set(
    (session.artifacts ?? [])
      .filter(
        (artifact) =>
          typeof artifact.path === 'string' && artifact.path.split(/[\\/]+/).includes('.pending')
      )
      .map(({ id }) => id)
  )
  return projectionMessages(session).some(({ message }) =>
    message.artifactIds?.some((artifactId) => pendingArtifactIds.has(artifactId))
  )
}

export const buildSessionProjection = (session: PersistedChatSession): SessionProjection => {
  const turnUsage: SessionProjection['turnUsage'][number][] = []
  const modelCalls: SessionProjection['modelCalls'][number][] = []
  const sessionDetailsUsage: SessionProjection['sessionDetailsUsage'][number][] = []
  const runs: SessionProjection['runs'][number][] = []
  const associatedArtifactCreatedAt = new Map<string, number>()
  const runtimeSegments = new Map(
    (session.conversationGraph?.runtimeSegments ?? []).map((segment) => [segment.id, segment])
  )
  const details = session.sessionDetailsGeneration
  if (
    details &&
    'completedAt' in details &&
    'frameworkId' in details &&
    details.frameworkId &&
    'usage' in details &&
    details.usage
  ) {
    sessionDetailsUsage.push({
      eventId: details.requestId,
      source: 'session-details',
      frameworkId: details.frameworkId,
      providerId: details.providerId || null,
      model: details.model || null,
      completedAtMs: toBigInt(details.completedAt),
      inputTokens: toBigInt(details.usage.inputTokens),
      cacheTokens: toBigInt(details.usage.cacheTokens),
      cachedReadTokens: toOptionalBigInt(details.usage.cachedReadTokens),
      cachedWriteTokens: toOptionalBigInt(details.usage.cachedWriteTokens),
      outputTokens: toBigInt(details.usage.outputTokens),
      modelCallCount:
        details.usage.turnCount === undefined || details.usage.turnCount <= 0
          ? null
          : finiteNonNegativeInteger(details.usage.turnCount)
    })
  }

  for (const { message, isRootFrame, runtimeSegmentId } of projectionMessages(session)) {
    const associationTimestamp = message.completedAt ?? message.createdAt
    for (const artifactId of message.artifactIds ?? []) {
      const current = associatedArtifactCreatedAt.get(artifactId)
      if (
        Number.isFinite(associationTimestamp) &&
        associationTimestamp >= 0 &&
        (current === undefined || associationTimestamp < current)
      ) {
        associatedArtifactCreatedAt.set(artifactId, associationTimestamp)
      }
    }

    if (
      isRootFrame &&
      isHumanUserMessage(message) &&
      !isHiddenControlMessage(message) &&
      !message.delegatedCallerSource
    ) {
      runs.push({
        messageId: message.id,
        createdAtMs: toBigInt(message.createdAt || session.createdAt)
      })
    }

    if (message.role !== 'agent' || !message.turnUsage) continue
    const runtimeSegment = runtimeSegmentId ? runtimeSegments.get(runtimeSegmentId) : undefined
    turnUsage.push({
      messageId: message.id,
      frameworkId: runtimeSegment?.frameworkId ?? session.agentFrameworkId ?? null,
      providerId: runtimeSegment?.providerId ?? null,
      model: runtimeSegment?.model ?? session.agentModel ?? null,
      completedAtMs: toBigInt(message.completedAt ?? message.updatedAt ?? message.createdAt),
      inputTokens: toBigInt(message.turnUsage.inputTokens),
      cacheTokens: toBigInt(message.turnUsage.cacheTokens),
      cachedReadTokens: toOptionalBigInt(message.turnUsage.cachedReadTokens),
      cachedWriteTokens: toOptionalBigInt(message.turnUsage.cachedWriteTokens),
      outputTokens: toBigInt(message.turnUsage.outputTokens),
      modelCallCount:
        message.turnUsage.turnCount === undefined
          ? null
          : finiteNonNegativeInteger(message.turnUsage.turnCount),
      isRootFrame
    })
    for (const call of message.modelCallUsage ?? []) {
      modelCalls.push({
        messageId: message.id,
        callId: call.id,
        callIndex: call.index,
        sourceInvocationId: call.sourceInvocationId ?? null,
        frameworkId: runtimeSegment?.frameworkId ?? session.agentFrameworkId ?? null,
        providerId: runtimeSegment?.providerId ?? null,
        backendId: runtimeSegment?.backendId ?? session.agentBackendId ?? null,
        model: runtimeSegment?.model ?? session.agentModel ?? null,
        inputTokens: toBigInt(call.inputTokens),
        cacheTokens: toBigInt(call.cacheTokens),
        cachedReadTokens: toOptionalBigInt(call.cachedReadTokens),
        cachedWriteTokens: toOptionalBigInt(call.cachedWriteTokens),
        outputTokens: toBigInt(call.outputTokens),
        contextUsedTokens: toOptionalBigInt(call.contextUsedTokens),
        contextWindowSize: toOptionalBigInt(call.contextWindowSize)
      })
    }
  }

  const artifactCreatedAt = new Map<string, bigint | null>()
  for (const artifact of session.artifacts ?? []) {
    const timestamp =
      artifact.createdAt !== undefined &&
      Number.isFinite(artifact.createdAt) &&
      artifact.createdAt >= 0
        ? toBigInt(artifact.createdAt)
        : associatedArtifactCreatedAt.has(artifact.id)
          ? toBigInt(associatedArtifactCreatedAt.get(artifact.id))
          : null
    if (!artifactCreatedAt.has(artifact.id) || timestamp !== null) {
      artifactCreatedAt.set(artifact.id, timestamp)
    }
  }
  const artifactRefs = [...artifactCreatedAt].map(([artifactId, artifactCreatedAtMs]) => ({
    artifactId,
    artifactCreatedAtMs
  }))
  const status = presentedStatus(session)
  const runningActivityAt = [
    session.status === 'running' ? session.activeRun?.startedAt : undefined,
    earliestCurrentDelegatedAttemptStartedAt(session)
  ].filter((value): value is number => value !== undefined)
  const presentedActivityAt =
    status === 'running' && runningActivityAt.length > 0
      ? Math.min(...runningActivityAt)
      : session.updatedAt

  return {
    summary: {
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      status: session.status,
      presentedStatus: status,
      pinned: session.pinned === true,
      ...(session.archivedAt !== undefined ? { archivedAt: session.archivedAt } : {}),
      revision: finiteNonNegativeInteger(session.revision),
      activeMessageCount: session.messages.length,
      artifactCount: artifactRefs.length,
      filesRevision: finiteNonNegativeInteger(session.filesRevision),
      createdAt: finiteNonNegativeInteger(session.createdAt),
      updatedAt: finiteNonNegativeInteger(session.updatedAt),
      presentedActivityAt: finiteNonNegativeInteger(presentedActivityAt),
      needsStartupRecovery:
        session.status === 'running' ||
        session.activeRun !== undefined ||
        hasCurrentRunningDelegatedAttempt(session) ||
        hasPendingArtifact(session)
    },
    turnUsage,
    modelCalls,
    sessionDetailsUsage,
    runs,
    artifactRefs
  }
}

export const assertSessionProjectionStorageShape = (session: PersistedChatSession): void => {
  assertProjectionStorageShape(buildSessionProjection(session))
}

const sessionData = (
  projection: SessionProjection,
  number: number
): Prisma.SessionUncheckedCreateInput => ({
  number,
  id: projection.summary.id,
  projectId: projection.summary.projectId,
  title: projection.summary.title,
  status: projection.summary.status,
  presentedStatus: projection.summary.presentedStatus,
  pinned: projection.summary.pinned,
  archivedAtMs:
    projection.summary.archivedAt === undefined ? null : toBigInt(projection.summary.archivedAt),
  revision: BigInt(projection.summary.revision),
  activeMessageCount: projection.summary.activeMessageCount,
  artifactCount: projection.summary.artifactCount,
  filesRevision: projection.summary.filesRevision,
  createdAtMs: BigInt(projection.summary.createdAt),
  updatedAtMs: BigInt(projection.summary.updatedAt),
  presentedActivityAtMs:
    projection.summary.presentedActivityAt === undefined
      ? null
      : BigInt(projection.summary.presentedActivityAt),
  needsStartupRecovery: projection.summary.needsStartupRecovery,
  sourceByteLength: null,
  sourceMtimeMs: null,
  deletedAtMs: null
})

const replaceChildren = async (
  tx: Prisma.TransactionClient,
  sessionId: string,
  projection: SessionProjection
): Promise<void> => {
  await tx.sessionTurnUsage.deleteMany({ where: { sessionId } })
  await tx.sessionAuxiliaryTurnUsage.deleteMany({
    where: { sessionId, source: 'session-details' }
  })
  await tx.sessionRun.deleteMany({ where: { sessionId } })
  await tx.sessionArtifactRef.deleteMany({ where: { sessionId } })
  if (projection.turnUsage.length > 0) {
    await tx.sessionTurnUsage.createMany({
      data: projection.turnUsage.map((usage) => ({ sessionId, ...usage }))
    })
  }
  if (projection.modelCalls.length > 0) {
    await tx.sessionModelCallUsage.createMany({
      data: projection.modelCalls.map((usage) => ({ sessionId, ...usage }))
    })
  }
  if (projection.sessionDetailsUsage.length > 0) {
    await tx.sessionAuxiliaryTurnUsage.createMany({
      data: projection.sessionDetailsUsage.map((usage) => ({ sessionId, ...usage }))
    })
  }
  if (projection.runs.length > 0) {
    await tx.sessionRun.createMany({ data: projection.runs.map((run) => ({ sessionId, ...run })) })
  }
  if (projection.artifactRefs.length > 0) {
    await tx.sessionArtifactRef.createMany({
      data: projection.artifactRefs.map((artifact) => ({ sessionId, ...artifact }))
    })
  }
}

const toSummary = (row: {
  number: number
  id: string
  projectId: string
  title: string
  status: string
  presentedStatus: string
  pinned: boolean
  archivedAtMs: bigint | null
  revision: bigint
  activeMessageCount: number
  artifactCount: number
  filesRevision: number
  createdAtMs: bigint
  updatedAtMs: bigint
  presentedActivityAtMs: bigint | null
  needsStartupRecovery: boolean
}): SessionSummary => ({
  number: row.number,
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  status: row.status as PersistedSessionStatus,
  presentedStatus: row.presentedStatus as PersistedSessionStatus,
  pinned: row.pinned,
  ...(row.archivedAtMs !== null ? { archivedAt: Number(row.archivedAtMs) } : {}),
  revision: Number(row.revision),
  activeMessageCount: row.activeMessageCount,
  artifactCount: row.artifactCount,
  filesRevision: row.filesRevision,
  createdAt: Number(row.createdAtMs),
  updatedAt: Number(row.updatedAtMs),
  ...(row.presentedActivityAtMs !== null
    ? { presentedActivityAt: Number(row.presentedActivityAtMs) }
    : {}),
  needsStartupRecovery: row.needsStartupRecovery
})

export class SessionProjectionRepository {
  constructor(private readonly client: ProjectionClient) {}

  async isReady(): Promise<boolean> {
    const client = await this.client()
    const [state, pendingCount] = await Promise.all([
      client.sessionProjectionState.findUnique({ where: { id: PROJECTION_STATE_ID } }),
      client.pendingSessionReconciliation.count()
    ])
    return state?.projectionVersion === PROJECTION_VERSION && pendingCount === 0
  }

  async isInitialized(): Promise<boolean> {
    const client = await this.client()
    const state = await client.sessionProjectionState.findUnique({
      where: { id: PROJECTION_STATE_ID }
    })
    return state?.projectionVersion === PROJECTION_VERSION
  }

  async pending(): Promise<
    Array<{ sessionId: string; projectId: string; operation: 'save' | 'delete' }>
  > {
    const client = await this.client()
    const pending = await client.pendingSessionReconciliation.findMany({
      select: { sessionId: true, projectId: true, operation: true },
      orderBy: { markedAt: 'asc' }
    })
    return pending.map((entry) => {
      if (entry.operation !== 'save' && entry.operation !== 'delete') {
        throw new Error('Pending Session reconciliation operation is invalid.')
      }
      return { ...entry, operation: entry.operation }
    })
  }

  async clearForRebuild(): Promise<void> {
    const client = await this.client()
    await client.$transaction([
      client.sessionProjectionState.deleteMany(),
      client.session.deleteMany({
        where: { deletedAtMs: null, project: { deletedAt: null } }
      }),
      client.pendingSessionReconciliation.deleteMany()
    ])
  }

  async numberAssignments(): Promise<Array<{ id: string; number: number }>> {
    const client = await this.client()
    return client.session.findMany({ select: { id: true, number: true } })
  }

  async prepareSave(session: PersistedChatSession): Promise<PersistedChatSession> {
    const client = await this.client()
    const projection = buildSessionProjection(session)
    assertProjectionStorageShape(projection)
    const number = await client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: session.projectId, deletedAt: null },
        select: { id: true }
      })
      if (!project) throw new Error('Cannot save a Session for a deleted Project.')
      const existing = await tx.session.findUnique({ where: { id: session.id } })
      if (existing && existing.deletedAtMs !== null)
        throw new Error('Cannot save a deleted Session.')
      if (existing && existing.projectId !== session.projectId) {
        throw new Error('Cannot move a Session to another Project.')
      }
      await tx.pendingSessionReconciliation.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, projectId: session.projectId, operation: 'save' },
        update: { projectId: session.projectId, operation: 'save', markedAt: new Date() }
      })
      if (existing) return existing.number
      const preferredNumber = session.number
      let number: number
      if (preferredNumber !== undefined) {
        const sequence = await tx.sessionNumberSequence.findUnique({
          where: { id: SESSION_NUMBER_SEQUENCE_ID }
        })
        const nextNumber = preferredNumber + 1
        if (!sequence) {
          await tx.sessionNumberSequence.create({
            data: { id: SESSION_NUMBER_SEQUENCE_ID, nextNumber }
          })
        } else if (sequence.nextNumber < nextNumber) {
          await tx.sessionNumberSequence.update({
            where: { id: SESSION_NUMBER_SEQUENCE_ID },
            data: { nextNumber }
          })
        }
        number = preferredNumber
      } else {
        const sequence = await tx.sessionNumberSequence.upsert({
          where: { id: SESSION_NUMBER_SEQUENCE_ID },
          create: { id: SESSION_NUMBER_SEQUENCE_ID, nextNumber: 2 },
          update: { nextNumber: { increment: 1 } }
        })
        number = sequence.nextNumber - 1
      }
      const created = await tx.session.create({ data: sessionData(projection, number) })
      return created.number
    })
    return session.number === number ? session : { ...session, number }
  }

  async commitSave(session: PersistedChatSession): Promise<void> {
    const number = session.number
    if (number === undefined) throw new Error('Session projection requires a number.')
    const projection = buildSessionProjection(session)
    assertProjectionStorageShape(projection)
    const client = await this.client()
    await client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: session.projectId, deletedAt: null },
        select: { id: true }
      })
      if (!project) throw new Error('Cannot save a Session for a deleted Project.')
      const existing = await tx.session.findUnique({ where: { id: session.id } })
      if (!existing || existing.deletedAtMs !== null) {
        throw new Error('Cannot save a deleted Session.')
      }
      if (existing.projectId !== session.projectId) {
        throw new Error('Cannot move a Session to another Project.')
      }
      await tx.session.update({
        where: { id: session.id },
        data: sessionData(projection, number)
      })
      await replaceChildren(tx, session.id, projection)
      await tx.pendingSessionReconciliation.deleteMany({ where: { sessionId: session.id } })
    })
  }

  // Replays a pending JSON write even after its Project has become an invisible tombstone. The
  // Session row and number were allocated when the pending marker was created, so reconciliation
  // updates only that existing identity and cannot create new authority for a deleted Project.
  async commitReconciliation(session: PersistedChatSession): Promise<void> {
    const projection = buildSessionProjection(session)
    assertProjectionStorageShape(projection)
    const client = await this.client()
    await client.$transaction(async (tx) => {
      const existing = await tx.session.findUnique({ where: { id: session.id } })
      if (!existing) throw new Error('Pending Session projection identity is missing.')
      if (existing.deletedAtMs !== null) {
        await tx.pendingSessionReconciliation.deleteMany({ where: { sessionId: session.id } })
        return
      }
      await tx.session.update({
        where: { id: session.id },
        data: sessionData(projection, session.number ?? existing.number)
      })
      await replaceChildren(tx, session.id, projection)
      await tx.pendingSessionReconciliation.deleteMany({ where: { sessionId: session.id } })
    })
  }

  async markPending(
    projectId: string,
    sessionId: string,
    operation: 'save' | 'delete' = 'save'
  ): Promise<void> {
    const client = await this.client()
    await client.$transaction(async (tx) => {
      if (operation === 'delete') {
        const existing = await tx.session.findUnique({
          where: { id: sessionId },
          select: { projectId: true }
        })
        if (existing && existing.projectId !== projectId) {
          throw new Error('Cannot delete a Session owned by another Project.')
        }
      }
      await tx.pendingSessionReconciliation.upsert({
        where: { sessionId },
        create: { sessionId, projectId, operation },
        update: { projectId, operation, markedAt: new Date() }
      })
    })
  }

  async commitDelete(projectId: string, sessionId: string): Promise<void> {
    const client = await this.client()
    await client.$transaction(async (tx) => {
      const existing = await tx.session.findUnique({
        where: { id: sessionId },
        select: { projectId: true }
      })
      if (existing && existing.projectId !== projectId) {
        throw new Error('Cannot delete a Session owned by another Project.')
      }
      if (!existing) {
        await tx.pendingSessionReconciliation.deleteMany({ where: { projectId, sessionId } })
        return
      }
      await tx.sessionTurnUsage.deleteMany({ where: { sessionId } })
      await tx.sessionAuxiliaryTurnUsage.deleteMany({ where: { sessionId } })
      await tx.sessionRun.deleteMany({ where: { sessionId } })
      await tx.sessionArtifactRef.deleteMany({ where: { sessionId } })
      await tx.session.updateMany({
        where: { id: sessionId, projectId, deletedAtMs: null },
        data: { deletedAtMs: BigInt(Date.now()) }
      })
      await tx.pendingSessionReconciliation.deleteMany({ where: { projectId, sessionId } })
    })
  }

  async replaceAll(sessions: readonly PersistedChatSession[]): Promise<void> {
    const client = await this.client()
    const deletedIds = new Set(
      (
        await client.session.findMany({
          where: { deletedAtMs: { not: null } },
          select: { id: true }
        })
      ).map(({ id }) => id)
    )
    const projected = sessions
      .filter(({ id }) => !deletedIds.has(id))
      .map((session) => {
        const number = session.number
        if (number === undefined) throw new Error('Backfilled Session is missing its number.')
        const projection = buildSessionProjection(session)
        assertProjectionStorageShape(projection)
        return { session: { ...session, number }, projection }
      })
    const turnUsage = projected.flatMap(({ session, projection }) =>
      projection.turnUsage.map((usage) => ({ sessionId: session.id, ...usage }))
    )
    const modelCalls = projected.flatMap(({ session, projection }) =>
      projection.modelCalls.map((usage) => ({ sessionId: session.id, ...usage }))
    )
    const sessionDetailsUsage = projected.flatMap(({ session, projection }) =>
      projection.sessionDetailsUsage.map((usage) => ({ sessionId: session.id, ...usage }))
    )
    const runs = projected.flatMap(({ session, projection }) =>
      projection.runs.map((run) => ({ sessionId: session.id, ...run }))
    )
    const artifactRefs = projected.flatMap(({ session, projection }) =>
      projection.artifactRefs.map((artifact) => ({ sessionId: session.id, ...artifact }))
    )
    const nextNumber =
      projected.reduce((maximum, { session }) => Math.max(maximum, session.number), 0) + 1
    const currentSequence = await client.sessionNumberSequence.findUnique({
      where: { id: SESSION_NUMBER_SEQUENCE_ID }
    })
    const liveSessionIds = projected.map(({ session }) => session.id)
    const writes: Prisma.PrismaPromise<unknown>[] = [
      client.session.deleteMany({
        where: {
          deletedAtMs: null,
          OR: [
            { project: { deletedAt: null } },
            ...(liveSessionIds.length > 0 ? [{ id: { in: liveSessionIds } }] : [])
          ]
        }
      }),
      ...(liveSessionIds.length > 0
        ? [
            client.sessionAuxiliaryTurnUsage.deleteMany({
              where: { sessionId: { in: liveSessionIds }, source: 'session-details' }
            })
          ]
        : [])
    ]
    for (const chunk of chunksOf(projected, 40)) {
      writes.push(
        client.session.createMany({
          data: chunk.map(({ session, projection }) => sessionData(projection, session.number))
        })
      )
    }
    for (const chunk of chunksOf(turnUsage, 100)) {
      writes.push(client.sessionTurnUsage.createMany({ data: chunk }))
    }
    for (const chunk of chunksOf(modelCalls, 100)) {
      writes.push(client.sessionModelCallUsage.createMany({ data: chunk }))
    }
    for (const chunk of chunksOf(sessionDetailsUsage, 100)) {
      writes.push(client.sessionAuxiliaryTurnUsage.createMany({ data: chunk }))
    }
    for (const chunk of chunksOf(runs, 200)) {
      writes.push(client.sessionRun.createMany({ data: chunk }))
    }
    for (const chunk of chunksOf(artifactRefs, 200)) {
      writes.push(client.sessionArtifactRef.createMany({ data: chunk }))
    }
    writes.push(
      client.sessionNumberSequence.upsert({
        where: { id: SESSION_NUMBER_SEQUENCE_ID },
        create: { id: SESSION_NUMBER_SEQUENCE_ID, nextNumber },
        update: { nextNumber: Math.max(currentSequence?.nextNumber ?? 1, nextNumber) }
      }),
      client.pendingSessionReconciliation.deleteMany(),
      client.sessionProjectionState.upsert({
        where: { id: PROJECTION_STATE_ID },
        create: {
          id: PROJECTION_STATE_ID,
          projectionVersion: PROJECTION_VERSION,
          completedAt: new Date()
        },
        update: { projectionVersion: PROJECTION_VERSION, completedAt: new Date() }
      })
    )
    await client.$transaction(writes)
  }

  async list(): Promise<SessionSummary[]> {
    const client = await this.client()
    return (
      await client.session.findMany({
        where: { deletedAtMs: null, project: { deletedAt: null } },
        orderBy: [{ updatedAtMs: 'desc' }, { id: 'asc' }]
      })
    ).map(toSummary)
  }

  async usage(): Promise<SessionUsageProjection> {
    const client = await this.client()
    const [projects, sessions, usage, auxiliaryUsage, runs, artifacts] = await client.$transaction([
      client.project.findMany({ select: { createdAt: true } }),
      client.session.findMany({
        where: { deletedAtMs: null },
        select: { id: true, createdAtMs: true }
      }),
      client.sessionTurnUsage.findMany({ where: { session: { deletedAtMs: null } } }),
      client.sessionAuxiliaryTurnUsage.findMany(),
      client.sessionRun.findMany({
        where: { session: { deletedAtMs: null } },
        select: { createdAtMs: true }
      }),
      client.sessionArtifactRef.findMany({
        where: { session: { deletedAtMs: null } },
        select: { artifactId: true, artifactCreatedAtMs: true }
      })
    ])
    const liveSessionIds = new Set(sessions.map(({ id }) => id))
    const artifactCreatedAt = new Map<string, number | undefined>()
    for (const artifact of artifacts) {
      const timestamp =
        artifact.artifactCreatedAtMs === null ? undefined : Number(artifact.artifactCreatedAtMs)
      const current = artifactCreatedAt.get(artifact.artifactId)
      if (current === undefined || (timestamp !== undefined && timestamp < current)) {
        artifactCreatedAt.set(artifact.artifactId, timestamp)
      }
    }
    return {
      projectCreatedAt: projects.map(({ createdAt }) => createdAt.getTime()),
      sessionCreatedAt: sessions.map(({ createdAtMs }) => Number(createdAtMs)),
      artifactCreatedAt: [...artifactCreatedAt.values()].filter(
        (timestamp): timestamp is number => timestamp !== undefined
      ),
      runsAt: runs.map(({ createdAtMs }) => Number(createdAtMs)),
      usageEvents: [
        ...usage.map((event) => ({
          timestamp: Number(event.completedAtMs),
          inputTokens: Number(event.inputTokens),
          cacheTokens: Number(event.cacheTokens),
          outputTokens: Number(event.outputTokens),
          rootRunUsage: event.isRootFrame
        })),
        ...auxiliaryUsage.flatMap((event) =>
          liveSessionIds.has(event.sessionId)
            ? [
                {
                  timestamp: Number(event.completedAtMs),
                  inputTokens: Number(event.inputTokens),
                  cacheTokens: Number(event.cacheTokens),
                  outputTokens: Number(event.outputTokens),
                  rootRunUsage: false
                }
              ]
            : []
        )
      ],
      totalArtifacts: artifactCreatedAt.size
    }
  }
}
