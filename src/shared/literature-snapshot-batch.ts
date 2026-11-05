import { z } from 'zod'
import { literatureSnapshotRequestSchema } from './literature-snapshot'

// Conservative preview limit; increase only after latency and usage measurements.
export const SNAPSHOT_BATCH_LIMIT = 5
export const SNAPSHOT_BATCH_CONCURRENCY = 2
export const snapshotBatchRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      entries: z.array(literatureSnapshotRequestSchema).min(1).max(SNAPSHOT_BATCH_LIMIT)
    })
    .strict(),
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({ action: z.enum(['advance', 'resume', 'retry', 'pause']), jobId: z.string().uuid() })
    .strict()
])
export const snapshotBatchSchema = z
  .object({
    id: z.string().uuid(),
    paused: z.boolean(),
    rows: z
      .array(
        z
          .object({
            request: literatureSnapshotRequestSchema,
            status: z.enum(['pending', 'running', 'succeeded', 'failed']),
            issue: z.string().optional()
          })
          .strict()
      )
      .min(1)
      .max(SNAPSHOT_BATCH_LIMIT)
  })
  .strict()
export const snapshotBatchResultSchema = snapshotBatchSchema.nullable()
export type SnapshotBatchRequest = z.infer<typeof snapshotBatchRequestSchema>
export type SnapshotBatch = z.infer<typeof snapshotBatchSchema>
