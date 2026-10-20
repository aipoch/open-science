import { z } from 'zod'
import { bibliographicRecordSchema } from './contracts.js'
export const citationInputSchema = z
  .object({
    citationId: z.string().trim().min(1).max(128),
    itemId: z.string().trim().min(1).max(512),
    locator: z
      .object({
        label: z.enum(['page', 'chapter', 'section', 'figure', 'table', 'paragraph']),
        value: z.string().trim().min(1).max(128)
      })
      .strict()
      .optional(),
    prefix: z.string().max(512).optional(),
    suffix: z.string().max(512).optional(),
    suppressAuthor: z.boolean().optional()
  })
  .strict()
export const citationRequestSchema = z
  .object({
    styleId: z.string().trim().min(1).max(256).default('apa'),
    locale: z.string().trim().min(2).max(32).default('en-US'),
    citations: z.array(citationInputSchema).min(1).max(200)
  })
  .strict()
  .superRefine(({ citations }, context) => {
    const ids = new Set<string>()
    for (const [index, citation] of citations.entries()) {
      if (ids.has(citation.citationId))
        context.addIssue({
          code: 'custom',
          message: 'Citation ids must be unique.',
          path: ['citations', index, 'citationId']
        })
      ids.add(citation.citationId)
    }
  })
export const citationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  styleId: z.string().trim().min(1).max(256),
  locale: z.string().trim().min(2).max(32),
  references: z
    .array(
      z
        .object({
          itemId: z.string().trim().min(1).max(512),
          metadataRevision: z.number().int().positive(),
          item: bibliographicRecordSchema.strip()
        })
        .strict()
    )
    .min(1)
    .max(200),
  citations: z
    .array(citationInputSchema.extend({ metadataRevision: z.number().int().positive() }))
    .min(1)
    .max(200)
})
export const citationSidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
    literature: citationRequestSchema
  })
  .strict()
export type CitationInput = z.infer<typeof citationInputSchema>
export type CitationManifest = z.infer<typeof citationManifestSchema>
export type CitationSidecar = z.infer<typeof citationSidecarSchema>
export type CitationDocumentRecord = {
  id: string
  metadataRevision: number
  item: z.infer<typeof bibliographicRecordSchema>
}
