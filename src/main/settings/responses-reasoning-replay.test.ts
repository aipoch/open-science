import { describe, expect, it } from 'vitest'

import { ResponsesBridge } from './responses-bridge'

type Json = Record<string, unknown>

// Drive the real loopback HTTP boundary; only the external provider is controlled.
const createReplayHarness = async (
  replies: Array<{ id?: string; message: Json }>,
  options: ConstructorParameters<typeof ResponsesBridge>[2] = {}
): Promise<{
  bridge: ResponsesBridge
  requests: Array<{ messages: Json[] }>
  post: (input: unknown, scope?: string | null) => Promise<Json[]>
}> => {
  const requests: Array<{ messages: Json[] }> = []
  const bridge = new ResponsesBridge(
    { baseUrl: 'https://provider.example/v1', model: 'deepseek-flash' },
    async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const reply = replies[requests.length - 1]
      return Response.json({
        id: reply?.id,
        choices: [{ message: reply?.message ?? { role: 'assistant', content: 'done' } }]
      })
    },
    options
  )
  const connection = await bridge.start()
  return {
    bridge,
    requests,
    post: async (input, scope = 'session-a') => {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          input,
          ...(scope ? { prompt_cache_key: scope } : {}),
          stream: false
        })
      })
      const body = await response.json()
      expect(response.status, JSON.stringify(body)).toBe(200)
      return body.output
    }
  }
}

const missingReasoning =
  'The `reasoning_content` in the thinking mode must be passed back to the API.'

