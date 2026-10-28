import { z } from 'zod'
import { getSupplementDoi, normalizeSupplementDoi } from './supplement-contracts.js'

// Publication checks use the same exact, unambiguous DOI identity as discovery.
export const getPublicationCheckDoi = getSupplementDoi
const doiSchema = z
  .string()
  .max(2048)
  .refine((value) => normalizeSupplementDoi(value) === value)

export const literaturePublicationCheckRequestSchema = z
  .object({
    mode: z.enum(['get', 'check']),
    itemId: z.string().trim().min(1).max(2048),
    expectedMetadataRevision: z.number().int().positive()
  })
  .strict()

export const literaturePublicationNoticeSchema = z
  .object({
    doi: doiSchema,
    type: z.string().trim().min(1).max(100),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    source: z.enum(['publisher', 'retraction-watch', 'crossref'])
  })
  .strict()

export const literaturePublicationCheckSnapshotSchema = z
  .object({
    doi: doiSchema,
    checkedAt: z.number().int().nonnegative(),
    notices: z.array(literaturePublicationNoticeSchema).max(100)
  })
  .strict()

export const literaturePublicationCheckResultSchema = z
  .object({
    itemId: z.string().trim().min(1).max(2048),
    metadataRevision: z.number().int().positive(),
    snapshot: literaturePublicationCheckSnapshotSchema.optional(),
    issue: z
      .enum([
        'doi-required',
        'reference-changed',
        'reference-unavailable',
        'unavailable',
        'rate-limited',
        'timeout',
        'response-invalid',
        'not-found'
      ])
      .optional()
  })
  .strict()

export type LiteraturePublicationCheckRequest = z.infer<
  typeof literaturePublicationCheckRequestSchema
>
export type LiteraturePublicationCheckResult = z.infer<
  typeof literaturePublicationCheckResultSchema
>
export type LiteraturePublicationCheckSnapshot = z.infer<
  typeof literaturePublicationCheckSnapshotSchema
>
export type LiteraturePublicationNotice = z.infer<typeof literaturePublicationNoticeSchema>
