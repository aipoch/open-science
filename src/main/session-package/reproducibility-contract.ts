import { z } from 'zod'
import { sessionReproducibilityBatchSchema } from '../../shared/session-reproducibility'
import { reproducibilitySourceSchema } from '../artifacts/reproducibility-source'

export const path = z.string().min(1).max(2048)

export const output = z
  .object({
    storageKey: path,
    filename: z.string().min(1).max(1000),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

export const packageReproducibilitySchema = z
  .object({
    sourceSessionCheck: sessionReproducibilityBatchSchema
      .refine(
        (batch) => ['completed', 'cancelled'].includes(batch.status),
        'Only terminal Session checks can be packaged.'
      )
      .optional(),
    versions: z
      .array(
        z
          .object({
            versionId: z.string().min(1).max(200),
            sourceScope: reproducibilitySourceSchema.shape.sourceScope,
            entityIds: reproducibilitySourceSchema.shape.entityIds,
            omittedOutputChecksums: reproducibilitySourceSchema.shape.omittedOutputChecksums,
            metadataKeys: z.array(path).max(10000),
            outputs: z.array(output).max(10000),
            environmentLocks: z
              .array(
                z
                  .object({
                    checksum: z.string().regex(/^[a-f0-9]{64}$/),
                    serialized: z
                      .string()
                      .max(4 * 1024 * 1024)
                      .optional()
                  })
                  .strict()
              )
              .max(10000)
          })
          .strict()
      )
      .max(10000)
  })
  .strict()

export type PackageReproducibility = z.infer<typeof packageReproducibilitySchema>
