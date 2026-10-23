import { z } from 'zod'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'

export const literatureRelatedRequestSchema = z
  .object({
    itemId: z.string().trim().min(1).max(256),
    expectedMetadataRevision: z.number().int().positive(),
    direction: z.enum(['references', 'citations']),
    resolutionToken: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
  })
  .strict()
export const literatureRelatedRecordSchema = z
  .object({
    paperId: z.string().regex(/^[a-f0-9]{40}$/i),
    item: bibliographicRecordSchema
  })
  .strict()
export const literatureRelatedResultSchema = z
  .object({
    itemId: z.string(),
    metadataRevision: z.number().int().positive(),
    direction: z.enum(['references', 'citations']),
    state: z.enum(['ready', 'match-required', 'unavailable']),
    resolutionToken: z.string().uuid().optional(),
    seed: literatureRelatedRecordSchema.optional(),
    records: z.array(literatureRelatedRecordSchema).max(20),
    nextOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    issue: z
      .enum([
        'no-match',
        'reference-changed',
        'expired',
        'rate-limited',
        'authentication',
        'timeout',
        'unavailable',
        'response-invalid'
      ])
      .optional(),
    retryAt: z.number().int().nonnegative().optional(),
    omitted: z.number().int().nonnegative().optional()
  })
  .strict()
export type LiteratureRelatedRequest = z.infer<typeof literatureRelatedRequestSchema>
export type LiteratureRelatedResult = z.infer<typeof literatureRelatedResultSchema>
export type LiteratureRelatedRecord = z.infer<typeof literatureRelatedRecordSchema>
