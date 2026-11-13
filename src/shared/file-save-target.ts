import { isAbsolute } from 'node:path'
import { z } from 'zod'

// Only trusted main/backend channels carry this snapshot; renderer input cannot authorize writes.
export const fileSaveTargetSchema = z
  .object({
    path: z.string().min(1).max(32_768).refine(isAbsolute),
    fingerprint: z
      .string()
      .max(256)
      .regex(/^\d+:\d+:\d+:-?\d+:-?\d+$/)
      .nullable()
  })
  .strict()

export type FileSaveTarget = z.infer<typeof fileSaveTargetSchema>
export type FileSaveSelection = { canceled: boolean; filePath?: string; target?: FileSaveTarget }
