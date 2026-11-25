import type { ModelProtocol } from '../protocols/types'
import { manualProviderDefinition } from './manual-connections'
import type { OfficialVendorId } from './types'

type ProtocolProbePolicy = Readonly<{
  maxOutputTokens: number
  validateResponse?: (bodyText: string) => boolean
}>

type ProviderProbePolicy = Readonly<
  Record<ModelProtocol, ProtocolProbePolicy> & { sessionHeader?: string }
>

const hasValidMessagesResponse = (bodyText: string): boolean => {
  try {
    const parsed = JSON.parse(bodyText) as {
      type?: unknown
      role?: unknown
      content?: unknown
      usage?: { input_tokens?: unknown; output_tokens?: unknown }
    }

    return (
      parsed.type === 'message' &&
      parsed.role === 'assistant' &&
      Array.isArray(parsed.content) &&
      typeof parsed.usage?.input_tokens === 'number' &&
      typeof parsed.usage?.output_tokens === 'number'
    )
  } catch {
    return false
  }
}

/** Check for a usable Chat Completions reply. */
const hasValidChatResponse = (bodyText: string): boolean => {
  try {
    const { choices } = JSON.parse(bodyText) as {
      choices?: Array<{ message?: { role?: unknown; content?: unknown } }>
    }
    if (!Array.isArray(choices)) return false
    const message = choices[0]?.message
    return (
      message?.role === 'assistant' &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0
    )
  } catch {
    return false
  }
}

/** Require a completed text reply from the Responses API. */
const hasValidResponsesReply = (bodyText: string): boolean => {
  try {
    const { status, output } = JSON.parse(bodyText) as {
      status?: unknown
      output?: { type?: unknown; content?: { type?: unknown; text?: unknown }[] }[]
    }
    return (
      status === 'completed' &&
      Array.isArray(output) &&
      output.some(
        (item) =>
          item?.type === 'message' &&
          Array.isArray(item.content) &&
          item.content.some(
            (part) =>
              part?.type === 'output_text' &&
              typeof part.text === 'string' &&
              part.text.trim().length > 0
          )
      )
    )
  } catch {
    return false
  }
}

// Reasoning providers may spend the first few output tokens on an internal block. With a one-token
// budget Kimi k3 returns a 200 response whose message envelope is incomplete (`type`/`role` empty),
// even though normal Claude Code requests work. Sixteen tokens is still a cheap probe while allowing
// the provider to finish the Anthropic envelope that validation checks below.
const defaultPolicy: ProviderProbePolicy = {
  messages: { maxOutputTokens: 16, validateResponse: hasValidMessagesResponse },
  'chat-completions': { maxOutputTokens: 1 },
  responses: { maxOutputTokens: 16 }
}

const validatedChatProbe: ProtocolProbePolicy = {
  maxOutputTokens: 64,
  validateResponse: hasValidChatResponse
}

const vendorOverrides: Readonly<Partial<Record<OfficialVendorId, Partial<ProviderProbePolicy>>>> = {
  // Requesty rejects Chat probes below 16 output tokens, including for OpenAI models.
  requesty: { 'chat-completions': { maxOutputTokens: 16 } },
  vectrust: { responses: { maxOutputTokens: 128, validateResponse: hasValidResponsesReply } },
  // Settings probes do not run through OpenCode's chat.headers plugin.
  'opencode-go': { sessionHeader: 'x-opencode-session' }
}

/** Resolve the token budget and success criteria for a direct connection probe. */
export function resolveProviderProbePolicy(vendorId?: OfficialVendorId): ProviderProbePolicy {
  if (!vendorId) return defaultPolicy
  const requiresChatReply =
    vendorId === 'cloudflare-ai-gateway' || Boolean(manualProviderDefinition(vendorId))
  return {
    ...defaultPolicy,
    ...(requiresChatReply && { 'chat-completions': validatedChatProbe }),
    ...vendorOverrides[vendorId]
  }
}
