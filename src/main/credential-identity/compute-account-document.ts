import { z } from 'zod'
import type { ComputeAccountProvider } from '../../shared/compute-accounts'
import { PROTECTED_STRING_PREFIX } from './protected-string-format'

export const computeAccountFileNames = {
  'hugging-face': 'compute-hugging-face-account.json',
  modal: 'compute-modal-account.json'
} as const satisfies Record<ComputeAccountProvider, string>

const schema = z.discriminatedUnion('source', [
  z.strictObject({ version: z.literal(1), source: z.literal('disabled') }),
  z.strictObject({ version: z.literal(1), source: z.literal('local') }),
  z.strictObject({
    version: z.literal(1),
    source: z.literal('managed'),
    sealed: z.string().startsWith(PROTECTED_STRING_PREFIX)
  })
])
export type ComputeAccountDocument = z.infer<typeof schema>
export function decodeComputeAccountDocument(contents: string): ComputeAccountDocument {
  return schema.parse(JSON.parse(contents))
}
