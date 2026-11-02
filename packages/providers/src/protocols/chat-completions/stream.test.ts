import { expect, it } from 'vitest'
import { messagesToChatCompletions } from '../messages/conversion'
import { bufferChatCompletionsToolNames, encodeChatCompletionsStream } from './stream'
import { DEFAULT_MAX_PROVIDER_RESPONSE_BYTES } from '../../transport/body'
import { readSseRecords } from '../../transport/sse'
it('encodes a completed chat stream with tool indexes, usage and a terminal marker', () => {
  const completion = messagesToChatCompletions(
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'c', name: 'lookup', input: { q: 1 } }],
      usage: { input_tokens: 3, output_tokens: 2 }
    },
    'm'
  )
  const frames = encodeChatCompletionsStream(completion).trim().split('\n\n')
  expect(frames.at(-1)).toBe('data: [DONE]')
  expect(JSON.parse(frames[0].slice(6))).toMatchObject({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' }] }, finish_reason: null }]
  })
  expect(JSON.parse(frames[1].slice(6))).toMatchObject({
    choices: [{ finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 }
  })
})

const frame = (calls: unknown[], extra = {}): string =>
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: calls, ...extra }, finish_reason: null }]
  })}\n\n`
const call = (index: number, fn: Record<string, unknown>, extra = {}): unknown => ({
  index,
  function: fn,
  ...extra
})
const collect = async (input: string): Promise<string> => {
  let output = ''
  // Split UTF-8 and SSE boundaries as a real HTTP transport can.
  const bytes = new TextEncoder().encode(input)
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7))
        controller.close()
      }
    })
  )
  for await (const record of bufferChatCompletionsToolNames(
    readSseRecords(response, DEFAULT_MAX_PROVIDER_RESPONSE_BYTES)
  ))
    output += record
  return output
}

it('moves late names to the first fragment without reordering interleaved tools or other deltas', async () => {
  const first = frame(
    [
      call(
        0,
        { arguments: '{"q":' },
        { id: 'a', type: 'function', extra_content: { signature: 'signed' } }
      ),
      call(1, { arguments: '{"q":' }, { id: 'b', type: 'function' })
    ],
    { reasoning_content: '思考' }
  )
  const middle = ': heartbeat\n\ndata: {"choices":[{"index":0,"delta":{"content":"text"}}]}\n\n'
  const last = frame([
    call(1, { name: 'second', arguments: '2}' }),
    call(0, { name: 'first', arguments: '1}' })
  ])
  const end = 'data: {"choices":[],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n'
  expect(await collect(first + middle + last + end)).toBe(
    frame(
      [
        call(
          0,
          { arguments: '{"q":', name: 'first' },
          { id: 'a', type: 'function', extra_content: { signature: 'signed' } }
        ),
        call(1, { arguments: '{"q":', name: 'second' }, { id: 'b', type: 'function' })
      ],
      { reasoning_content: '思考' }
    ) +
      middle +
      frame([call(1, { arguments: '2}' }), call(0, { arguments: '1}' })]) +
      end
  )
})

it('waits for a function object after an identity-only first fragment', async () => {
  const first = { index: 0, id: 'a', type: 'function' }
  expect(
    await collect(frame([first]) + frame([call(0, { name: 'lookup', arguments: '{}' })]))
  ).toBe(
    frame([{ ...first, function: { name: 'lookup' } }]) + frame([call(0, { arguments: '{}' })])
  )
})

it.each([
  '',
  'data: [DONE]\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'
])('preserves missing names for downstream rejection at termination (%s)', async (end) => {
  const input = frame([call(0, { arguments: '{}' }, { id: 'a' })]) + end
  expect(await collect(input)).toBe(input)
})

it('passes ordinary streams and invalid protocol records through without inventing tool identity', async () => {
  const input =
    frame([call(0, { name: 'ready', arguments: '{' }, { id: 'a' })]) +
    frame([call(0, { arguments: '}' })]) +
    'data: invalid json\n\ndata: {"error":{"message":"bad"}}\n\ndata: [DONE]\n\n'
  expect(await collect(input)).toBe(input)
})

it('releases an unresolved call when the pending buffer limit is reached', async () => {
  const input = frame([call(0, { arguments: 'x'.repeat(1024 * 1024) }, { id: 'a' })])
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input))
      },
      cancel() {
        cancelled = true
      }
    })
  )
  const output = bufferChatCompletionsToolNames(
    readSseRecords(response, DEFAULT_MAX_PROVIDER_RESPONSE_BYTES)
  )
  expect((await output.next()).value).toBe(input)
  await output.return(undefined)
  expect(cancelled).toBe(true)
})

it('cancels the upstream while waiting for a missing name', async () => {
  const abort = new AbortController()
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(frame([call(0, { arguments: '{}' }, { id: 'a' })]))
        )
      },
      cancel() {
        cancelled = true
      }
    })
  )
  const output = bufferChatCompletionsToolNames(
    readSseRecords(response, DEFAULT_MAX_PROVIDER_RESPONSE_BYTES, abort.signal)
  )
  const waiting = output.next()
  await new Promise((resolve) => setTimeout(resolve, 0))
  abort.abort(new Error('cancelled fixture'))
  await expect(waiting).rejects.toThrow('cancelled fixture')
  expect(cancelled).toBe(true)
})
