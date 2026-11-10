import { z } from 'zod'

export const HARNESS_ACP_ARG = '--internal-agent-acp'
export const HARNESS_AUTH_METHOD = 'open-science-agent'
export const HARNESS_INSTRUCTIONS = 'open-science-agent/instructions'
export const HARNESS_TOOL_LESS = 'open-science-agent/tool-less'
export const HARNESS_OWNER = 'open-science-agent/owner'
export const harnessOwnerSchema = z
  .object({
    projectId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512).optional()
  })
  .strict()

// Only the host's revocable loopback credential crosses ACP; never the provider account key.
export const harnessConfigSchema = z
  .object({
    protocol: z.enum(['chat-completions', 'responses', 'messages']).default('chat-completions'),
    endpoint: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          ['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname)
        )
      }),
    token: z
      .string()
      .min(1)
      .regex(/^[^\r\n]+$/),
    model: z.string().trim().min(1),
    // Stable across connection generations; opaque reasoning may not cross providers/models.
    modelIdentity: z.string().min(1),
    inputCapabilities: z
      .object({
        images: z.boolean().optional(),
        files: z.boolean().optional(),
        audio: z.boolean().optional(),
        video: z.boolean().optional()
      })
      .strict()
      .optional(),
    sessionHeader: z.literal('x-opencode-session').optional(),
    contextWindow: z.number().int().min(4096),
    maxOutputTokens: z.number().int().positive(),
    parameters: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
  .refine(
    (value) =>
      new URL(value.endpoint).pathname ===
      `/v1/${value.protocol === 'chat-completions' ? 'chat/completions' : value.protocol}`
  )
  .refine((value) => value.maxOutputTokens < value.contextWindow / 2)
export type HarnessConfig = z.infer<typeof harnessConfigSchema>
