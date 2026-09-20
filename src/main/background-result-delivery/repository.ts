import type {
  BackgroundResultDelivery as PrismaBackgroundResultDelivery,
  PrismaClient
} from '@prisma/client'
import { Prisma } from '@prisma/client'

import type {
  BackgroundResultDelivery,
  BackgroundResultDeliveryState,
  BackgroundResultSourceRef
} from '../../shared/background-result-delivery'

type DeliveryClient = Pick<
  PrismaClient,
  'backgroundResultDelivery' | '$transaction' | '$executeRaw' | '$queryRaw'
>

const dateMs = (value: Date | null): number | undefined => value?.getTime()

const toDelivery = (row: PrismaBackgroundResultDelivery): BackgroundResultDelivery => ({
  id: row.id,
  sourceKind: row.sourceKind as BackgroundResultSourceRef['sourceKind'],
  sourceId: row.sourceId,
  projectId: row.projectId,
  sessionId: row.sessionId,
  ...(row.agentFrameId ? { agentFrameId: row.agentFrameId } : {}),
  state: row.state as BackgroundResultDeliveryState,
  attemptCount: row.attemptCount,
  ...(row.claimToken ? { claimToken: row.claimToken } : {}),
  ...(dateMs(row.claimExpiresAt) === undefined
    ? {}
    : { claimExpiresAt: dateMs(row.claimExpiresAt) }),
  ...(row.continuationMessageId ? { continuationMessageId: row.continuationMessageId } : {}),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

const assertOwnership = (
  row: PrismaBackgroundResultDelivery,
  source: BackgroundResultSourceRef
): void => {
  if (
    row.sourceKind !== source.sourceKind ||
    row.sourceId !== source.sourceId ||
    row.projectId !== source.projectId ||
    row.sessionId !== source.sessionId ||
    row.agentFrameId !== (source.agentFrameId ?? null)
  ) {
    throw new Error(`Conflicting delivery ownership for ${source.sourceKind} ${source.sourceId}.`)
  }
}

class BackgroundResultDeliveryRepository {
  constructor(private readonly getClient: () => Promise<DeliveryClient>) {}

  async register(source: BackgroundResultSourceRef): Promise<BackgroundResultDelivery> {
    const client = await this.getClient()
    const row = await client.backgroundResultDelivery.upsert({
      where: {
        sourceKind_sourceId: { sourceKind: source.sourceKind, sourceId: source.sourceId }
      },
      create: {
        id: `${source.sourceKind}:${source.sourceId}`,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        projectId: source.projectId,
        sessionId: source.sessionId,
        agentFrameId: source.agentFrameId,
        state: 'waiting-result'
      },
      update: {}
    })
    assertOwnership(row, source)
    return toDelivery(row)
  }

  async enqueue(source: BackgroundResultSourceRef): Promise<BackgroundResultDelivery | undefined> {
    const client = await this.getClient()
    if (source.sourceKind === 'local-run') {
      const admitted = await client.backgroundResultDelivery.upsert({
        where: {
          sourceKind_sourceId: { sourceKind: source.sourceKind, sourceId: source.sourceId }
        },
        create: {
          id: `${source.sourceKind}:${source.sourceId}`,
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
          projectId: source.projectId,
          sessionId: source.sessionId,
          agentFrameId: source.agentFrameId,
          state: 'pending'
        },
        update: {}
      })
      assertOwnership(admitted, source)
    }
    await client.backgroundResultDelivery.updateMany({
      where: {
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        projectId: source.projectId,
        sessionId: source.sessionId,
        agentFrameId: source.agentFrameId ?? null,
        state: 'waiting-result'
      },
      data: { state: 'pending' }
    })
    const row = await client.backgroundResultDelivery.findUnique({
      where: { sourceKind_sourceId: { sourceKind: source.sourceKind, sourceId: source.sourceId } }
    })
    if (!row) return undefined
    assertOwnership(row, source)
    return toDelivery(row)
  }

  async findBySource(
    source: BackgroundResultSourceRef
  ): Promise<BackgroundResultDelivery | undefined> {
    const client = await this.getClient()
    const row = await client.backgroundResultDelivery.findUnique({
      where: { sourceKind_sourceId: { sourceKind: source.sourceKind, sourceId: source.sourceId } }
    })
    if (!row) return undefined
    assertOwnership(row, source)
    return toDelivery(row)
  }

  async listContinuation(
    sessionId: string,
    continuationMessageId: string
  ): Promise<BackgroundResultDelivery[]> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.findMany({
        where: { sessionId, continuationMessageId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
    ).map(toDelivery)
  }

  async consumeContinuation(sessionId: string, continuationMessageId: string): Promise<number> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.updateMany({
        where: {
          sessionId,
          continuationMessageId,
          state: { in: ['pending', 'claimed', 'dispatching', 'needs-attention'] }
        },
        data: { state: 'consumed', claimToken: null, claimExpiresAt: null }
      })
    ).count
  }

  async acknowledgeObserved(
    source: BackgroundResultSourceRef
  ): Promise<Readonly<{ delivery: BackgroundResultDelivery; transitioned: boolean }>> {
    const client = await this.getClient()
    return client.$transaction(async (tx) => {
      const where = {
        sourceKind_sourceId: { sourceKind: source.sourceKind, sourceId: source.sourceId }
      }
      const existing = await tx.backgroundResultDelivery.findUnique({ where })
      if (!existing) {
        const created = await tx.backgroundResultDelivery.create({
          data: {
            id: `${source.sourceKind}:${source.sourceId}`,
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            projectId: source.projectId,
            sessionId: source.sessionId,
            agentFrameId: source.agentFrameId,
            state: 'consumed'
          }
        })
        return { delivery: toDelivery(created), transitioned: true }
      }
      assertOwnership(existing, source)
      const changed = await tx.backgroundResultDelivery.updateMany({
        where: {
          id: existing.id,
          state: { in: ['waiting-result', 'pending', 'claimed', 'needs-attention'] }
        },
        data: {
          state: 'consumed',
          claimToken: null,
          claimExpiresAt: null,
          continuationMessageId: null
        }
      })
      const row = await tx.backgroundResultDelivery.findUniqueOrThrow({
        where: { id: existing.id }
      })
      return { delivery: toDelivery(row), transitioned: changed.count === 1 }
    })
  }

  async hasDeliveryPath(
    sourceKind: BackgroundResultSourceRef['sourceKind'],
    sourceId: string
  ): Promise<boolean> {
    const client = await this.getClient()
    return (await client.backgroundResultDelivery.count({ where: { sourceKind, sourceId } })) > 0
  }

  async listWaiting(
    sourceKind?: BackgroundResultSourceRef['sourceKind']
  ): Promise<BackgroundResultDelivery[]> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.findMany({
        where: { ...(sourceKind ? { sourceKind } : {}), state: 'waiting-result' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
    ).map(toDelivery)
  }

  async listProjectVisible(projectId: string, limit = 200): Promise<BackgroundResultDelivery[]> {
    const client = await this.getClient()
    const take = Math.max(1, Math.min(limit, 201))
    return (
      await client.$queryRaw<PrismaBackgroundResultDelivery[]>(Prisma.sql`
        SELECT * FROM "BackgroundResultDelivery"
        WHERE "projectId" = ${projectId}
          AND "state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'needs-attention')
        ORDER BY "updatedAt" DESC, "id" ASC
        LIMIT ${take}
      `)
    ).map(toDelivery)
  }

  async listAwaitingAgent(sessionId: string): Promise<BackgroundResultDelivery[]> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.findMany({
        where: {
          sessionId,
          state: { in: ['pending', 'claimed', 'dispatching', 'needs-attention'] }
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
    ).map(toDelivery)
  }

  async listPendingSessionIds(): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.backgroundResultDelivery.findMany({
      where: { state: 'pending' },
      distinct: ['sessionId'],
      select: { sessionId: true },
      orderBy: { sessionId: 'asc' }
    })
    return rows.map(({ sessionId }) => sessionId)
  }

  async listSessionIdsForProject(projectId: string): Promise<string[]> {
    const client = await this.getClient()
    const rows = await client.backgroundResultDelivery.findMany({
      where: { projectId },
      distinct: ['sessionId'],
      select: { sessionId: true }
    })
    return rows.map(({ sessionId }) => sessionId)
  }

  async listOwnership(): Promise<
    Pick<BackgroundResultDelivery, 'id' | 'projectId' | 'sessionId'>[]
  > {
    const client = await this.getClient()
    return client.backgroundResultDelivery.findMany({
      select: { id: true, projectId: true, sessionId: true }
    })
  }

  async deleteIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0
    const client = await this.getClient()
    return (await client.backgroundResultDelivery.deleteMany({ where: { id: { in: [...ids] } } }))
      .count
  }

  async deleteSession(projectId: string, sessionId: string): Promise<number> {
    const client = await this.getClient()
    return (await client.backgroundResultDelivery.deleteMany({ where: { projectId, sessionId } }))
      .count
  }

  async deleteProject(projectId: string): Promise<number> {
    const client = await this.getClient()
    return (await client.backgroundResultDelivery.deleteMany({ where: { projectId } })).count
  }

  async find(id: string): Promise<BackgroundResultDelivery | undefined> {
    const client = await this.getClient()
    const row = await client.backgroundResultDelivery.findUnique({ where: { id } })
    return row ? toDelivery(row) : undefined
  }

  async recoverExpiredClaims(now = Date.now()): Promise<number> {
    const client = await this.getClient()
    return client.$executeRaw(Prisma.sql`
      UPDATE "BackgroundResultDelivery"
      SET "state" = 'pending', "claimToken" = NULL, "claimExpiresAt" = NULL,
          "updatedAt" = ${new Date(now)}
      WHERE "state" IN ('claimed', 'dispatching') AND "claimExpiresAt" <= ${new Date(now)}
    `)
  }

  async claimPending(
    sessionId: string,
    options: { token: string; expiresAt: number; limit: number; now?: number }
  ): Promise<BackgroundResultDelivery[]> {
    const client = await this.getClient()
    const now = options.now ?? Date.now()
    return client.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "BackgroundResultDelivery"
        SET "state" = 'pending', "claimToken" = NULL, "claimExpiresAt" = NULL,
            "updatedAt" = ${new Date(now)}
        WHERE "state" IN ('claimed', 'dispatching') AND "claimExpiresAt" <= ${new Date(now)}
      `)
      const oldest = await tx.backgroundResultDelivery.findFirst({
        where: { sessionId, state: 'pending' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
      if (!oldest) return []
      const candidates = await tx.backgroundResultDelivery.findMany({
        where: {
          sessionId,
          state: 'pending',
          continuationMessageId: oldest.continuationMessageId
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(oldest.continuationMessageId === null ? { take: Math.max(1, options.limit) } : {})
      })
      const ids = candidates.map(({ id }) => id)
      if (ids.length === 0) return []
      await tx.backgroundResultDelivery.updateMany({
        where: { id: { in: ids }, state: 'pending' },
        data: {
          state: 'claimed',
          claimToken: options.token,
          claimExpiresAt: new Date(options.expiresAt)
        }
      })
      return (
        await tx.backgroundResultDelivery.findMany({
          where: { id: { in: ids }, state: 'claimed', claimToken: options.token },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        })
      ).map(toDelivery)
    })
  }

  async prepareContinuation(
    ids: readonly string[],
    claimToken: string,
    continuationMessageId: string
  ): Promise<number> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.updateMany({
        where: {
          id: { in: [...ids] },
          state: 'claimed',
          claimToken,
          OR: [{ continuationMessageId: null }, { continuationMessageId }]
        },
        data: { continuationMessageId }
      })
    ).count
  }

  async beginDispatch(
    ids: readonly string[],
    claimToken: string,
    continuationMessageId: string
  ): Promise<number> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.updateMany({
        where: { id: { in: [...ids] }, state: 'claimed', claimToken, continuationMessageId },
        data: { state: 'dispatching' }
      })
    ).count
  }

  async releaseClaim(ids: readonly string[], claimToken: string): Promise<number> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.updateMany({
        where: { id: { in: [...ids] }, state: { in: ['claimed', 'dispatching'] }, claimToken },
        data: { state: 'pending', claimToken: null, claimExpiresAt: null }
      })
    ).count
  }

  async failClaim(
    ids: readonly string[],
    claimToken: string,
    maxAttempts: number
  ): Promise<'pending' | 'needs-attention'> {
    if (ids.length === 0) return 'pending'
    const client = await this.getClient()
    return client.$transaction(async (tx) => {
      const rows = await tx.backgroundResultDelivery.findMany({
        where: { id: { in: [...ids] }, state: { in: ['claimed', 'dispatching'] }, claimToken },
        select: { id: true, attemptCount: true }
      })
      let needsAttention = false
      for (const row of rows) {
        const nextAttempt = row.attemptCount + 1
        const state = nextAttempt >= maxAttempts ? 'needs-attention' : 'pending'
        if (state === 'needs-attention') needsAttention = true
        await tx.backgroundResultDelivery.update({
          where: { id: row.id },
          data: {
            attemptCount: nextAttempt,
            state,
            claimToken: null,
            claimExpiresAt: null
          }
        })
      }
      return needsAttention ? 'needs-attention' : 'pending'
    })
  }

  async markConsumed(
    ids: readonly string[],
    claimToken: string,
    continuationMessageId: string
  ): Promise<number> {
    const client = await this.getClient()
    return (
      await client.backgroundResultDelivery.updateMany({
        where: {
          id: { in: [...ids] },
          state: { in: ['claimed', 'dispatching'] },
          claimToken,
          continuationMessageId
        },
        data: { state: 'consumed', claimToken: null, claimExpiresAt: null }
      })
    ).count
  }

  async areConsumed(ids: readonly string[], sessionId: string): Promise<boolean> {
    if (ids.length === 0) return true
    const client = await this.getClient()
    return (
      (await client.backgroundResultDelivery.count({
        where: { id: { in: [...ids] }, sessionId, state: 'consumed' }
      })) === ids.length
    )
  }
}

export { BackgroundResultDeliveryRepository }
export type { DeliveryClient }
