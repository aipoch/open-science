import { z } from 'zod'
import {
  smartRunProgressSchema,
  type SmartRunProgress,
  type SmartRunProgressRow
} from './contracts.js'
import type { ScreeningDatabase } from './ports.js'
const resultSchema = z.object({
  answer: z.object({
    verdict: z.enum(['match', 'no-match', 'uncertain']),
    model: z.string().optional()
  })
})
export async function readSmartRunProgress(
  client: ScreeningDatabase,
  collectionId: string,
  runId: string
): Promise<SmartRunProgress> {
  const data = await client.progress(collectionId, runId)
  const { counts, candidates, outcomes } = data
  const run = { state: data.state }
  const titles = new Map(data.titles.map((item) => [item.id, item.title]))
  const overrides = new Map(data.overrides.map((row) => [row.itemId, row.decision]))
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
}
