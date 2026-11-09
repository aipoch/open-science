import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

export const resourceRecordingStateSchema = z.enum([
  'unsupported',
  'off',
  'starting',
  'recording',
  'idle',
  'suspended',
  'stopping',
  'failed'
])
export type ResourceRecordingState = z.infer<typeof resourceRecordingStateSchema>
export const resourceRecordingContract = defineApplicationCommandContract(
  validationCodec(z.tuple([])),
  validationCodec(resourceRecordingStateSchema)
)
