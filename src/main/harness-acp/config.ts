import { z } from 'zod'

export const HARNESS_ACP_ARG = '--internal-agent-acp'
export const HARNESS_AUTH_METHOD = 'open-science-agent'
export const HARNESS_INSTRUCTIONS = 'open-science-agent/instructions'
export const HARNESS_TOOL_LESS = 'open-science-agent/tool-less'
export const HARNESS_OWNER = 'open-science-agent/owner'
export const HARNESS_EPHEMERAL_SESSION = 'open-science-agent/ephemeral-session'
export const HARNESS_USER_TEXT_RANGE = 'open-science-agent/user-text-range'
export const HARNESS_TRACE_READINESS_METHOD = '_open-science-agent/trace-readiness'
export const HARNESS_TRACE_ENABLED = 'open-science-agent/trace-enabled'
export const HARNESS_OTLP_TRACES_ENDPOINT = 'OPEN_SCIENCE_AGENT_OTLP_TRACES_ENDPOINT'
export const HARNESS_OTLP_TRACES_API_KEY = 'OPEN_SCIENCE_AGENT_OTLP_TRACES_API_KEY'
export const HARNESS_OTLP_TRACES_HEADERS_FILE = 'OPEN_SCIENCE_AGENT_OTLP_TRACES_HEADERS_FILE'
export const HARNESS_OTLP_TRACES_HEADERS = 'OPEN_SCIENCE_AGENT_OTLP_TRACES_HEADERS'
export const HARNESS_OTLP_DIAGNOSTICS = 'OPEN_SCIENCE_AGENT_OTLP_DIAGNOSTICS'
export const HARNESS_OTLP_CAPTURE_CONTENT = 'OPEN_SCIENCE_AGENT_OTLP_CAPTURE_CONTENT'
export const HARNESS_OTLP_CAPTURE_API_REQUEST = 'OPEN_SCIENCE_AGENT_OTLP_CAPTURE_API_REQUEST'
export const HARNESS_OTLP_CAPTURE_TOOL_ARGUMENTS = 'OPEN_SCIENCE_AGENT_OTLP_CAPTURE_TOOL_ARGUMENTS'
export const HARNESS_OTLP_CAPTURE_TOOL_RESULTS = 'OPEN_SCIENCE_AGENT_OTLP_CAPTURE_TOOL_RESULTS'
export const HARNESS_OTLP_ENV_FILE = 'OPEN_SCIENCE_AGENT_OTLP_ENV_FILE'
export const HARNESS_OTLP_SWITCHES = [
  HARNESS_OTLP_DIAGNOSTICS,
  HARNESS_OTLP_CAPTURE_CONTENT,
  HARNESS_OTLP_CAPTURE_API_REQUEST,
  HARNESS_OTLP_CAPTURE_TOOL_ARGUMENTS,
  HARNESS_OTLP_CAPTURE_TOOL_RESULTS
] as const
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
    maxOutputTokens: z.number().int().positive().optional(),
    parameters: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
  .refine(
    (value) =>
      new URL(value.endpoint).pathname ===
      `/v1/${value.protocol === 'chat-completions' ? 'chat/completions' : value.protocol}`
  )
export type HarnessConfig = z.infer<typeof harnessConfigSchema>
