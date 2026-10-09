import { z } from 'zod'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import {
  MAX_MANAGED_INLINE_BINARY_BYTES,
  MAX_MANAGED_INLINE_BASE64_CHARACTERS,
  isCanonicalManagedInlineBase64,
  type ManagedExecutionOutput
} from './managed-execution-output'
import type { ManagedOutputPublication } from './managed-output-publication'

const schema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !/[\\/]/.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32)
      ),
    contentType: z.string().min(1).max(256).optional(),
    source: z
      .object({
        kind: z.literal('inline'),
        content: z.string().max(MAX_MANAGED_INLINE_BASE64_CHARACTERS),
        encoding: z.literal('base64').optional()
      })
      .strict()
      .refine((source) =>
        source.encoding === 'base64'
          ? isCanonicalManagedInlineBase64(source.content)
          : Buffer.byteLength(source.content, 'utf8') <= MAX_MANAGED_INLINE_BINARY_BYTES
      ),
    publication: z
      .object({
        beforeWrite: z.custom<ManagedOutputPublication['beforeWrite']>(
          (value) => typeof value === 'function'
        )
      })
      .strict()
      .optional()
  })
  .strict()

/** Main-only optional inline evidence; this is not a user-selectable write failure policy. */
export type AuxiliaryOutput = z.infer<typeof schema>
export type AuxiliaryOutputResult =
  | { status: 'saved'; artifact: ArtifactVersionFile }
  | { status: 'failed'; code: 'invalid-output' | 'artifact-save-failed' }

/** Runs inside the existing write tracker so even an unawaited auxiliary write is fully drained.
 * The explicit failure result cannot poison the required-output failure flag of the whole turn. */
export async function saveAuxiliaryOutput(
  input: AuxiliaryOutput,
  save: (output: ManagedExecutionOutput) => Promise<ArtifactVersionFile>
): Promise<AuxiliaryOutputResult> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { status: 'failed', code: 'invalid-output' }
  try {
    return { status: 'saved', artifact: await save(parsed.data) }
  } catch {
    return { status: 'failed', code: 'artifact-save-failed' }
  }
}
