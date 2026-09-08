import { z } from 'zod'

// Deliberately excludes arbitrary environment variables, paths and credentials.
const observation = z
  .object({
    locale: z.string().max(1024),
    timezone: z.string().max(256),
    threadLimits: z
      .object({
        OMP_NUM_THREADS: z.string().max(32).optional(),
        OPENBLAS_NUM_THREADS: z.string().max(32).optional(),
        MKL_NUM_THREADS: z.string().max(32).optional(),
        VECLIB_MAXIMUM_THREADS: z.string().max(32).optional(),
        NUMEXPR_NUM_THREADS: z.string().max(32).optional()
      })
      .strict(),
    randomLibraries: z.array(z.string().max(128)).max(16)
  })
  .strict()
export const notebookExecutionContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    before: observation,
    after: observation
  })
  .strict()
export type NotebookExecutionContext = z.infer<typeof notebookExecutionContextSchema>
