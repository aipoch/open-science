import { Prisma, type PrismaClient } from '@prisma/client'
import type { ScreeningStore, ScreeningDatabase, SmartScope } from '@aipoch/literature-screening'
import { LITERATURE_COLLECTION_NAME_CONFLICT } from '../../shared/literature'
import { saveSmartRuleVersion } from './smart-rule-history'
import { readSmartRunProgress } from './smart-run-progress'

type Client = PrismaClient | Prisma.TransactionClient
export async function screeningScope(
  client: Client,
  scope: SmartScope
): Promise<Prisma.LiteratureItemWhereInput | undefined> {
  const available = { deletedAt: null, mergedIntoItemId: null }
  if (scope.kind === 'library') return available
  if (scope.kind === 'collection') {
    const source = await client.literatureCollection.findUnique({
      where: { id: scope.id },
      include: { smart: true }
    })
    if (!source || source.smart) return undefined
    return { ...available, collections: { some: { collectionId: scope.id } } }
  }
  const project = await client.project.findFirst({ where: { id: scope.id, deletedAt: null } })
  if (!project || (await client.projectDeletionIntent.count({ where: { projectId: scope.id } })))
    return undefined
  return { ...available, projects: { some: { projectId: scope.id } } }
}

export function screeningStore(client: Client): ScreeningStore {
  const selection = (
    input: Parameters<ScreeningStore['findRun']>[0]
  ): Prisma.LiteratureSmartRunWhereInput => ({
    id: input.id,
    collectionId: input.collectionId,
    ...(input.states ? { state: { in: input.states } } : {}),
    ...(input.abandoned === false ? { abandonedAt: null } : {})
  })
  return {
    listCollections: (automaticOnly) =>
      client.literatureSmartCollection.findMany({
        where: automaticOnly ? { autoUpdate: true } : {},
        select: { collectionId: true, automaticPauseReason: true }
      }),
    definition: (collectionId) =>
      client.literatureSmartCollection.findUnique({
        where: { collectionId },
        include: { collection: true }
      }),
    scopeAvailable: async (scope) => Boolean(await screeningScope(client, scope)),
    sourceName: async (scope) =>
      scope.kind === 'library'
        ? ''
        : scope.kind === 'collection'
          ? ((
              await client.literatureCollection.findUnique({
                where: { id: scope.id },
                select: { name: true }
              })
            )?.name ?? '')
          : ((await client.project.findUnique({ where: { id: scope.id }, select: { name: true } }))
              ?.name ?? ''),
    papers: async (scope, scan = {}) => {
      const where = await screeningScope(client, scope)
      if (!where) return []
      const details = scan.details !== false
      const items = await client.literatureItem.findMany({
        where: {
          AND: [
            where,
            ...(scan.itemIds ? [{ id: { in: scan.itemIds } }] : []),
            ...(scan.projectId ? [{ projects: { some: { projectId: scan.projectId } } }] : [])
          ]
        },
        orderBy: { id: 'asc' },
        take: scan.limit,
        ...(scan.after ? { cursor: { id: scan.after }, skip: 1 } : {}),
        select: {
          id: true,
          title: true,
          abstract: true,
          smartAssessments: {
            where: { collectionId: scan.collectionId ?? '' },
            select: {
              ruleRevision: true,
              inputDigest: true,
              policyKey: true,
              model: true,
              verdict: true,
              evaluatedAt: details,
              probabilitiesJson: details,
              evidenceJson: details
            }
          },
          smartOverrides: {
            where: { collectionId: scan.collectionId ?? '' },
            select: { decision: true }
          }
        }
      })
      return items.map((item) => ({
        ...item,
        smartAssessments: item.smartAssessments.map((assessment) => ({
          ...assessment,
          evaluatedAt: assessment.evaluatedAt ?? new Date(0),
          probabilitiesJson: assessment.probabilitiesJson ?? '{}',
          evidenceJson: assessment.evidenceJson ?? null
        }))
      }))
    },
    paper: async (scope, id) => {
      const where = await screeningScope(client, scope)
      return where
        ? client.literatureItem.findFirst({
            where: { AND: [where, { id }] },
            select: { id: true, title: true, abstract: true }
          })
        : null
    },
    documents: async (itemIds) =>
      (
        await client.literatureItem.findMany({
          where: { id: { in: itemIds } },
          select: {
            id: true,
            attachments: {
              where: { kind: 'fullText' },
              orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
              take: 1,
              select: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
            }
          }
        })
      ).map((item) => ({ itemId: item.id, document: item.attachments[0]?.versions[0] ?? null })),
    ruleVersions: (collectionId, revisions) =>
      client.literatureSmartRuleRevision.findMany({
        where: { collectionId, revision: { in: revisions } }
      }),
    hasOutdatedRun: async (collectionId, revision) =>
      Boolean(
        await client.literatureSmartRun.findFirst({
          where: {
            collectionId,
            state: { in: ['queued', 'running'] },
            ruleRevision: { not: revision }
          },
          select: { id: true }
        })
      ),
    findRun: (input) => client.literatureSmartRun.findFirst({ where: selection(input) }),
    latestRuns: (collectionId, limit = 1) =>
      client.literatureSmartRun.findMany({
        where: { collectionId },
        orderBy: { createdAt: 'desc' },
        take: limit
      }),
    run: (id) =>
      client.literatureSmartRun.findUniqueOrThrow({ where: { id }, include: { rule: true } }),
    runItems: ({ runId, states, deferred, itemId, unfinished }) =>
      client.literatureSmartRunItem.findMany({
        where: {
          runId,
          itemId,
          deferred,
          ...(states || unfinished
            ? {
                state: {
                  ...(states ? { in: states } : {}),
                  ...(unfinished ? { not: 'done' } : {})
                }
              }
            : {})
        },
        orderBy: { itemId: 'asc' }
      }),
    history: (collectionId, itemId, offset) =>
      client.literatureSmartRunItem.findMany({
        where: { itemId, state: 'done', resultJson: { not: null }, run: { collectionId } },
        include: { run: { include: { rule: true } } },
        orderBy: [{ evaluatedAt: 'desc' }, { runId: 'desc' }],
        skip: offset,
        take: 21
      }),
    usage: async (runId) => {
      const sums = await client.classificationUsage.aggregate({
        where: { runId },
        _sum: { inputTokens: true, outputTokens: true }
      })
      const incomplete = await client.classificationUsage.count({
        where: { runId, usageIncomplete: true }
      })
      const scenarios = await client.classificationUsage.findMany({
        where: { runId },
        distinct: ['scenario'],
        select: { scenario: true }
      })
      return {
        inputTokens: Number(sums._sum.inputTokens ?? 0n),
        outputTokens: Number(sums._sum.outputTokens ?? 0n),
        incomplete: incomplete > 0,
        scenarios
      }
    },
    runCounts: async (runId) =>
      (
        await client.$queryRaw<
          { state: string; count: bigint }[]
        >`SELECT state,COUNT(*) AS count FROM LiteratureSmartRunItem WHERE runId=${runId} AND deferred=0 GROUP BY state`
      ).map((row) => ({ ...row, count: Number(row.count) })),
    runFailure: (runId) =>
      client.literatureSmartRunItem.findFirst({
        where: { runId, deferred: false, state: 'error' },
        orderBy: { itemId: 'asc' },
        select: { failure: true }
      }),
    createCollection: async (input) => {
      try {
        const last = await client.literatureCollection.findFirst({
          where: { parentId: null },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true }
        })
        const row = await client.literatureCollection.create({
          data: {
            name: input.name,
            nameKey: input.name.toLowerCase(),
            description: input.description,
            sortOrder: (last?.sortOrder ?? -1) + 1,
            smart: {
              create: {
                evidenceMode: input.evidenceMode,
                autoUpdate: input.autoUpdate,
                scopeKind: input.scope.kind,
                scopeId: input.scope.kind === 'library' ? null : input.scope.id
              }
            }
          }
        })
        await saveSmartRuleVersion(client, row.id)
        return row
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
        throw error
      }
    },
    createRun: ({ items, ...data }) =>
      client.literatureSmartRun.create({ data: { ...data, items: { create: items } } }),
    updateRun: async (id, data) => {
      await client.literatureSmartRun.update({ where: { id }, data })
    },
    updateRuns: async (input, data) =>
      (await client.literatureSmartRun.updateMany({ where: selection(input), data })).count,
    updateRunItems: async ({ runId, itemId, states, deferred }, data) => {
      if (itemId)
        await client.literatureSmartRunItem.update({
          where: { runId_itemId: { runId, itemId } },
          data
        })
      else
        await client.literatureSmartRunItem.updateMany({
          where: { runId, deferred, ...(states ? { state: { in: states } } : {}) },
          data
        })
    },
    updatePause: async (collectionId, expected, data) =>
      (
        await client.literatureSmartCollection.updateMany({
          where: { collectionId, ...expected },
          data
        })
      ).count,
    clearOverrides: async (collectionId, itemIds) => {
      await client.literatureSmartOverride.deleteMany({
        where: { collectionId, ...(itemIds ? { itemId: { in: itemIds } } : {}) }
      })
    },
    saveOverrides: async (collectionId, itemIds, decision, updatedAt) => {
      if (!itemIds.length) return
      await client.$executeRaw(Prisma.sql`INSERT INTO LiteratureSmartOverride (collectionId,itemId,decision,updatedAt)
        VALUES ${Prisma.join(itemIds.map((itemId) => Prisma.sql`(${collectionId},${itemId},${decision},${updatedAt})`))}
        ON CONFLICT(collectionId,itemId) DO UPDATE SET decision=excluded.decision,updatedAt=excluded.updatedAt`)
    },
    resolvedModel: async (collectionId, policyKey) =>
      (
        await client.literatureSmartAssessment.findFirst({
          where: { collectionId, policyKey, model: { not: 'insufficient-evidence' } },
          select: { model: true }
        })
      )?.model,
    invalidateAssessments: async (collectionId, policyKey, obsoleteKey) => {
      await client.literatureSmartAssessment.updateMany({
        where: { collectionId, policyKey },
        data: { policyKey: obsoleteKey }
      })
    },
    saveAssessment: async (collectionId, itemId, data) => {
      await client.literatureSmartAssessment.upsert({
        where: { collectionId_itemId: { collectionId, itemId } },
        create: { collectionId, itemId, ...data },
        update: data
      })
    }
  }
}

