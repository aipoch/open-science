import { journalRequestSchema, journalResultSchema } from '@aipoch/journal-catalog/contracts'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
export const journalAttributesContract = defineApplicationCommandContract(
  validationCodec(z.tuple([journalRequestSchema])),
  validationCodec(journalResultSchema)
)
import { z } from 'zod'
