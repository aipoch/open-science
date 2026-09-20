import { describe, expect, it, vi } from 'vitest'

import { ResponsesBridge } from './responses-bridge'

const planNamespace = {
  type: 'namespace',
  name: 'mcp__open_science_plan',
  description: 'Session Plan tools.',
  tools: [
    {
      type: 'function',
      name: 'generate_plan',
      description: 'Create a Session Plan.',
      parameters: {
        type: 'object',
        properties: { task_summary: { type: 'string' } },
        required: ['task_summary']
      }
    },
    {
      type: 'function',
      name: 'update_step_status',
      description: 'Report Plan progress.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, status: { type: 'string' } },
        required: ['title', 'status']
      }
    },
    {
      type: 'function',
      name: 'private_plan_helper',
      description: 'Must remain unavailable.',
      parameters: { type: 'object' }
    }
  ]
}

const request = async (
  connection: { baseUrl: string; token: string },
  input: unknown,
  tools: unknown[],
  promptCacheKey = 'primary-session'
): Promise<{ output: Array<Record<string, unknown>> }> => {
  const response = await fetch(`${connection.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${connection.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'catalog-model',
      input,
      prompt_cache_key: promptCacheKey,
      stream: false,
      tools,
      tool_choice: 'auto'
    })
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<{ output: Array<Record<string, unknown>> }>
}

describe('Responses bridge request-local Plan tools', () => {
  it('forwards the live Plan catalog and maps an upstream call back to its namespace', async () => {
    const upstreamRequests: Record<string, unknown>[] = []
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://fixture.invalid/v1', model: 'deepseek-flash' },
      vi.fn(async (_url, init) => {
        upstreamRequests.push(JSON.parse(String(init?.body)))
        if (upstreamRequests.length > 1) {
          return Response.json({
            id: 'chat-after-plan-call',
            model: 'deepseek-flash',
            choices: [{ message: { role: 'assistant', content: 'Plan received.' } }]
          })
        }
        return new Response(
          [
            `data: ${JSON.stringify({
              id: 'chat-plan-call',
              model: 'deepseek-flash',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-generate-plan',
                        type: 'function',
                        function: {
                          name: 'mcp__open_science_plan__generate_plan',
                          arguments: '{"task_summary":"Analyze the data"}'
                        }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })}`,
            '',
            `data: ${JSON.stringify({
              id: 'chat-plan-call',
              model: 'deepseek-flash',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
            })}`,
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const connection = await bridge.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'catalog-model',
          input: 'Plan the analysis.',
          prompt_cache_key: 'primary-session',
          stream: true,
          tools: [planNamespace],
          tool_choice: 'auto'
        })
      })
      expect(response.status).toBe(200)
      const output = await response.text()
      const offered = (upstreamRequests[0].tools as Array<{ function: { name: string } }>).map(
        (tool: { function: { name: string } }) => tool.function.name
      )

      expect(offered).toEqual([
        'mcp__open_science_plan__generate_plan',
        'mcp__open_science_plan__update_step_status'
      ])
      expect(JSON.stringify(upstreamRequests[0])).not.toContain('private_plan_helper')
      expect(output).toContain('"type":"function_call"')
      expect(output).toContain('"namespace":"mcp__open_science_plan"')
      expect(output).toContain('"name":"generate_plan"')
      expect(output).toContain('"call_id":"call-generate-plan"')
      expect(output).not.toContain('"name":"mcp__open_science_plan__generate_plan"')

      await request(
        connection,
        [
          {
            type: 'function_call',
            namespace: 'mcp__open_science_plan',
            name: 'generate_plan',
            call_id: 'call-generate-plan',
            arguments: '{"task_summary":"Analyze the data"}'
          },
          {
            type: 'function_call_output',
            call_id: 'call-generate-plan',
            output: '{"kind":"plan","lifecycle":"awaiting_approval"}'
          }
        ],
        [planNamespace],
        'primary-session'
      )
      const followupMessages = upstreamRequests[1].messages as Array<Record<string, unknown>>
      expect(followupMessages).toEqual([
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-generate-plan',
              type: 'function',
              function: {
                name: 'mcp__open_science_plan__generate_plan',
                arguments: '{"task_summary":"Analyze the data"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'call-generate-plan',
          content: '{"kind":"plan","lifecycle":"awaiting_approval"}'
        }
      ])
    } finally {
      await bridge.close()
    }
  })

  it('does not expose Plan tools without the current request capability or inside narrow scopes', async () => {
    const upstreamRequests: Record<string, unknown>[] = []
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://fixture.invalid/v1', model: 'deepseek-flash' },
      vi.fn(async (_url, init) => {
        upstreamRequests.push(JSON.parse(String(init?.body)))
        return Response.json({
          id: 'chat-no-plan-call',
          model: 'deepseek-flash',
          choices: [{ message: { role: 'assistant', content: 'No Plan call.' } }]
        })
      })
    )
    const connection = await bridge.start()

    try {
      await request(connection, 'No capability.', [])
      bridge.registerReviewerSession('reviewer-session')
      await request(connection, 'Review only.', [planNamespace], 'reviewer-session')
      bridge.registerToolLessSession('tool-less-session')
      await request(connection, 'Reconstruct only.', [planNamespace], 'tool-less-session')
      bridge.registerHostMessageSession('host-message-session', [], {
        failClosedUnknownKeys: true
      })
      await request(connection, 'Host message only.', [planNamespace], 'host-message-session')

      for (const upstreamRequest of upstreamRequests) {
        expect(JSON.stringify(upstreamRequest)).not.toContain('generate_plan')
        expect(JSON.stringify(upstreamRequest)).not.toContain('update_step_status')
      }
    } finally {
      await bridge.close()
    }
  })
})
