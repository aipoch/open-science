import { z } from 'zod'
import { bibliographicRecordSchema } from '@aipoch/literature-citations/contracts'

export const literatureRelatedProviderSchema = z.enum(['europe-pmc', 'opencitations'])
export const literatureOpenCitationsModeSchema = z.enum(['skg-if', 'index'])

function validOpenCitationsMode(value: { provider?: string; opencitationsMode?: string }): boolean {
  return value.opencitationsMode === undefined || value.provider === 'opencitations'
}
// Source identities retain their real namespaces instead of inventing IDs from metadata.
export const literatureRelatedPaperIdSchema = z.string().refine((value) => {
  if (/^opencitations:br\/\d{1,30}$/.test(value)) return true
  const match = /^europe-pmc:([A-Z]{2,12}):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(value)
  if (!match) return false
  return match[1] === 'MED'
    ? /^\d{1,20}$/.test(match[2])
    : match[1] === 'PMC'
      ? /^PMC\d{1,20}$/.test(match[2])
      : true
})

export const literatureRelatedRequestSchema = z
  .object({
    itemId: z.string().trim().min(1).max(256),
    expectedMetadataRevision: z.number().int().positive(),
    direction: z.enum(['references', 'citations']),
    provider: z.enum(['auto', 'europe-pmc', 'opencitations']).optional(),
    opencitationsMode: literatureOpenCitationsModeSchema.optional(),
    resolutionToken: z.string().uuid().optional(),
    seedPaperId: literatureRelatedPaperIdSchema.optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
  })
  .strict()
  .refine(validOpenCitationsMode, { message: 'OpenCitations mode requires its provider.' })
export const literatureRelatedRecordSchema = z
  .object({
    paperId: literatureRelatedPaperIdSchema,
    item: bibliographicRecordSchema
  })
  .strict()
export const literatureRelatedResultSchema = z
  .object({
    itemId: z.string(),
    metadataRevision: z.number().int().positive(),
    direction: z.enum(['references', 'citations']),
    state: z.enum(['ready', 'unavailable']),
    provider: literatureRelatedProviderSchema.optional(),
    opencitationsMode: literatureOpenCitationsModeSchema.optional(),
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
  .refine(validOpenCitationsMode, { message: 'OpenCitations mode requires its provider.' })
export type LiteratureRelatedRequest = z.infer<typeof literatureRelatedRequestSchema>
export type LiteratureRelatedResult = z.infer<typeof literatureRelatedResultSchema>
export type LiteratureRelatedRecord = z.infer<typeof literatureRelatedRecordSchema>

export type LiteratureRelatedProvider = z.infer<typeof literatureRelatedProviderSchema>
export type LiteratureOpenCitationsMode = z.infer<typeof literatureOpenCitationsModeSchema>
