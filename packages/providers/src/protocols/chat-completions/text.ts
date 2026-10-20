import { z } from 'zod'
import type { TextCodec } from '../text-types'
import { resolveChatReasoningTransport } from '../reasoning'
import { normalizeChatCompletionsUsage } from '../usage'

const textBlock = z.object({ type: z.literal('text'), text: z.string() })
const chatResponse = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({
          content: z.union([z.string(), z.array(textBlock)]),
          function_call: z.null().optional(),
          tool_calls: z.array(z.unknown()).max(0).optional(),
          refusal: z.null().optional()
        })
      })
    )
    .length(1)
})

export const chatCompletionsTextCodec: TextCodec = {
  encode(input) {
    const provider = input.target
    const effort = input.target.reasoningEffort
    const explicitEffort = effort && effort !== 'default' ? effort : undefined
    const reasoning = explicitEffort
      ? resolveChatReasoningTransport(
          provider.vendorId,
          input.target.model,
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
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.prompt }
      ],
      // Reasoning-capable OpenAI-shaped models use the limit that includes thinking tokens.
      ...(provider.vendorId === 'openai' ||
      (!provider.vendorId &&
        (!provider.reasoningEffortTransport ||
          provider.reasoningEffortTransport === 'reasoning-effort') &&
        reasoning?.reasoningEffort)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
      ...(reasoning?.reasoningEffort ? { reasoning_effort: reasoning.reasoningEffort } : {}),
      ...(reasoning?.thinking ? { thinking: reasoning.thinking } : {}),
      ...(reasoning?.reasoning ? { reasoning: reasoning.reasoning } : {}),
      stream: false
    }
  },
  usage(value) {
    return normalizeChatCompletionsUsage(value)
  },
  text(value) {
    const content = chatResponse.parse(value).choices[0].message.content
    return typeof content === 'string' ? content : content.map((part) => part.text).join('')
  }
}
