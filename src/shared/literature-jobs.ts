import { z } from 'zod'
import {
  literatureJobRequestSchema,
  literatureJobsResultSchema
} from '@aipoch/literature-discovery/jobs'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
export const literatureJobsContract = defineApplicationCommandContract(
  validationCodec(z.tuple([literatureJobRequestSchema])),
  validationCodec(literatureJobsResultSchema)
)
