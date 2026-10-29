type Json = Record<string, unknown>
const object = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export async function* bufferChatCompletionsToolNames(
  source: AsyncIterable<string>
): AsyncGenerator<string> {
  // Older consumers require a name on the first tool delta. Keep the wire order and
  // move only that field; arguments and provider-specific metadata must not be merged.
  type Record = { raw: string; value?: Json; changed: boolean }
  const pending = new Map<string, { call: Json; record: Record }>()
  const started = new Set<string>()
  let records: Record[] = []
  let bytes = 0
  let passthrough = false
  const encode = (record: Record): string => {
    if (!record.changed) return `${record.raw}\n\n`
    let written = false
    return (
      record.raw
        .split(/\r?\n/)
        .flatMap((line) => {
          if (!line.startsWith('data:')) return [line]
          if (written) return []
          written = true
          return [`data: ${JSON.stringify(record.value)}`]
        })
        .join('\n') + '\n\n'
    )
  }
  for await (const record of source) {
    if (passthrough) {
      yield `${record}\n\n`
      continue
    }
    const data = record
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    const entry: Record = { raw: record, changed: false }
    let terminal = data === '[DONE]'
    try {
      const value: unknown = JSON.parse(data)
      if (object(value)) entry.value = value
    } catch {
      // Let the consumer handle malformed JSON and protocol error records.
    }
    const choices = entry.value?.choices
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!object(choice)) continue
        if (choice.finish_reason != null) terminal = true
        if (!Number.isInteger(choice.index) || !object(choice.delta)) continue
        const calls = choice.delta.tool_calls
        if (!Array.isArray(calls)) continue
        for (const call of calls) {
          if (!object(call) || !Number.isInteger(call.index)) continue
          if (call.function != null && !object(call.function)) continue
          const fn = object(call.function) ? call.function : {}
          const key = `${choice.index}:${call.index}`
          const waiting = pending.get(key)
          if (waiting && typeof fn.name === 'string') {
            const first = object(waiting.call.function) ? waiting.call.function : {}
            first.name = fn.name
            waiting.call.function = first
            waiting.record.changed = true
            delete fn.name
            entry.changed = true
            pending.delete(key)
          } else if (!started.has(key)) {
            started.add(key)
            if (fn.name == null) pending.set(key, { call, record: entry })
          }
        }
      }
    }
    records.push(entry)
    bytes += Buffer.byteLength(record)
    // Never silently discard an incomplete call or guess its identity. At a terminal
    // record or the memory limit, release it to the consumer's original validation.
    if (terminal || (pending.size > 0 && bytes >= 1024 * 1024)) passthrough = true
    if (pending.size === 0 || passthrough) {
      for (const queued of records) yield encode(queued)
      records = []
      bytes = 0
      if (passthrough) pending.clear()
    }
  }
  for (const queued of records) yield encode(queued)
}

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
