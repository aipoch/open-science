import { z } from 'zod'

export const bootstrapRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('runtime') }).strict(),
  z.object({ action: z.literal('codex-prepare') }).strict(),
  z.object({ action: z.literal('codex-complete') }).strict(),
  z
    .object({
      action: z.literal('provider'),
      key: z.string().trim().min(1).max(8192),
      model: z.string().trim().min(1).max(256)
    })
    .strict(),
  z.object({ action: z.literal('openalex'), key: z.string().trim().min(1).max(8192) }).strict()
])

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>
export type BootstrapResult =
  | { ok: true; providerId?: string; next?: { runtime?: string[]; provider?: string[] } }
  | {
      ok: false
      code:
        | 'invalid_request'
        | 'configuration_conflict'
        | 'runtime_unavailable'
        | 'credential_invalid'
        | 'bootstrap_failed'
    }

export class BootstrapError extends Error {
  constructor(readonly code: Exclude<BootstrapResult, { ok: true }>['code']) {
    super(code)
  }
}
