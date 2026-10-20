import { readSseRecords } from '../transport/sse'
import { createResponseStreamState } from './stream-state'
import type { ResponsesNamespacedTool } from './types'
export type ReplayReply = { reasoning: string; callIds: string[]; messageId?: string }

export async function* convertChatStream(
  upstream: Response,
  model: string,
  tools: readonly ResponsesNamespacedTool[],
  maxBytes: number,
  onCompleted: (reply: ReplayReply) => void,
  signal?: AbortSignal
): AsyncGenerator<string> {
  if (!upstream.body) throw new Error('Chat Completions upstream returned no body')
  const state = createResponseStreamState(model, tools)
  const drain = (): string[] =>
    state.drain().map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  signal?.throwIfAborted()
  yield* drain()
  let sawDone = false
  let failure: unknown
  try {
    for await (const record of readSseRecords(upstream, maxBytes, signal)) {
      const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (data === '[DONE]') sawDone = true
      else if (data) state.consume(JSON.parse(data))
      yield* drain()
    }
  } catch (error) {
    failure = error
  }
  signal?.throwIfAborted()
  const reply = state.finish(failure, sawDone)
  // Commit before publishing the terminal frame: consumers commonly stop reading there.
  onCompleted(reply)
  yield* drain()
}
