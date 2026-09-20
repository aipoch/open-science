import { z } from 'zod'
import {
  parseExecutionFileEvidenceSummary,
  type ExecutionFileEvidenceSummary
} from '../../shared/execution-file-evidence'

const text = z.string().max(16 * 1024 ** 2)
const time = z.number().finite().nonnegative()
export const packageHistorySchema = z
  .object({
    taskRuns: z
      .array(
        z
          .object({
            id: text,
            status: z.enum(['completed', 'failed', 'cancelled']),
            startedAt: time,
            completedAt: time.optional(),
            cancelledAt: time.optional(),
            output: text.optional(),
            error: text.optional()
          })
          .strict()
      )
      .max(10000),
    computeJobs: z
      .array(
        z
          .object({
            id: text,
            status: text,
            cancelled: z.boolean(),
            shape: text,
            intent: text,
            command: text,
            commandHash: text,
            environment: text.optional(),
            resources: text.optional(),
            inputManifest: text.optional(),
            outputManifest: text.optional(),
            producerRunId: text.optional(),
            fileEvidence: z
              .custom<ExecutionFileEvidenceSummary>(
                (value) => parseExecutionFileEvidenceSummary(value) !== undefined
              )
              .optional(),
            stdout: text.optional(),
            stderr: text.optional(),
            exitCode: z.number().int().optional(),
            error: text.optional(),
            leftOnRemote: text.optional(),
            createdAt: time,
            finishedAt: time.optional(),
            protectedContentUnavailable: z.boolean()
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
export type PackageHistory = z.infer<typeof packageHistorySchema>
