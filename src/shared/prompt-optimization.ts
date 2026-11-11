import { z } from 'zod'
import { sessionAgentConfigurationSchema } from './session-configuration'

export const PROMPT_OPTIMIZATION_INPUT_LIMIT = 16000
export const PROMPT_OPTIMIZATION_OUTPUT_LIMIT = 32000
export const DEFAULT_OPTIMIZATION_PROMPT =
  "Rewrite the user's input into a clear, specific, and actionable prompt while preserving its original intent and important details."

export type OptimizationPromptProject = Readonly<{
  id: string
  optimizationPrompt?: string
  updatedAt?: number
}>

export const resolveOptimizationPrompt = (
  currentProject: OptimizationPromptProject | undefined
): string => {
  return currentProject?.optimizationPrompt?.trim() || DEFAULT_OPTIMIZATION_PROMPT
}

export const optimizePromptRequestSchema = z
  .object({
    projectId: z.string().min(1),
    requestId: z.uuid().optional(),
    agentConfiguration: sessionAgentConfigurationSchema,
    input: z
      .string()
      .max(PROMPT_OPTIMIZATION_INPUT_LIMIT)
      .refine((value) => Boolean(value.trim()))
  })
  .strict()
export const optimizePromptResultSchema = z
  .object({
    text: z.string().min(1).max(PROMPT_OPTIMIZATION_OUTPUT_LIMIT)
  })
  .strict()
export type OptimizePromptRequest = z.infer<typeof optimizePromptRequestSchema>
export type OptimizePromptResult = z.infer<typeof optimizePromptResultSchema>

export const cancelPromptOptimizationRequestSchema = z
  .object({ projectId: z.string().min(1), requestId: z.uuid() })
  .strict()
export type CancelPromptOptimizationRequest = z.infer<typeof cancelPromptOptimizationRequestSchema>

export const optimizationEventSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['undo', 'edit', 'send']) }).strict(),
  z
    .object({
      action: z.literal('failed'),
      requestId: z.uuid(),
      stage: z.enum(['output', 'references', 'apply'])
    })
    .strict()
])
export type OptimizationEvent = z.infer<typeof optimizationEventSchema>
