import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

export const LITERATURE_OVERSIZED_REFERENCE = 'Literature reference exceeds the display budget: '
export function oversizedLiteratureReference(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : ''
  const start = message.indexOf(LITERATURE_OVERSIZED_REFERENCE)
  if (start < 0) return undefined
  const id = message.slice(start + LITERATURE_OVERSIZED_REFERENCE.length).trim()
  return id && id.length <= 512 ? id : undefined
}
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
