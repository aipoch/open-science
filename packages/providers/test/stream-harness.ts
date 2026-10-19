import { convertChatStream, type ReplayReply } from '../src/responses/stream'
import { DEFAULT_MAX_PROVIDER_RESPONSE_BYTES } from '../src/transport/body'
import type { ResponsesNamespacedTool } from '../src/responses/types'
export type ResponsesStreamWriter = {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(): void
}
// Internal test/conversion harness; actual consumers use the standards-based adapter response.
export async function streamChatToResponses(
  upstream: Response,
  writer: ResponsesStreamWriter,
  model: string,
  tools: readonly ResponsesNamespacedTool[] = [],
  maxBytes = DEFAULT_MAX_PROVIDER_RESPONSE_BYTES
): Promise<ReplayReply> {
  writer.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  let result: ReplayReply = { reasoning: '', callIds: [] }
  for await (const event of convertChatStream(upstream, model, tools, maxBytes, (reply) => {
    result = reply
  }))
    writer.write(event)
  writer.end()
  return result
}
