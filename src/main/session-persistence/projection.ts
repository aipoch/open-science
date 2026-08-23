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
const PROJECTION_VERSION = 1
const SESSION_NUMBER_SEQUENCE_ID = 'global'

type ProjectionClient = () => Promise<PrismaClient>

type SessionProjection = Readonly<{
  summary: Omit<SessionSummary, 'number'>
  turnUsage: Array<{
    messageId: string
    completedAtMs: bigint
    inputTokens: bigint
    cacheTokens: bigint
    outputTokens: bigint
    isRootFrame: boolean
  }>
  runs: Array<{ messageId: string; createdAtMs: bigint }>
  artifactRefs: Array<{ artifactId: string; artifactCreatedAtMs: bigint | null }>
}>

const finiteNonNegativeInteger = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0

const toBigInt = (value: number | undefined): bigint => BigInt(finiteNonNegativeInteger(value))

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
): ReadonlyArray<{ message: PersistedChatMessage; isRootFrame: boolean }> => {
  const graph = session.conversationGraph
  return graph
    ? graph.messages.map((message) => ({
        message,
        isRootFrame: message.agentFrameId === graph.rootFrameId
      }))
    : session.messages.map((message) => ({ message, isRootFrame: true }))
}

export const buildSessionProjection = (session: PersistedChatSession): SessionProjection => {
  const turnUsage: SessionProjection['turnUsage'][number][] = []
  const runs: SessionProjection['runs'][number][] = []
  const associatedArtifactCreatedAt = new Map<string, number>()

  for (const { message, isRootFrame } of projectionMessages(session)) {
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
    turnUsage.push({
      messageId: message.id,
      completedAtMs: toBigInt(message.completedAt ?? message.updatedAt ?? message.createdAt),
      inputTokens: toBigInt(message.turnUsage.inputTokens),
      cacheTokens: toBigInt(message.turnUsage.cacheTokens),
      outputTokens: toBigInt(message.turnUsage.outputTokens),
      isRootFrame
    })
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
        hasCurrentRunningDelegatedAttempt(session)
    },
    turnUsage,
    runs,
    artifactRefs
  }
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
  await tx.sessionRun.deleteMany({ where: { sessionId } })
  await tx.sessionArtifactRef.deleteMany({ where: { sessionId } })
  if (projection.turnUsage.length > 0) {
    await tx.sessionTurnUsage.createMany({
      data: projection.turnUsage.map((usage) => ({ sessionId, ...usage }))
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

  async pending(): Promise<Array<{ sessionId: string; projectId: string }>> {
    const client = await this.client()
    return client.pendingSessionReconciliation.findMany({
      select: { sessionId: true, projectId: true },
      orderBy: { markedAt: 'asc' }
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

  async prepareSave(session: PersistedChatSession): Promise<PersistedChatSession> {
    const client = await this.client()
    const projection = buildSessionProjection(session)
    const number = await client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: session.projectId, deletedAt: null },
        select: { id: true }
      })
      if (!project) throw new Error('Cannot save a Session for a deleted Project.')
      await tx.pendingSessionReconciliation.upsert({
        where: { sessionId: session.id },
        create: { sessionId: session.id, projectId: session.projectId },
        update: { projectId: session.projectId, markedAt: new Date() }
      })
      const existing = await tx.session.findUnique({ where: { id: session.id } })
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
    const client = await this.client()
    const projection = buildSessionProjection(session)
    await client.$transaction(async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: session.projectId, deletedAt: null },
        select: { id: true }
      })
      if (!project) throw new Error('Cannot save a Session for a deleted Project.')
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
    const client = await this.client()
    const projection = buildSessionProjection(session)
    await client.$transaction(async (tx) => {
      const existing = await tx.session.findUnique({ where: { id: session.id } })
      if (!existing) throw new Error('Pending Session projection identity is missing.')
      await tx.session.update({
        where: { id: session.id },
        data: sessionData(projection, session.number ?? existing.number)
      })
      await replaceChildren(tx, session.id, projection)
      await tx.pendingSessionReconciliation.deleteMany({ where: { sessionId: session.id } })
    })
  }

  async markPending(projectId: string, sessionId: string): Promise<void> {
    const client = await this.client()
    await client.pendingSessionReconciliation.upsert({
      where: { sessionId },
      create: { sessionId, projectId },
      update: { projectId, markedAt: new Date() }
    })
  }

  async commitDelete(sessionId: string): Promise<void> {
    const client = await this.client()
    await client.$transaction(async (tx) => {
      await tx.sessionTurnUsage.deleteMany({ where: { sessionId } })
      await tx.sessionRun.deleteMany({ where: { sessionId } })
      await tx.sessionArtifactRef.deleteMany({ where: { sessionId } })
      await tx.session.updateMany({
        where: { id: sessionId, deletedAtMs: null },
        data: { deletedAtMs: BigInt(Date.now()) }
      })
      await tx.pendingSessionReconciliation.deleteMany({ where: { sessionId } })
    })
  }

  async replaceAll(sessions: readonly PersistedChatSession[]): Promise<void> {
    const client = await this.client()
    const projected = sessions.map((session) => {
      const number = session.number
      if (number === undefined) throw new Error('Backfilled Session is missing its number.')
      return { session: { ...session, number }, projection: buildSessionProjection(session) }
    })
    const turnUsage = projected.flatMap(({ session, projection }) =>
      projection.turnUsage.map((usage) => ({ sessionId: session.id, ...usage }))
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
          OR: [
            { deletedAtMs: null, project: { deletedAt: null } },
            ...(liveSessionIds.length > 0 ? [{ id: { in: liveSessionIds } }] : [])
          ]
        }
      })
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
    const [projects, sessions, usage, runs, artifacts] = await client.$transaction([
      client.project.findMany({ select: { createdAt: true } }),
      client.session.findMany({
        where: { deletedAtMs: null },
        select: { createdAtMs: true }
      }),
      client.sessionTurnUsage.findMany({ where: { session: { deletedAtMs: null } } }),
      client.sessionRun.findMany({
        where: { session: { deletedAtMs: null } },
        select: { createdAtMs: true }
      }),
      client.sessionArtifactRef.findMany({
        where: { session: { deletedAtMs: null } },
        select: { artifactId: true, artifactCreatedAtMs: true }
      })
    ])
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
      usageEvents: usage.map((event) => ({
        timestamp: Number(event.completedAtMs),
        inputTokens: Number(event.inputTokens),
        cacheTokens: Number(event.cacheTokens),
        outputTokens: Number(event.outputTokens),
        rootRunUsage: event.isRootFrame
      })),
      totalArtifacts: artifactCreatedAt.size
    }
  }
}
