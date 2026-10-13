import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { z } from 'zod'

export const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)

export const packageLiteratureSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            itemId: identity,
            metadataRevision: z.number().int().positive(),
            item: literatureItemInputSchema
          })
          .strict()
      )
      .max(10000),
    attachments: z
      .array(z.object({ versionId: identity, attachmentId: identity, itemId: identity }).strict())
      .max(10000)
  })
  .strict()

export type PackageLiterature = z.infer<typeof packageLiteratureSchema>
