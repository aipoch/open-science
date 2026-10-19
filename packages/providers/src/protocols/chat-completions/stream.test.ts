import { expect, it } from 'vitest'
import { messagesToChatCompletions } from '../messages/conversion'
import { encodeChatCompletionsStream } from './stream'
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
