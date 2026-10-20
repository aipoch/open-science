import { z } from 'zod'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'

// Message and artifact snapshots need item validation without catalog workflow contracts.
export const literatureItemInputSchema = bibliographicRecordSchema
  .extend({
    rating: z.number().int().min(0).max(5).optional(),
    personalNote: z.string().trim().max(10_000).optional()
  })
  .strict()

export type LiteratureItemInput = z.infer<typeof literatureItemInputSchema>