describe('thinking-mode history through the Responses bridge', () => {
  it.each([
    { stream: false, content: '', callsTool: true },
    { stream: true, content: '', callsTool: true },
    { stream: false, content: 'I will inspect the Python and R environments.', callsTool: true },
    { stream: true, content: 'I will inspect the Python and R environments.', callsTool: true },
    { stream: false, content: 'Python is available.', callsTool: false },
    { stream: true, content: 'Python is available.', callsTool: false }
  ])(
    'replays reasoning with assistant text and tool calls (stream=$stream, content="$content")',
    async ({ stream, content, callsTool }) => {
      const reasoning = 'Inspect the available runtimes before answering.'
      const toolCall = {
        id: 'call-runtime',
        type: 'function',
        function: { name: 'list_notebook_runtimes', arguments: '{}' }
      }
      const requests: Array<{ messages: Array<Record<string, unknown>> }> = []
      const bridge = new ResponsesBridge(
        { baseUrl: 'https://provider.example/v1', model: 'deepseek-flash' },
        async (_url, init) => {
          const request = JSON.parse(String(init?.body))
          requests.push(request)
          if (requests.length > 1) {
            const assistants = request.messages.filter(
              (message: Record<string, unknown>) => message.role === 'assistant'
            )
            if (assistants.some((message: Record<string, unknown>) => !message.reasoning_content)) {
              return Response.json({ error: { message: missingReasoning } }, { status: 400 })
            }
            return Response.json({
              id: 'chat-next',
              choices: [{ message: { role: 'assistant', content: 'Python is available.' } }]
            })
          }
          if (!stream) {
            return Response.json({
              id: 'chat-runtime',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content,
                    reasoning_content: reasoning,
                    ...(callsTool ? { tool_calls: [toolCall] } : {})
                  }
                }
              ]
            })
          }
          const chunk = (delta: unknown, finishReason: string | null = null): string =>
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
          return new Response(
            chunk({ reasoning_content: reasoning }) +
              chunk({ content }) +
              (callsTool ? chunk({ tool_calls: [{ ...toolCall, index: 0 }] }) : '') +
              chunk({}, callsTool ? 'tool_calls' : 'stop') +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      )
      const connection = await bridge.start()
      const post = (input: unknown, wantsStream: boolean): Promise<Response> =>
        fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'catalog-model',
            prompt_cache_key: 'runtime-session',
            input,
            tools: [
              { type: 'function', name: 'list_notebook_runtimes', parameters: { type: 'object' } }
            ],
            stream: wantsStream
          })
        })
      try {
        const user = {
          type: 'message',
          role: 'user',
          content: 'Inspect my Python and R environments.'
        }
        const first = await post([user], stream)
        expect(first.status).toBe(200)
        const firstBody = await first.text()
        const output = stream
          ? JSON.parse(
              firstBody
                .split('\n')
                .find(
                  (line) =>
                    line.startsWith('data: ') && line.includes('"type":"response.completed"')
                )!
                .slice(6)
            ).response.output
          : JSON.parse(firstBody).output
        const second = await post(
          [
            user,
            ...output,
            callsTool
              ? { type: 'function_call_output', call_id: toolCall.id, output: 'Python ready' }
              : { type: 'message', role: 'user', content: 'What about R?' }
          ],
          false
        )
        const secondBody = await second.text()
        if (callsTool)
          expect(
            requests[1].messages.find((message) => message.tool_calls)?.reasoning_content
          ).toBe(reasoning)
        expect(second.status, secondBody).toBe(200)
        expect(requests[1].messages.filter((message) => message.role === 'assistant')).toEqual([
          {
            role: 'assistant',
            ...(content ? { content: [{ type: 'text', text: content }] } : {}),
            reasoning_content: reasoning,
            ...(callsTool ? { tool_calls: [toolCall] } : {})
          }
        ])
      } finally {
        await bridge.close()
      }
    }
  )

  it('preserves four parallel calls, a failed R result, and later text-only reasoning', async () => {
    const tools = [
      'list_notebook_runtimes',
      'notebook_execute',
      'notebook_execute',
      'bash_execute'
    ].map((name, index) => ({
      id: `call-${index}`,
      type: 'function',
      function: { name, arguments: '{}' }
    }))
    const firstMessage = {
      role: 'assistant',
      content: 'Inspect Python and R.',
      reasoning_content: 'Inspect first.',
      tool_calls: tools
    }
    const secondMessage = {
      role: 'assistant',
      content: 'Python works; R failed.',
      reasoning_content: 'Explain the failed R startup.'
    }
    const h = await createReplayHarness([
      { id: 'first', message: firstMessage },
      { id: 'second', message: secondMessage }
    ])
    try {
      const user = { type: 'message', role: 'user', content: 'Inspect my runtimes.' }
      const first = await h.post([user])
      const results = tools.map((tool, index) => ({
        type: 'function_call_output',
        call_id: tool.id,
        output: index === 2 ? '{"status":"failed","error":"R startup failed"}' : 'ok'
      }))
      const second = await h.post([user, ...first, ...results])
      await h.post([
        user,
        ...first,
        ...results,
        ...second,
        { type: 'message', role: 'user', content: 'What can I try next?' }
      ])
      const assistants = h.requests[2].messages.filter((message) => message.role === 'assistant')
      expect(assistants).toEqual([
        { ...firstMessage, content: [{ type: 'text', text: firstMessage.content }] },
        { ...secondMessage, content: [{ type: 'text', text: secondMessage.content }] }
      ])
      expect(h.requests[1].messages.filter((message) => message.role === 'tool')).toEqual(
        results.map((result) => ({
          role: 'tool',
          tool_call_id: result.call_id,
          content: result.output
        }))
      )
    } finally {
      await h.bridge.close()
    }
  })

  it('keeps equal reasoning from distinct replies separate, including missing upstream IDs', async () => {
    const message = { role: 'assistant', content: 'Checking.', reasoning_content: 'Think.' }
    const toolCall = {
      id: 'tool',
      type: 'function',
      function: { name: 'inspect', arguments: '{}' }
    }
    const h = await createReplayHarness([
      { message },
      { message: { ...message, tool_calls: [toolCall] } }
    ])
    try {
      const first = await h.post('first')
      const second = await h.post(first)
      expect(first[0].id).not.toBe(second[0].id)
      // The same reply's tools may precede its text in Responses output. Neither ordering nor
      // identical text makes the earlier, distinct reply part of this tool-calling message.
      await h.post([...first, ...second.toReversed()])
      expect(h.requests[2].messages).toEqual([
        { ...message, content: [{ type: 'text', text: message.content }] },
        { ...message, content: [{ type: 'text', text: message.content }], tool_calls: [toolCall] }
      ])
    } finally {
      await h.bridge.close()
    }
  })

  it('isolates reused text IDs by Session and prunes items removed from the active history', async () => {
    const h = await createReplayHarness([
      { id: 'reused', message: { role: 'assistant', content: 'A', reasoning_content: 'Reason A' } },
      { id: 'reused', message: { role: 'assistant', content: 'B', reasoning_content: 'Reason B' } }
    ])
    try {
      const a = await h.post('first', 'session-a')
      const b = await h.post('first', 'session-b')
      await h.post(a, 'session-a')
      await h.post(b, 'session-b')
      expect(h.requests[2].messages[0].reasoning_content).toBe('Reason A')
      expect(h.requests[3].messages[0].reasoning_content).toBe('Reason B')
      await h.post('new branch', 'session-a')
      await h.post(a, 'session-a')
      expect(h.requests[5].messages[0]).not.toHaveProperty('reasoning_content')
    } finally {
      await h.bridge.close()
    }
  })

  it.each([{ reasoningCacheMaxEntries: 1 }, { reasoningCacheMaxCharacters: 3 }])(
    'bounds text reasoning with the existing cache quota (%j)',
    async (options) => {
      const h = await createReplayHarness(
        [
          { id: 'a', message: { role: 'assistant', content: 'A', reasoning_content: 'aaa' } },
          { id: 'b', message: { role: 'assistant', content: 'B', reasoning_content: 'bbb' } }
        ],
        options
      )
      try {
        const a = await h.post('first', 'session-a')
        const b = await h.post('first', 'session-b')
        await h.post(a, 'session-a')
        await h.post(b, 'session-b')
        expect(h.requests[2].messages[0]).not.toHaveProperty('reasoning_content')
        expect(h.requests[3].messages[0].reasoning_content).toBe('bbb')
      } finally {
        await h.bridge.close()
      }
    }
  )

  it('never replays text reasoning without a Session scope or after a provider switch', async () => {
    const h = await createReplayHarness([
      {
        id: 'unscoped',
        message: { role: 'assistant', content: 'A', reasoning_content: 'private' }
      },
      {
        id: 'scoped',
        message: { role: 'assistant', content: 'B', reasoning_content: 'scoped thought' }
      }
    ])
    try {
      const unscoped = await h.post('first', null)
      const scoped = await h.post('first')
      await h.post(unscoped, null)
      expect(h.requests[2].messages[0]).not.toHaveProperty('reasoning_content')
      h.bridge.setTarget({ baseUrl: 'https://other.example/v1', model: 'other' })
      await h.post(scoped)
      expect(h.requests[3].messages[0]).not.toHaveProperty('reasoning_content')
    } finally {
      await h.bridge.close()
    }
  })
})
