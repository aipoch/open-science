import { z } from 'zod'
import type { TextCodec } from '../text-types'
import { resolveMessagesReasoningTransport } from '../reasoning'

const textBlock = z.object({ type: z.literal('text'), text: z.string() })
const tokenCount = z.number().int().nonnegative().safe()
const messagesUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount.default(0),
  cache_creation_input_tokens: tokenCount.default(0)
})
const messagesResponse = z.object({
  stop_reason: z.literal('end_turn'),
  content: z.array(
    z.union([
      textBlock,
      z.object({ type: z.literal('thinking'), thinking: z.string() }),
      z.object({ type: z.literal('redacted_thinking'), data: z.string() })
    ])
  )
})

export const messagesTextCodec: TextCodec = {
  encode(input) {
    const provider = input.target
    const effort = input.target.reasoningEffort
    const explicitEffort = effort && effort !== 'default' ? effort : undefined
    const reasoning = explicitEffort
      ? resolveMessagesReasoningTransport(
          provider.vendorId,
          provider.model,
          explicitEffort,
          provider.reasoningEffortTransport
        )
      : undefined
    const maxTokens = Math.min(
      provider.maxOutputTokens ?? input.maxOutputTokens,
      input.maxOutputTokens
    )

    return {
      model: input.target.model,
      max_tokens: maxTokens,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.prompt }],
      ...(reasoning?.thinking ? { thinking: reasoning.thinking } : {}),
      ...(reasoning?.outputConfig ? { output_config: reasoning.outputConfig } : {})
    }
  },
  usage(value) {
    const parsed = messagesUsage.safeParse(value)
    if (!parsed.success) return undefined
    const data = parsed.data
    const cacheTokens = data.cache_read_input_tokens + data.cache_creation_input_tokens
    if (!Number.isSafeInteger(cacheTokens)) return undefined
    return {
      inputTokens: data.input_tokens,
      outputTokens: data.output_tokens,
      cacheTokens,
      cachedReadTokens: data.cache_read_input_tokens,
      cachedWriteTokens: data.cache_creation_input_tokens
    }
  },
  text(value) {
    return messagesResponse
      .parse(value)
      .content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
  }
}
