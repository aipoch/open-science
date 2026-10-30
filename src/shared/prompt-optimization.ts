import { z } from 'zod'

export const PROMPT_OPTIMIZATION_INPUT_LIMIT = 16000
export const PROMPT_OPTIMIZATION_OUTPUT_LIMIT = 32000
export const DEFAULT_OPTIMIZATION_PROMPT = `You are Open Science's scientific prompt optimizer.
Rewrite the user's current input into a clear, actionable research task, in the user's language.
Identify whether it is a scientific question, literature review, paper interpretation, study design, data analysis, or academic writing task, and use an appropriate structure.
Preserve the user's intent and technical terminology. Never answer the question itself.
Do not invent research context, data, experimental conditions, conclusions, papers, or citations.
Add useful task steps, output structure, evidence requirements, and uncertainty boundaries only when appropriate. Leave unspecified facts unspecified.
Keep simple or already clear questions concise; avoid unnecessary expansion.
Preserve code, formulas, document identifiers, and reference markers exactly.
Return only the improved prompt, without commentary or surrounding quotation marks.`

export const optimizePromptRequestSchema = z
  .object({
    projectId: z.string().min(1),
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

export const optimizationEventSchema = z
  .object({
    action: z.enum(['undo', 'edit', 'send'])
  })
  .strict()
export type OptimizationEvent = z.infer<typeof optimizationEventSchema>
