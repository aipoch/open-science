import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const requestSchema = z
  .object({
    itemId: z.string().min(1).max(512),
    offset: z.number().int().nonnegative().optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()
const resultSchema = z
  .object({
    chunk: z.string().max(262144),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    nextOffset: z.number().int().nonnegative().optional()
  })
  .strict()
export const literatureExportRecordContract = defineApplicationCommandContract(
  validationCodec(z.tuple([requestSchema])),
  validationCodec(resultSchema)
)
export type LiteratureExportRecordRequest = z.infer<typeof requestSchema>
export type LiteratureExportRecordResult = z.infer<typeof resultSchema>
