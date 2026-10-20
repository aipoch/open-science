import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const request = z
  .object({ projectId: identity, sessionId: identity, operationId: identity })
  .strict()
const inspection = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1).max(512),
          kind: z.enum([
            'session',
            'invalid-session',
            'log',
            'database',
            'notebook',
            'environment',
            'sensitive-evidence',
            'sensitive-file'
          ]),
          name: z.string(),
          available: z.boolean(),
          sizeBytes: z.number().nonnegative().optional(),
          reason: z.string().optional()
        })
        .strict()
    ),
    error: z.string().optional()
  })
  .strict()
const result = z
  .object({
    status: z.enum(['exported', 'partial', 'cancelled', 'failed']),
    path: z.string().optional(),
    error: z.string().optional(),
    report: z.string().optional()
  })
  .strict()

export const sessionDiagnosticCommandContracts = {
  inspect: defineApplicationCommandContract(
    validationCodec(z.tuple([request])),
    validationCodec(inspection)
  ),
  export: defineApplicationCommandContract(
    validationCodec(
      z.tuple([
        request
          .extend({
            selectedItems: z.array(z.string().min(1).max(512)).max(1000),
            includeExecutionCode: z.boolean().optional()
          })
          .strict()
      ])
    ),
    validationCodec(result)
  ),
  cancel: defineApplicationCommandContract(
    validationCodec(z.tuple([z.object({ operationId: identity }).strict()])),
    validationCodec(z.void())
  )
}
