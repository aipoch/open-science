import { z } from 'zod'
import { literatureOverviewRequestSchema } from './literature-overview'

// Conservative preview limit; increase only after latency and usage measurements.
export const OVERVIEW_BATCH_LIMIT = 5
export const OVERVIEW_BATCH_CONCURRENCY = 2
export const overviewBatchRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      entries: z.array(literatureOverviewRequestSchema).min(1).max(OVERVIEW_BATCH_LIMIT)
    })
    .strict(),
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({ action: z.enum(['advance', 'resume', 'retry', 'pause']), jobId: z.string().uuid() })
    .strict()
])
export const overviewBatchSchema = z
  .object({
    id: z.string().uuid(),
    paused: z.boolean(),
    rows: z
      .array(
        z
          .object({
            request: literatureOverviewRequestSchema,
            status: z.enum(['pending', 'running', 'succeeded', 'failed']),
            issue: z.string().optional()
          })
          .strict()
      )
      .min(1)
      .max(OVERVIEW_BATCH_LIMIT)
  })
  .strict()
export const overviewBatchResultSchema = overviewBatchSchema.nullable()
export type OverviewBatchRequest = z.infer<typeof overviewBatchRequestSchema>
export type OverviewBatch = z.infer<typeof overviewBatchSchema>
