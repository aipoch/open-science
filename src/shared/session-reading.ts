import { z } from 'zod'

// Persisted association, not an Agent-facing identifier. The snapshot retains the exact Ask
// position while the Session remains available for on-demand reading after compaction/restart.
const sessionReadingPositionSchema = z
  .object({
    contextId: z.string().min(1).max(512),
    stepId: z.string().min(1).max(2048).optional(),
    branchId: z.string().min(1).max(1024),
    stepTitle: z.string().max(240).optional(),
    branchIndex: z.number().int().nonnegative().optional(),
    stepNumber: z.number().int().positive().optional()
  })
  .strict()

export const sessionReadingBindingSchema = z
  .object({
    projectId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512),
    contextId: z.string().min(1).max(512),
    title: z.string().max(4096),
    scope: z.enum(['step', 'session']).optional(),
    branchId: z.string().min(1).max(1024),
    positions: z.array(sessionReadingPositionSchema).min(1).max(20).optional(),
    promptMessageId: z.string().min(1).max(512)
  })
  .strict()
export const sessionReadingContextSchema = z
  .object({
    version: z.literal(1),
    lastPromptMessageId: z.string().min(1).max(512).optional(),
    bindings: z.array(sessionReadingBindingSchema).max(10)
  })
  .strict()
export type SessionReadingBinding = z.infer<typeof sessionReadingBindingSchema>
export type SessionReadingContext = z.infer<typeof sessionReadingContextSchema>

export const sessionReadingPositions = (
  binding: SessionReadingBinding
): Array<z.infer<typeof sessionReadingPositionSchema>> =>
  binding.positions ?? [{ contextId: binding.contextId, branchId: binding.branchId }]
