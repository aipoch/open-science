import { literatureSourceInputSchema } from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { z } from 'zod'

export const literatureDiscoverySchema = z
  .object({
    item: literatureItemInputSchema,
    source: literatureSourceInputSchema
  })
  .strict()

export type LiteratureLibraryDiscovery = z.infer<typeof literatureDiscoverySchema>
