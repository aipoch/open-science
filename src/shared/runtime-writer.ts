import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
// Main elects one runtime projection writer; readers never author received runtime events.
export type RuntimeWriterLease = { token?: string; validForMs: number }
export const RUNTIME_WRITER_LEASE_MS = 20_000
export const RUNTIME_WRITER_LOST = 'SESSION_RUNTIME_WRITER_LOST'

export const runtimeWriterClaimContract = defineApplicationCommandContract(
  validationCodec(z.tuple([])),
  validationCodec(
    z
      .object({
        token: z.string().min(1).optional(),
        validForMs: z.number().int().nonnegative().max(RUNTIME_WRITER_LEASE_MS)
      })
      .strict()
  )
)
