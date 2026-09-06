import { z } from 'zod'
import {
  literatureFullTextCandidateSchema,
  literatureFullTextProgressSchema,
  literatureItemViewSchema,
  literatureMetadataCompletionResultSchema
} from './literature'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const id = z.string().trim().min(1).max(512)
export const literatureJobRowSchema = z
  .object({
    id,
    item: literatureItemViewSchema.optional(),
    status: z.enum(['pending', 'searching', 'ready', 'skipped', 'error', 'saving', 'done']),
    message: z.string().optional(),
    notices: z.array(z.string()).max(20).optional(),
    checked: z.boolean(),
    metadata: literatureMetadataCompletionResultSchema.optional(),
    candidates: z.array(literatureFullTextCandidateSchema).max(10).optional(),
    candidateId: id.optional()
  })
  .strict()
export const literatureJobSchema = z
  .object({
    id,
    mode: z.enum(['metadata', 'full-text']),
    phase: z.enum(['search', 'apply']),
    phaseItemIds: z.array(id).max(1000).optional(),
    state: z.enum(['queued', 'running', 'pausing', 'paused', 'review', 'completed']),
    rows: z.array(literatureJobRowSchema).min(1).max(1000),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    progress: z.object({ itemId: id, value: literatureFullTextProgressSchema }).optional()
  })
  .strict()
export const literatureJobRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z
    .object({
      action: z.literal('create'),
      mode: z.enum(['metadata', 'full-text']),
      itemIds: z.array(id).min(1).max(1000),
      requestId: z.string().uuid()
    })
    .strict(),
  z
    .object({
      action: z.enum(['get', 'pause', 'resume', 'retry', 'remove']),
      ifUpdatedAt: z.number().finite().optional(),
      jobId: z.string().uuid()
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      jobId: z.string().uuid(),
      selections: z
        .array(z.object({ itemId: id, checked: z.boolean(), candidateId: id.optional() }).strict())
        .min(1)
        .max(1000)
    })
    .strict(),
  z
    .object({
      action: z.literal('apply'),
      jobId: z.string().uuid(),
      selections: z
        .array(z.object({ itemId: id, candidateId: id.optional() }).strict())
        .min(1)
        .max(1000)
    })
    .strict()
])
export const literatureJobsContract = defineApplicationCommandContract(
  validationCodec(z.tuple([literatureJobRequestSchema])),
  validationCodec(
    z
      .object({
        jobs: z.array(literatureJobSchema).max(50),
        progress: literatureJobSchema.shape.progress.optional(),
        summaries: z
          .array(
            literatureJobSchema.omit({ rows: true, progress: true }).extend({
              total: z.number(),
              checked: z.number(),
              ready: z.number(),
              done: z.number(),
              failed: z.number(),
              processed: z.number().optional(),
              phaseTotal: z.number().optional(),
              completedItemIds: z.array(id).optional()
            })
          )
          .max(50)
          .optional()
      })
      .strict()
  )
)
export type LiteratureJob = z.infer<typeof literatureJobSchema>
export type LiteratureJobRow = z.infer<typeof literatureJobRowSchema>
export type LiteratureJobRequest = z.infer<typeof literatureJobRequestSchema>
export type LiteratureJobSummary = Omit<LiteratureJob, 'rows' | 'progress'> & {
  total: number
  checked: number
  ready: number
  done: number
  failed: number
  processed?: number
  phaseTotal?: number
  completedItemIds?: string[]
}
export type LiteratureJobsResult = {
  jobs: LiteratureJob[]
  summaries?: LiteratureJobSummary[]
  progress?: LiteratureJob['progress']
}

export function literatureJobProgress(job: LiteratureJob): {
  processed: number
  phaseTotal: number
} {
  const selected = job.phaseItemIds ? new Set(job.phaseItemIds) : undefined
  const rows =
    job.phase === 'search'
      ? job.rows
      : selected
        ? job.rows.filter((row) => selected.has(row.id))
        : job.rows.filter(
            (row) => row.checked && ['ready', 'saving', 'done', 'error'].includes(row.status)
          )
  return {
    phaseTotal: rows.length,
    processed: rows.filter((row) =>
      job.phase === 'search'
        ? !['pending', 'searching'].includes(row.status)
        : ['done', 'error', 'skipped'].includes(row.status)
    ).length
  }
}
