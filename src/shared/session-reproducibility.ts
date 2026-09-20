import { z } from 'zod'
import { outputComparisonPolicySchema } from './output-comparison'
import type { ArtifactReproducibilityCheckState } from './artifact-reproducibility'

const id = z.string().min(1).max(256)
const scope = { projectId: id, appSessionId: id }
export const sessionReproducibilityCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...scope, action: z.literal('get') }).strict(),
  z
    .object({
      ...scope,
      action: z.literal('prepare'),
      targets: z
        .array(
          z
            .object({
              artifactId: id,
              versionId: id,
              name: z.string().min(1).max(512)
            })
            .strict()
        )
        .min(1)
        .max(64),
      comparisonPolicy: outputComparisonPolicySchema.optional()
    })
    .strict(),
  z.object({ ...scope, action: z.literal('start'), batchId: id }).strict(),
  z.object({ ...scope, action: z.literal('cancel'), batchId: id }).strict()
])
export type SessionReproducibilityCommand = z.infer<typeof sessionReproducibilityCommandSchema>
export type SessionReproducibilityBatch = {
  comparisonPolicy?: import('./output-comparison').OutputComparisonPolicy
  batchId: string
  projectId: string
  appSessionId: string
  createdAt: string
  status: 'preparing' | 'ready' | 'running' | 'completed' | 'cancelled'
  targets: Array<{
    artifactId: string
    versionId: string
    name: string
    status: 'pending' | 'blocked' | 'queued' | ArtifactReproducibilityCheckState['status']
    recipeId?: string
    steps?: number
    inputBytes?: number
    environmentCount?: number
    reason?:
      | 'evidence-unavailable'
      | 'preflight-failed'
      | 'environment-transition'
      | 'insufficient-disk-space'
    attemptId?: string
    receiptChecksum?: string
  }>
}

export const sessionReproducibilityBatchSchema = z
  .object({
    batchId: id,
    projectId: id,
    appSessionId: id,
    createdAt: z.string().datetime(),
    comparisonPolicy: outputComparisonPolicySchema.optional(),
    status: z.enum(['preparing', 'ready', 'running', 'completed', 'cancelled']),
    targets: z
      .array(
        z
          .object({
            artifactId: id,
            versionId: id,
            name: z.string().min(1).max(512),
            status: z.enum([
              'pending',
              'blocked',
              'queued',
              'running',
              'matched',
              'different',
              'failed',
              'cancelled'
            ]),
            recipeId: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional(),
            steps: z.number().int().nonnegative().max(10000).optional(),
            inputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
            environmentCount: z.number().int().nonnegative().max(10000).optional(),
            reason: z
              .enum([
                'evidence-unavailable',
                'preflight-failed',
                'environment-transition',
                'insufficient-disk-space'
              ])
              .optional(),
            attemptId: id.optional(),
            receiptChecksum: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional()
          })
          .strict()
      )
      .min(1)
      .max(64)
  })
  .strict()
