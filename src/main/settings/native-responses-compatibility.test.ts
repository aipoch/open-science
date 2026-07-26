import { describe, expect, it, vi } from 'vitest'

import {
  NativeResponsesCompatibilityProxy,
  flattenNativeResponsesRequest,
  restoreNativeResponsesPayload
} from './native-responses-compatibility'

describe('native Responses compatibility', () => {
  it('flattens namespace tools and matching history without changing plain functions', () => {
    const { request, aliases } = flattenNativeResponsesRequest({
      model: 'MiniMax-M3',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__open_science_notebook',
          description: 'Open Science notebook tools.',
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

    expect(request.tools).toEqual([
      {
        type: 'function',
        name: 'mcp__open_science_notebook__repl_execute',
        description: 'Open Science notebook tools.\n\nRun control-plane JavaScript.',
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
    expect(request.input[0]).toMatchObject({
      type: 'function_call',
      name: 'mcp__open_science_notebook__repl_execute'
    })
    expect(request.input[0]).not.toHaveProperty('namespace')
    expect(aliases.get('mcp__open_science_notebook__repl_execute')).toEqual({
      namespace: 'mcp__open_science_notebook',
      name: 'repl_execute'
    })
  })

  it('rejects an alias collision instead of routing a tool ambiguously', () => {
    expect(() =>
      flattenNativeResponsesRequest({
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
    const aliases = new Map([
      [
        'mcp__open_science_notebook__repl_execute',
        { namespace: 'mcp__open_science_notebook', name: 'repl_execute' }
      ]
    ])

    expect(
      restoreNativeResponsesPayload(
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            name: 'mcp__open_science_notebook__repl_execute',
            arguments: '{}',
            call_id: 'call-1'
          }
        },
        aliases
      )
    ).toMatchObject({
      item: {
        type: 'function_call',
        namespace: 'mcp__open_science_notebook',
        name: 'repl_execute'
      }
    })

    expect(
      restoreNativeResponsesPayload(
        {
          id: 'resp-1',
          output: [
            {
              type: 'function_call',
              name: 'mcp__open_science_notebook__repl_execute',
              arguments: '{}',
              call_id: 'call-1'
            }
          ]
        },
        aliases
      )
    ).toMatchObject({
      output: [
        {
          namespace: 'mcp__open_science_notebook',
          name: 'repl_execute'
        }
      ]
    })
  })

  it('selects matching Skills through the native Responses endpoint', async () => {
    const fetchImpl = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        void url
        void init
        return new Response(
          JSON.stringify({
            id: 'resp-skills',
            output: [
              {
                type: 'function_call',
                name: 'select_skills',
                call_id: 'call-skills',
                arguments: '{"skill_names":["mcp-pubmed"]}'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      {
        baseUrl: 'https://api.minimaxi.com/v1',
        key: 'secret',
        model: 'MiniMax-M3'
      },
      fetchImpl
    )
    const catalog = [
      { name: 'mcp-pubmed', description: 'Search PubMed.', path: '/skills/pubmed/SKILL.md' },
      { name: 'mcp-chemistry', description: 'Search chemistry.', path: '/skills/chem/SKILL.md' }
    ]

    await expect(proxy.selectSkills('用 PubMed 搜索肿瘤免疫文章', catalog)).resolves.toEqual([
      { name: 'mcp-pubmed', path: '/skills/pubmed/SKILL.md' }
    ])
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://api.minimaxi.com/v1/responses')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'MiniMax-M3',
      stream: false,
      tool_choice: { type: 'function', name: 'select_skills' },
      tools: [expect.objectContaining({ type: 'function', name: 'select_skills' })]
    })
  })
})
