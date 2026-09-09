import { expect, it } from 'vitest'
import { ResponsesBridge } from './responses-bridge'

it.each(['primary', 'reviewer', 'tool-less', 'host-message', 'unknown-host-message'])(
  'preserves only the current Skill loader schema for a %s bridge session',
  async (role) => {
    const requests: Record<string, unknown>[] = []
    const bridge = new ResponsesBridge(
      { baseUrl: 'https://fixture.invalid/v1' },
      async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({
          id: 'load',
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call-load',
                    type: 'function',
                    function: {
                      name: 'mcp__skills__load_skill',
                      arguments: '{"skill":"mcp-genomes"}'
                    }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        })
      }
    )
    if (role === 'reviewer') bridge.registerReviewerSession('session')
    if (role === 'tool-less') bridge.registerToolLessSession('session')
    if (role === 'host-message' || role === 'unknown-host-message') {
      bridge.registerHostMessageSession(
        role === 'host-message' ? 'session' : 'another-session',
        [],
        {
          failClosedUnknownKeys: true
        }
      )
    }
    const connection = await bridge.start()
    const parameters = {
      type: 'object',
      properties: { skill: { enum: ['mcp-genomes'] } },
      required: ['skill']
    }
    try {
      for (const present of [true, false]) {
        const response = await fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'fixture',
            prompt_cache_key: 'session',
            input: 'Use genomes',
            stream: false,
            tools: present
              ? [
                  {
                    type: 'namespace',
                    name: 'mcp__skills',
                    tools: [
                      {
                        type: 'function',
                        name: 'load_skill',
                        description: 'Load current Skill',
                        parameters
                      },
                      { type: 'function', name: 'unrelated', parameters: { type: 'object' } }
                    ]
                  }
                ]
              : []
          })
        })
        const result = await response.json()
        expect(response.status).toBe(200)
        const offered = requests.at(-1)!.tools ?? []
        if (role === 'primary' && present) {
          expect(offered).toEqual([
            {
              type: 'function',
              function: {
                name: 'mcp__skills__load_skill',
                description: 'Load current Skill',
                parameters
              }
            }
          ])
          expect(result.output[0]).toMatchObject({ namespace: 'mcp__skills', name: 'load_skill' })
        } else {
          expect(offered).toEqual([])
        }
      }
    } finally {
      await bridge.close()
    }
  }
)
