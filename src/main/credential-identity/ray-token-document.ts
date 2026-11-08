import { DurableJsonRecoveryBarrierError } from '@aipoch/durable-files'
import { z } from 'zod'
import { PROTECTED_STRING_PREFIX } from './protected-string-format'

export const rayTokenFileName = 'compute-ray-tokens.json'
export const rayTokenDocumentMaxBytes = 4 * 1024 * 1024
export const rayTokenEndpointMaxLength = 2048
export const rayTokenMaxEntries = 256
const entry = z.strictObject({
  endpoint: z.string().min(1).max(rayTokenEndpointMaxLength),
  sealed: z
    .string()
    .max(64 * 1024)
    .startsWith(PROTECTED_STRING_PREFIX)
    .refine((value) => {
      const base64 = value.slice(PROTECTED_STRING_PREFIX.length)
      return base64.length > 0 && Buffer.from(base64, 'base64').toString('base64') === base64
    })
})
const document = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(entry)
    .max(rayTokenMaxEntries)
    .refine((entries) => new Set(entries.map(({ endpoint }) => endpoint)).size === entries.length)
})
export type RayTokenEntry = z.infer<typeof entry>
export function decodeRayTokenDocument(contents: string): z.infer<typeof document> {
  try {
    return document.parse(JSON.parse(contents))
  } catch {
    // A corrupt or newer temp must not be discarded in favor of an older token.
    throw new DurableJsonRecoveryBarrierError('Invalid Ray Dashboard credential document.')
  }
}
