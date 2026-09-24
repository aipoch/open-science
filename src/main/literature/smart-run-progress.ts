import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import {
  smartRunProgressSchema,
  type SmartRunProgress,
  type SmartRunProgressRow
} from '../../shared/literature-smart-collections'

const resultSchema = z.object({
  answer: z.object({
    verdict: z.enum(['match', 'no-match', 'uncertain']),
    model: z.string().optional()
  })
})

/** Read one coherent, bounded projection of committed work, without changing the run. */
export async function readSmartRunProgress(
  client: PrismaClient,
  collectionId: string,
  runId: string
): Promise<SmartRunProgress> {
  return client.$transaction(async (tx) => {
    const run = await tx.literatureSmartRun.findFirstOrThrow({
      where: { id: runId, collectionId },
      select: { state: true }
    })
    const grouped = await tx.$queryRaw<Array<{ outcome: string; count: bigint }>>`
      SELECT CASE
        WHEN state = 'pending' THEN 'pending'
        WHEN state = 'error' THEN 'error'
        WHEN state = 'done' AND json_valid(resultJson) THEN
          CASE
            WHEN json_extract(resultJson, '$.answer.model') = 'insufficient-evidence' THEN 'unavailable'
            WHEN json_extract(resultJson, '$.answer.verdict') = 'match' THEN 'match'
            WHEN json_extract(resultJson, '$.answer.verdict') = 'no-match' THEN 'noMatch'
            WHEN json_extract(resultJson, '$.answer.verdict') = 'uncertain' THEN 'review'
            ELSE 'unavailable'
          END
        ELSE 'unavailable'
      END AS outcome, COUNT(*) AS count
      FROM LiteratureSmartRunItem
      WHERE runId = ${runId} AND deferred = 0
      GROUP BY outcome
    `
    const counts: SmartRunProgress['counts'] = {
      match: 0,
      review: 0,
      noMatch: 0,
      pending: 0,
      error: 0,
      unavailable: 0
    }
    for (const row of grouped) {
      if (Object.hasOwn(counts, row.outcome))
        counts[row.outcome as keyof typeof counts] = Number(row.count)
    }
    const candidates = await tx.literatureSmartRunItem.findMany({
      where: { runId, deferred: false, state: 'pending' },
      orderBy: { itemId: 'asc' },
      take: 4
    })
    const recentIds = await tx.$queryRaw<Array<{ itemId: string }>>`
      WITH classified AS (
        SELECT itemId, evaluatedAt, CASE
          WHEN state = 'done' AND json_valid(resultJson) THEN
            CASE
              WHEN json_extract(resultJson, '$.answer.model') = 'insufficient-evidence' THEN 'unavailable'
              WHEN json_extract(resultJson, '$.answer.verdict') = 'match' THEN 'match'
              WHEN json_extract(resultJson, '$.answer.verdict') = 'no-match' THEN 'noMatch'
              WHEN json_extract(resultJson, '$.answer.verdict') = 'uncertain' THEN 'review'
              ELSE 'unavailable'
            END
          ELSE 'unavailable'
        END AS outcome
        FROM LiteratureSmartRunItem
        WHERE runId = ${runId} AND deferred = 0 AND state IN ('done', 'error')
      ), ranked AS (
        SELECT itemId, ROW_NUMBER() OVER (
          PARTITION BY outcome ORDER BY evaluatedAt DESC, itemId ASC
        ) AS position FROM classified
      )
      SELECT itemId FROM ranked WHERE position <= 6
    `
    const outcomes = await tx.literatureSmartRunItem.findMany({
      where: { runId, itemId: { in: recentIds.map((row) => row.itemId) } },
      orderBy: [{ evaluatedAt: 'desc' }, { itemId: 'asc' }],
      take: 24
    })
    const itemIds = [...candidates, ...outcomes].map((row) => row.itemId)
    const titles = new Map(
      (
        await tx.literatureItem.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, title: true }
        })
      ).map((item) => [item.id, item.title])
    )
    const overrides = new Map(
      (
        await tx.literatureSmartOverride.findMany({
          where: { collectionId, itemId: { in: itemIds } },
          select: { itemId: true, decision: true }
        })
      ).map((row) => [row.itemId, row.decision])
    )
    const project = (row: (typeof outcomes)[number]): SmartRunProgressRow => {
      let verdict: SmartRunProgressRow['verdict']
      if (row.state === 'done' && row.resultJson) {
        try {
          const result = resultSchema.safeParse(JSON.parse(row.resultJson))
          if (result.success && result.data.answer.model !== 'insufficient-evidence')
            verdict = result.data.answer.verdict
        } catch {
          // Older/incomplete run details stay unavailable; never infer them from current results.
        }
      }
      const override = overrides.get(row.itemId)
      return {
        id: row.itemId,
        title: titles.get(row.itemId) ?? null,
        state: smartRunProgressSchema.shape.candidates.element.shape.state.parse(row.state),
        ...(verdict ? { verdict } : {}),
        ...(row.evaluatedAt ? { evaluatedAt: row.evaluatedAt.getTime() } : {}),
        ...(override === 'include' || override === 'exclude' ? { override } : {})
      }
    }
    return smartRunProgressSchema.parse({
      runId,
      state: run.state,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      done: counts.match + counts.review + counts.noMatch + counts.unavailable + counts.error,
      counts,
      candidates: candidates.map(project),
      outcomes: outcomes.map(project)
    })
  })
}
