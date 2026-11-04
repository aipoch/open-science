import { z } from 'zod'

export const researchVideoProgressSchema = z
  .object({
    phase: z.enum([
      'preparing',
      'writing',
      'loading',
      'voice',
      'alignment',
      'mixing',
      'build',
      'publishing',
      'rendering',
      'encoding',
      'verifying',
      'completed',
      'cancelled',
      'failed'
    ]),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().positive().optional(),
    completedLines: z.number().int().nonnegative().optional(),
    totalLines: z.number().int().positive().optional(),
    startedAt: z.number().finite().nonnegative()
  })
  .strict()
  .refine(
    (value) =>
      value.completed === undefined ||
      (value.total !== undefined && value.completed <= value.total),
    'Invalid progress count'
  )
  .refine(
    (value) =>
      value.completedLines === undefined ||
      (value.totalLines !== undefined && value.completedLines <= value.totalLines),
    'Invalid narration line count'
  )
export type ResearchVideoProgress = z.infer<typeof researchVideoProgressSchema>
export type ResearchVideoStep = Omit<ResearchVideoProgress, 'startedAt'>
export type ResearchVideoProgressRequest = {
  projectId: string
  sessionId: string
  branchId?: string
}
export type ResearchVideoExportResult = {
  canceled: boolean
  needsInstallation?: { downloadBytes: number }
}
