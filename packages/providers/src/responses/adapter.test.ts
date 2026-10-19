import { expect, it, vi } from 'vitest'
import { createResponsesAdapter } from './adapter'

const reply = (id = 'one', reasoning = 'private reasoning'): Response =>
  Response.json({
    id,
    model: 'model',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          reasoning_content: reasoning,
          content: 'Answer',
          tool_calls: [
            { id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }
          ]
        }
      }
    ]
  })
const history = [
  { type: 'function_call', call_id: 'call', name: 'lookup', arguments: '{}' },
  { type: 'function_call_output', call_id: 'call', output: 'result' }
]
it('owns replay across turns, isolates scopes, and clears all identities', async () => {
  const adapter = createResponsesAdapter()
  const turn = adapter.prepare({ scope: 'a', body: { input: 'hello', stream: false } })
  await turn.convert(reply())
  expect(
    adapter.prepare({ scope: 'a', body: { input: history } }).request.messages[0].reasoning_content
  ).toBe('private reasoning')
  expect(
    adapter.prepare({ scope: 'b', body: { input: history } }).request.messages[0].reasoning_content
  ).toBeUndefined()
  expect(
    adapter.prepare({ body: { input: history } }).request.messages[0].reasoning_content
  ).toBeUndefined()
  adapter.clear()
  expect(
    adapter.prepare({ scope: 'a', body: { input: history } }).request.messages[0].reasoning_content
  ).toBeUndefined()
  adapter.dispose()
  expect(() => adapter.prepare({ body: { input: 'hello', stream: false } })).toThrow('disposed')
})
it('snapshots caller scope, body and tools and rejects repeated conversion', async () => {
  const adapter = createResponsesAdapter()
  const input = { scope: 'original', body: { input: 'hello', stream: false }, tools: [] }
  const turn = adapter.prepare(input)
  input.scope = 'changed'
  input.body.stream = true
  turn.request.stream = true
  expect(await (await turn.convert(reply())).json()).toMatchObject({ object: 'response' })
  expect(
    adapter.prepare({ scope: 'original', body: { input: history } }).request.messages[0]
      .reasoning_content
  ).toBe('private reasoning')
  await expect(turn.convert(reply())).rejects.toThrow('already converted')
  adapter.dispose()
})
it('does not repopulate replay when a pre-clear turn finishes later', async () => {
  const adapter = createResponsesAdapter()
  const old = adapter.prepare({ scope: 'a', body: { input: 'hello', stream: false } })
  adapter.clear()
  await old.convert(reply())
  expect(
    adapter.prepare({ scope: 'a', body: { input: history } }).request.messages[0].reasoning_content
  ).toBeUndefined()
  adapter.dispose()
})
it('keeps valid history after a rejected request', async () => {
  const adapter = createResponsesAdapter()
  await adapter.prepare({ scope: 'a', body: { input: 'hello', stream: false } }).convert(reply())
  expect(() =>
    adapter.prepare({ scope: 'a', body: { input: [{ type: 'unknown_item' }] } })
  ).toThrow()
  expect(
    adapter.prepare({ scope: 'a', body: { input: history } }).request.messages[0].reasoning_content
  ).toBe('private reasoning')
  adapter.dispose()
})
it('cancels an active nonstream reader on disposal and releases its lock', async () => {
  const cancel = vi.fn()
  const upstream = new Response(new ReadableStream({ cancel }))
  const adapter = createResponsesAdapter()
  const pending = adapter.prepare({ body: { input: 'hello', stream: false } }).convert(upstream)
  adapter.dispose()
  await expect(pending).rejects.toThrow()
  expect(cancel).toHaveBeenCalledOnce()
  expect(upstream.body?.locked).toBe(false)
})
it('releases upstream when the output consumer cancels before reading', async () => {
  const cancel = vi.fn()
  const upstream = new Response(new ReadableStream({ cancel }))
  const adapter = createResponsesAdapter()
  const output = await adapter.prepare({ body: { input: 'hello', stream: true } }).convert(upstream)
  await output.body!.cancel()
  expect(cancel).toHaveBeenCalledOnce()
  expect(upstream.body?.locked).toBe(false)
  adapter.dispose()
})
it('emits one terminal event and persists completed stream replay', async () => {
  const data =
    [
      {
        id: 'r',
        choices: [
          { delta: { content: 'Answer', reasoning_content: 'thought' }, finish_reason: null }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]
      .map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n')
      .join('') + 'data: [DONE]\n\n'
  const adapter = createResponsesAdapter()
  const output = await adapter
    .prepare({ scope: 'a', body: { input: 'hello', stream: true } })
    .convert(new Response(data))
  const events = (await output.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const terminal = events.filter((event) =>
    ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)
  )
  expect(terminal).toHaveLength(1)
  const items = terminal[0].response.output
  expect(
    adapter.prepare({ scope: 'a', body: { input: items } }).request.messages[0].reasoning_content
  ).toBe('thought')
  adapter.dispose()
})

it('rejects invalid bounds before allocating replay state', () => {
  for (const limit of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => createResponsesAdapter({ maxResponseBytes: limit })).toThrow(RangeError)
    expect(() => createResponsesAdapter({ reasoningCacheMaxEntries: limit })).toThrow(RangeError)
  }
})
it('disposal releases a stream that the consumer has not read yet', async () => {
  const cancel = vi.fn()
  const upstream = new Response(new ReadableStream({ cancel }))
  const adapter = createResponsesAdapter()
  await adapter.prepare({ body: { input: 'hello', stream: true } }).convert(upstream)
  adapter.dispose()
  expect(cancel).toHaveBeenCalledOnce()
})

it('commits replay before a terminal event consumer disconnects', async () => {
  const data =
    'data: ' +
    JSON.stringify({
      choices: [
        { delta: { content: 'Answer', reasoning_content: 'remember' }, finish_reason: 'stop' }
      ]
    }) +
    '\n\ndata: [DONE]\n\n'
  const adapter = createResponsesAdapter()
  const response = await adapter
    .prepare({ scope: 'a', body: { input: 'hello', stream: true } })
    .convert(new Response(data))
  const reader = response.body!.getReader()
  let output: unknown[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error('Expected terminal event')
    const frame = new TextDecoder().decode(value)
    if (frame.startsWith('event: response.completed')) {
      output = JSON.parse(frame.split('\ndata: ')[1]).response.output
      break
    }
  }
  await reader.cancel()
  reader.releaseLock()
  expect(
    adapter.prepare({ scope: 'a', body: { input: output } }).request.messages[0].reasoning_content
  ).toBe('remember')
  adapter.dispose()
})

it('publishes immutable added events before text and tool argument deltas', async () => {
  const adapter = createResponsesAdapter()
  try {
    const chunks = [
      {
        choices: [
          {
            delta: {
              content: 'Hel',
              tool_calls: [
                { index: 0, id: 'call', function: { name: 'lookup', arguments: '{"q":' } }
              ]
            }
          }
        ]
      },
      {
        choices: [
          { delta: { content: 'lo', tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]
    const upstream = new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    )
    const response = await adapter
      .prepare({ body: { input: 'hello', stream: true } })
      .convert(upstream)
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    const added = events.filter((event) => event.type === 'response.output_item.added')
    const text = added.find((event) => event.item.type === 'message')
    const tool = added.find((event) => event.item.type === 'function_call')
    expect(text.item.content).toEqual([])
    expect(tool.item.arguments).toBe('')
    const argumentsText =
      tool.item.arguments +
      events
        .filter((event) => event.type === 'response.function_call_arguments.delta')
        .map((event) => event.delta)
        .join('')
    expect(JSON.parse(argumentsText)).toEqual({ q: 1 })
    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => event.delta)
        .join('')
    ).toBe('Hello')
    const completed = events.find((event) => event.type === 'response.completed')
    expect(
      completed.response.output.find((item: { type: string }) => item.type === 'function_call')
        .arguments
    ).toBe(argumentsText)
  } finally {
    adapter.dispose()
  }
})

it('emits exactly one protocol failure for an unknown upstream finish reason', async () => {
  const adapter = createResponsesAdapter()
  try {
    const upstream = new Response(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: 'partial' }, finish_reason: 'unexpected' }]
        }) +
        '\n\ndata: [DONE]\n\n'
    )
    const response = await adapter
      .prepare({ body: { input: 'hello', stream: true } })
      .convert(upstream)
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
    const terminal = events.filter((event) =>
      ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)
    )
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({
      type: 'response.failed',
      response: { status: 'failed', error: { type: 'unsupported_upstream_output' } }
    })
  } finally {
    adapter.dispose()
  }
})