async function initializeScopeVersion(client: PrismaClient): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE IF NOT EXISTS SmartScopeVersion (version INTEGER NOT NULL)'
    )
    await tx.$executeRawUnsafe(
      'INSERT INTO SmartScopeVersion SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM SmartScopeVersion)'
    )
    // Fixed application identifiers only; no user input is interpolated into SQL.
    for (const table of [
      'LiteratureItem',
      'LiteratureCollection',
      'LiteratureCollectionItem',
      'LiteratureSmartCollection',
      'LiteratureSmartAssessment',
      'LiteratureSmartOverride',
      'LiteratureSmartRun',
      'LiteratureSmartRunItem',
      'LiteratureAttachment',
      'LiteratureAttachmentVersion',
      'ProjectLiterature',
      'Project',
      'ProjectDeletionIntent'
    ]) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        await tx.$executeRawUnsafe(`CREATE TEMP TRIGGER IF NOT EXISTS "SmartScope_${table}_${operation}"
            AFTER ${operation} ON main."${table}" BEGIN
            UPDATE SmartScopeVersion SET version = version + 1; END`)
      }
    }
  })
}

export function screeningDatabase(client: PrismaClient): ScreeningDatabase {
  let ready: Promise<void> | undefined
  return {
    ...screeningStore(client),
    transaction: (operation, options) =>
      client.$transaction((tx) => operation(screeningStore(tx)), options),
    progress: (collectionId, runId) => readSmartRunProgress(client, collectionId, runId),
    revision: async () => {
      ready ??= initializeScopeVersion(client).catch((error) => {
        ready = undefined
        throw error
      })
      await ready
      const [state] = await client.$queryRaw<
        { changes: bigint; version: bigint }[]
      >`SELECT SmartScopeVersion.version AS changes,data_version AS version FROM temp.SmartScopeVersion,pragma_data_version`
      return `${state.changes}:${state.version}`
    }
  }
}
