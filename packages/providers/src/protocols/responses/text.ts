import { z } from 'zod'
import type { TextCodec } from '../text-types'
import { normalizeChatCompletionsUsage } from '../usage'
import { resolveResponsesReasoningTransport } from '../reasoning'

const responsesResponse = z.object({
  status: z.literal('completed'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z.array(
    z.union([
      z.object({ type: z.literal('reasoning') }),
      z.object({
        type: z.literal('message'),
        role: z.literal('assistant'),
        status: z.literal('completed'),
        phase: z.enum(['final_answer', 'commentary']).nullish(),
        content: z.array(z.object({ type: z.literal('output_text'), text: z.string() }))
      })
    ])
  )
})

export const responsesTextCodec: TextCodec = {
  encode(input) {
    const explicitEffort =
      input.target.reasoningEffort === 'default' ? undefined : input.target.reasoningEffort
    const maxTokens = Math.min(
      input.target.maxOutputTokens ?? input.maxOutputTokens,
      input.maxOutputTokens
    )

    return {
      model: input.target.model,
      instructions: input.systemPrompt,
      input: [{ role: 'user', content: input.prompt }],
      max_output_tokens: maxTokens,
      stream: false,
      store: false,
      ...(explicitEffort
        ? resolveResponsesReasoningTransport(
            input.target.vendorId,
            input.target.model,
            explicitEffort
          )
        : {})
    }
  },
  usage(value) {
    return normalizeChatCompletionsUsage(value)
  },
  text(value) {
    return responsesResponse
      .parse(value)
      .output.flatMap((item) =>
        item.type === 'message' && item.phase !== 'commentary'
          ? item.content.map((part) => part.text)
          : []
      )
      .join('')
  }
}
