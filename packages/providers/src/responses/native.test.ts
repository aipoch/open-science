import { expect, it } from 'vitest'
import { prepareNativeResponsesRequest } from './native'
it('flattens namespace tools and matching history without changing plain functions', () => {
  const projection = prepareNativeResponsesRequest({
    model: 'MiniMax-M3',
    tools: [
      {
        type: 'namespace',
        name: 'mcp__open_science_notebook',
        description: 'Open-Science notebook tools.',
        tools: [
          {
            type: 'function',
            name: 'repl_execute',
            description: 'Run control-plane JavaScript.',
            parameters: { type: 'object' },
            strict: false
          }
        ]
      },
      {
        type: 'function',
        name: 'shell_command',
        description: 'Run a shell command.',
        parameters: { type: 'object' }
      }
    ],
    tool_choice: {
      type: 'function',
      namespace: 'mcp__open_science_notebook',
      name: 'repl_execute'
    },
    input: [
      {
        type: 'function_call',
        namespace: 'mcp__open_science_notebook',
        name: 'repl_execute',
        call_id: 'call-1',
        arguments: '{}'
      },
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
    ]
  })

  const { request } = projection
  expect(request.tools).toEqual([
    {
      type: 'function',
      name: 'mcp__open_science_notebook__repl_execute',
      description: 'Open-Science notebook tools.\n\nRun control-plane JavaScript.',
      parameters: { type: 'object' },
      strict: false
    },
    {
      type: 'function',
      name: 'shell_command',
      description: 'Run a shell command.',
      parameters: { type: 'object' }
    }
  ])
  expect(request.tool_choice).toEqual({
    type: 'function',
    name: 'mcp__open_science_notebook__repl_execute'
  })
  expect((request.input as unknown[])[0]).toMatchObject({
    type: 'function_call',
    name: 'mcp__open_science_notebook__repl_execute'
  })
  expect((request.input as unknown[])[0]).not.toHaveProperty('namespace')
  expect(projection.resolveTool('mcp__open_science_notebook__repl_execute')).toEqual({
    namespace: 'mcp__open_science_notebook',
    name: 'repl_execute'
  })
})

it('rejects an alias collision instead of routing a tool ambiguously', () => {
  expect(() =>
    prepareNativeResponsesRequest({
      tools: [
        {
          type: 'namespace',
          name: 'mcp__server',
          tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }]
        },
        {
          type: 'function',
          name: 'mcp__server__echo',
          parameters: { type: 'object' }
        }
      ]
    })
  ).toThrow('duplicate native Responses tool alias')
})

it('restores namespace identity in streamed and completed response items', () => {
  const projection = prepareNativeResponsesRequest({
    tools: [
      {
        type: 'namespace',
        name: 'mcp__open_science_notebook',
        tools: [{ type: 'function', name: 'repl_execute' }]
      }
    ]
  })

  expect(
    projection.restore({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        name: 'mcp__open_science_notebook__repl_execute',
        arguments: '{}',
        call_id: 'call-1'
      }
    })
  ).toMatchObject({
    item: {
      type: 'function_call',
      namespace: 'mcp__open_science_notebook',
      name: 'repl_execute'
    }
  })

  expect(
    projection.restore({
      id: 'resp-1',
      output: [
        {
          type: 'function_call',
          name: 'mcp__open_science_notebook__repl_execute',
          arguments: '{}',
          call_id: 'call-1'
        }
      ]
    })
  ).toMatchObject({
    output: [
      {
        namespace: 'mcp__open_science_notebook',
        name: 'repl_execute'
      }
    ]
  })
})

it.each(['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview'])(
  'keeps native Responses thinking enabled for %s',
  (model) => {
    const body = { model, reasoning: { effort: 'none', summary: 'auto' }, input: 'Hello' }
    const { request } = prepareNativeResponsesRequest(body, 'minimax')
    expect(request.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(body.reasoning.effort).toBe('none')
  }
)

it.each([
  ['minimax', 'MiniMax-M3', 'none'],
  [undefined, 'MiniMax-M3.1-Flash', 'none'],
  ['minimax', 'MiniMax-M3.1-Flash', 'high'],
  ['minimax', 'MiniMax-M3.1-Flash', undefined]
])('preserves native reasoning for vendor %s model %s effort %s', (vendorId, model, effort) => {
  const body = { model, ...(effort ? { reasoning: { effort } } : {}) }
  expect(prepareNativeResponsesRequest(body, vendorId).request).toEqual(body)
})
