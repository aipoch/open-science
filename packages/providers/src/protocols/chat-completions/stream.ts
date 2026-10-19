type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const encodeChatCompletionsStream = (completion: Json): string => {
  const frames: string[] = []
  const choice =
    Array.isArray(completion.choices) && object(completion.choices[0]) ? completion.choices[0] : {}
  const message = object(choice.message) ? choice.message : {}
  const chunk = (delta: Json, finishReason: unknown = null, usage?: unknown): void => {
    frames.push(
      `data: ${JSON.stringify({
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {})
      })}\n\n`
    )
  }
  chunk({
    role: 'assistant',
    content: message.content,
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(Array.isArray(message.tool_calls)
      ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
      : {})
  })
  chunk({}, choice.finish_reason, completion.usage)
  return frames.join('') + 'data: [DONE]\n\n'
}
