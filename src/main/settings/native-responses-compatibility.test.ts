import { afterEach, describe, expect, it, vi } from 'vitest'

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => logSpies
}))

import {
  NativeResponsesCompatibilityProxy,
  flattenNativeResponsesRequest,
  restoreNativeResponsesPayload
} from './native-responses-compatibility'
import { CODEX_NATIVE_TOOL_IMAGE_REQUEST_FIXTURE } from './provider-tool-image-wire.test-fixtures'

afterEach(() => {
  for (const spy of Object.values(logSpies)) spy.mockClear()
})

describe('native Responses compatibility', () => {
  it.each([
    ['JSON', 'application/json', JSON.stringify({ id: 'response', output: [] })],
    ['binary', 'application/octet-stream', 'binary']
  ])(
    'rejects an oversized successful %s response before reading its body',
    async (_, type, body) => {
      let cancelBody: ReturnType<typeof vi.spyOn> | undefined
      const fetchImpl = vi.fn(async () => {
        const response = new Response(body, {
          status: 200,
          headers: {
            'content-type': type,
            'content-length': String(64 * 1024 * 1024 + 1)
          }
        })
        cancelBody = vi.spyOn(response.body!, 'cancel')
        return response
      })
      const proxy = new NativeResponsesCompatibilityProxy(
        { baseUrl: 'https://provider.example.test/v1', model: 'model-a' },
        fetchImpl
      )
      const connection = await proxy.start()

      try {
        const response = await fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ input: 'hello', stream: false })
        })

        expect(response.status).toBe(502)
        await expect(response.json()).resolves.toMatchObject({ error: { type: 'api_error' } })
        expect(cancelBody).toHaveBeenCalledOnce()
      } finally {
        await proxy.close()
      }
    }
  )

  it.each([
    ['response', ['data: 123\n\n', 'unused'], 10, 16, 24],
    ['line', ['12345678', '12345678', '12345678', '12345678'], 64, 16, 64],
    ['event', ['data: 123456\n', 'data: 123456\n', '\n'], 64, 16, 24]
  ])(
    'cancels an SSE response whose current %s exceeds its limit while chunks remain active',
    async (_, chunks, maxResponseBytes, maxSseLineBytes, maxSseEventBytes) => {
      let cancelled = false
      let index = 0
      const encoder = new TextEncoder()
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks[index++]
                if (chunk === undefined) controller.close()
                else controller.enqueue(encoder.encode(chunk))
              },
              cancel() {
                cancelled = true
              }
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } }
          )
      )
      const proxy = new NativeResponsesCompatibilityProxy(
        { baseUrl: 'https://provider.example.test/v1', model: 'model-a' },
        fetchImpl,
        { maxResponseBytes, maxSseLineBytes, maxSseEventBytes }
      )
      const connection = await proxy.start()

      try {
        const response = await fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ input: 'hello', stream: true })
        })

        expect(response.status).toBe(502)
        await expect(response.json()).resolves.toMatchObject({ error: { type: 'api_error' } })
        expect(cancelled).toBe(true)
      } finally {
        await proxy.close()
      }
    }
  )

  it('retargets endpoint, credential, and model without replacing the loopback connection', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: 'response', output: [], usage: { input_tokens: 1, output_tokens: 1 } })
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://a.example/v1', key: 'key-a', model: 'model-a' },
      fetchImpl
    )
    const connection = await proxy.start()
    const send = async (): Promise<void> => {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'untrusted', input: 'hello', stream: false })
      })
      expect(response.status).toBe(200)
    }

    try {
      await send()
      proxy.setTarget({ baseUrl: 'https://b.example/custom', key: 'key-b', model: 'model-b' })
      await send()

      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        'https://a.example/v1/responses',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer key-a' }),
          body: expect.stringContaining('"model":"model-a"')
        })
      )
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        'https://b.example/custom/responses',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer key-b' }),
          body: expect.stringContaining('"model":"model-b"')
        })
      )
    } finally {
      await proxy.close()
    }
  })

  it('retargets the upstream model without replacing endpoint credentials', () => {
    const proxy = new NativeResponsesCompatibilityProxy({
      baseUrl: 'https://api.minimaxi.com/v1',
      key: 'secret',
      model: 'MiniMax-M3'
    })

    proxy.setModelTarget({ model: 'MiniMax-M4' })

    expect((proxy as unknown as { target: Record<string, unknown> }).target).toEqual({
      baseUrl: 'https://api.minimaxi.com/v1',
      key: 'secret',
      model: 'MiniMax-M4'
    })
  })

  it('returns 400 when a valid JSON request has malformed tool declarations', async () => {
    const fetchImpl = vi.fn()
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://provider.example.test/v1', key: 'key-a', model: 'model-a' },
      fetchImpl
    )
    const connection = await proxy.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ input: 'hello', tools: { type: 'function' } })
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: { type: 'invalid_request_error' }
      })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      await proxy.close()
    }
  })

  it('replays an identical deterministic provider error without a second upstream request', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { type: 'authentication_error', message: 'Incorrect API key provided' } },
        { status: 401 }
      )
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://provider.example.test/v1', key: 'wrong-key', model: 'model-a' },
      fetchImpl
    )
    const connection = await proxy.start()
    const send = (): Promise<Response> =>
      fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello', stream: true })
      })

    try {
      const first = await send()
      const second = await send()

      expect(first.status).toBe(400)
      expect(second.status).toBe(400)
      expect(second.headers.get('x-open-science-upstream-status')).toBe('401')
      await expect(second.json()).resolves.toMatchObject({
        error: { type: 'authentication_error', message: 'Incorrect API key provided' }
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      await proxy.close()
    }
  })

  it.each([
    ['empty', ''],
    ['malformed', '{not-json']
  ])(
    'replays an identical deterministic provider error with a %s JSON body',
    async (_name, body) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(body, { status: 401, headers: { 'content-type': 'application/json' } })
      )
      const proxy = new NativeResponsesCompatibilityProxy(
        { baseUrl: 'https://provider.example.test/v1', key: 'wrong-key', model: 'model-a' },
        fetchImpl
      )
      const connection = await proxy.start()
      const send = (): Promise<Response> =>
        fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ model: 'ignored', input: 'hello', stream: true })
        })

      try {
        const first = await send()
        const second = await send()
        expect(first.status).toBe(400)
        expect(second.status).toBe(400)
        expect(first.headers.get('x-open-science-upstream-status')).toBe('401')
        expect(second.headers.get('x-open-science-upstream-status')).toBe('401')
        expect(fetchImpl).toHaveBeenCalledOnce()
      } finally {
        await proxy.close()
      }
    }
  )

  it('does not replay an error after an upstream-visible request header changes', async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      return headers.get('x-provider-feature') === 'invalid'
        ? Response.json({ error: { message: 'Invalid feature' } }, { status: 400 })
        : Response.json({
            id: 'response',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 }
          })
    })
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://provider.example.test/v1', key: 'key-a', model: 'model-a' },
      fetchImpl
    )
    const connection = await proxy.start()
    const send = (feature?: string): Promise<Response> =>
      fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json',
          ...(feature ? { 'x-provider-feature': feature } : {})
        },
        body: JSON.stringify({ model: 'ignored', input: 'hello', stream: false })
      })

    try {
      expect((await send('invalid')).status).toBe(400)
      expect((await send()).status).toBe(200)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      await proxy.close()
    }
  })

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

  it('preserves the captured Codex MCP image fixture through the final native Responses request', () => {
    const { request } = flattenNativeResponsesRequest(CODEX_NATIVE_TOOL_IMAGE_REQUEST_FIXTURE)

    expect(request.input).toEqual([
      {
        type: 'function_call',
        name: 'mcp__fixture__show_image',
        arguments: '{}',
        call_id: 'call_fixture_1'
      },
      CODEX_NATIVE_TOOL_IMAGE_REQUEST_FIXTURE.input[1]
    ])
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

  it('promotes Artifact guidance when a Notebook run returns a generated file', async () => {
    const privateAssistantText = 'I will export the private result as an artifact:'
    let upstreamRequest: Record<string, unknown> | undefined
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamRequest = body
      const artifactRequired =
        typeof body.instructions === 'string' &&
        body.instructions.includes('<open_science_artifact_instructions>')
      const output = artifactRequired
        ? {
            id: 'artifact-call-item-1',
            type: 'function_call',
            name: 'mcp__open_science_artifacts__write_artifact_file',
            call_id: 'artifact-call-1',
            arguments: JSON.stringify({
              filename: 'private.png',
              mimeType: 'image/png',
              source: { kind: 'localPath', path: 'data/private.png' },
              producerRunId: 'notebook-run-1'
            })
          }
        : {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: privateAssistantText }]
          }
      const upstream = [
        { type: 'response.output_item.done', output_index: 0, item: output },
        {
          type: 'response.completed',
          response: {
            id: 'response-1',
            status: 'completed',
            output: [output]
          }
        },
        '[DONE]'
      ]
        .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
        .join('')
      return new Response(upstream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.example/v1', model: 'model-a' },
      fetchImpl
    )
    const connection = await proxy.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          stream: true,
          instructions: 'base provider instructions',
          input: [
            {
              type: 'message',
              role: 'developer',
              content:
                '<open_science_artifact_instructions>private guidance</open_science_artifact_instructions>'
            },
            {
              type: 'function_call',
              namespace: 'mcp__open_science_notebook',
              name: 'notebook_execute',
              call_id: 'notebook-call-1',
              arguments: '{}'
            },
            {
              type: 'function_call_output',
              call_id: 'notebook-call-1',
              output:
                '{"runId":"notebook-run-1","workingFiles":[{"relativePath":"data/private.png"}]}'
            }
          ],
          tools: [
            {
              type: 'namespace',
              name: 'mcp__open_science_notebook',
              tools: [
                {
                  type: 'function',
                  name: 'notebook_execute',
                  parameters: { type: 'object' }
                }
              ]
            },
            {
              type: 'namespace',
              name: 'mcp__open_science_artifacts',
              tools: [
                {
                  type: 'function',
                  name: 'write_artifact_file',
                  parameters: { type: 'object' }
                }
              ]
            }
          ]
        })
      })

      const responseBody = await response.text()
      expect(response.ok, responseBody).toBe(true)
      expect(responseBody).toContain('response.completed')
      expect(responseBody).not.toContain(privateAssistantText)
      expect(responseBody).toContain('write_artifact_file')
      expect(upstreamRequest?.instructions).toContain('base provider instructions')
      expect(upstreamRequest?.instructions).toContain(
        '<open_science_artifact_instructions>private guidance</open_science_artifact_instructions>'
      )
      expect(JSON.stringify(upstreamRequest?.input)).not.toContain(
        '<open_science_artifact_instructions>'
      )
      const requestLog = logSpies.info.mock.calls.find(
        ([message]) => message === 'native Responses compatibility request'
      )
      const streamLog = logSpies.info.mock.calls.find(
        ([message]) => message === 'native Responses compatibility stream completed'
      )
      expect(requestLog?.[1]).toMatchObject({
        topLevelArtifactInstructionPresent: true,
        developerArtifactInstructionPresent: false,
        artifactInstructionPresent: true,
        artifactToolPresent: true,
        functionCallOutputHistoryCount: 1
      })
      expect(streamLog?.[1]).toMatchObject({
        requestId: requestLog?.[1]?.requestId,
        terminalEventType: 'response.completed',
        terminalStatus: 'completed',
        terminalOutputItemCount: 1,
        terminalMessageCount: 0,
        observedFunctionCallCount: 1,
        observedArtifactFunctionCallCount: 1
      })
      expect(
        JSON.stringify(Object.values(logSpies).flatMap((spy) => spy.mock.calls))
      ).not.toContain(privateAssistantText)
    } finally {
      await proxy.close()
    }
  })

  it('counts an Artifact call emitted before a sparse terminal event', async () => {
    const artifactCall = {
      id: 'artifact-call-item-1',
      type: 'function_call',
      name: 'mcp__open_science_artifacts__write_artifact_file',
      call_id: 'artifact-call-1',
      arguments: '{}'
    }
    const upstream = [
      { type: 'response.output_item.added', output_index: 0, item: artifactCall },
      { type: 'response.output_item.done', output_index: 0, item: artifactCall },
      {
        type: 'response.completed',
        response: {
          id: 'response-1',
          status: 'completed',
          output: [{ ...artifactCall, id: undefined }]
        }
      },
      '[DONE]'
    ]
      .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
      .join('')
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.example/v1', model: 'model-a' },
      vi.fn(
        async () =>
          new Response(upstream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
      )
    )
    const connection = await proxy.start()

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          stream: true,
          input: [],
          tools: [
            {
              type: 'namespace',
              name: 'mcp__open_science_artifacts',
              tools: [
                {
                  type: 'function',
                  name: 'write_artifact_file',
                  parameters: { type: 'object' }
                }
              ]
            }
          ]
        })
      })

      expect(response.ok, await response.text()).toBe(true)
      const streamLog = logSpies.info.mock.calls.find(
        ([message]) => message === 'native Responses compatibility stream completed'
      )
      expect(streamLog?.[1]).toMatchObject({
        terminalEventType: 'response.completed',
        terminalOutputItemCount: 1,
        observedFunctionCallCount: 1,
        observedArtifactFunctionCallCount: 1
      })
    } finally {
      await proxy.close()
    }
  })

  it('aborts a native Responses stream after the configured idle period', async () => {
    let upstreamSignal: AbortSignal | undefined
    let failUpstream: ((reason?: unknown) => void) | undefined
    const upstreamRequested = Promise.withResolvers<void>()
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamSignal = init?.signal ?? undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"working"}\n\n'
              )
            )
            failUpstream = (reason) => controller.error(reason)
            upstreamSignal?.addEventListener(
              'abort',
              () => failUpstream?.(upstreamSignal?.reason),
              {
                once: true
              }
            )
          }
        })
        upstreamRequested.resolve()
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
      fetchImpl,
      { streamIdleTimeoutMs: 25 }
    )
    const connection = await proxy.start()

    try {
      const responsePromise = fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'analyze', stream: true })
      })
      await upstreamRequested.promise
      const response = await responsePromise
      const body = response.text()

      const outcome = await Promise.race([
        body.then(
          () => 'completed',
          (error: unknown) => error
        ),
        new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 500))
      ])

      expect(outcome).toBeInstanceOf(Error)
      expect(upstreamSignal?.aborted).toBe(true)
      expect(logSpies.warn.mock.calls).toContainEqual([
        'native Responses compatibility request failed',
        expect.objectContaining({
          phase: 'forward-response',
          outcome: 'error',
          errorCategory: 'timeout'
        })
      ])
    } finally {
      failUpstream?.()
      await proxy.close()
    }
  })

  it('keeps a native Responses stream open while upstream events continue', async () => {
    let upstreamSignal: AbortSignal | undefined
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamSignal = init?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller
              controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'))
              upstreamSignal?.addEventListener(
                'abort',
                () => controller.error(upstreamSignal?.reason),
                { once: true }
              )
            }
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
      fetchImpl,
      { streamIdleTimeoutMs: 200 }
    )
    const connection = await proxy.start()
    let eventIndex = 0
    let interval: ReturnType<typeof setInterval> | undefined
    let completion: ReturnType<typeof setTimeout> | undefined

    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'analyze', stream: true })
      })
      interval = setInterval(() => {
        eventIndex += 1
        upstreamController?.enqueue(
          encoder.encode(`data: {"type":"response.output_text.delta","delta":"${eventIndex}"}\n\n`)
        )
      }, 20)
      completion = setTimeout(() => {
        if (interval) clearInterval(interval)
        upstreamController?.close()
      }, 300)

      const body = await response.text()

      expect(body).toContain('response.output_text.delta')
      expect(upstreamSignal?.aborted).toBe(false)
    } finally {
      if (interval) clearInterval(interval)
      if (completion) clearTimeout(completion)
      await proxy.close()
    }
  })

  it('aborts a blocking native Responses body after the configured idle period', async () => {
    let upstreamSignal: AbortSignal | undefined
    let failUpstream: ((reason?: unknown) => void) | undefined
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamSignal = init?.signal ?? undefined
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              failUpstream = (reason) => controller.error(reason)
              upstreamSignal?.addEventListener(
                'abort',
                () => failUpstream?.(upstreamSignal?.reason),
                { once: true }
              )
            }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
      fetchImpl,
      { streamIdleTimeoutMs: 25 }
    )
    const connection = await proxy.start()

    try {
      const outcome = await Promise.race([
        fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'analyze', stream: false })
        }),
        new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 500))
      ])

      expect(outcome).toBeInstanceOf(Response)
      const response = outcome as Response
      expect(response.status).toBe(502)
      expect(upstreamSignal?.aborted).toBe(true)
      expect(logSpies.warn.mock.calls).toContainEqual([
        'native Responses compatibility request failed',
        expect.objectContaining({
          phase: 'forward-response',
          outcome: 'error',
          errorCategory: 'timeout'
        })
      ])
    } finally {
      failUpstream?.()
      await proxy.close()
    }
  })

  it('aborts a native Responses request when upstream headers do not arrive in time', async () => {
    let upstreamSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal ?? undefined
          upstreamSignal?.addEventListener(
            'abort',
            () => reject(upstreamSignal?.reason ?? new Error('aborted')),
            { once: true }
          )
        })
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
      fetchImpl,
      { responseHeaderTimeoutMs: 25 }
    )
    const connection = await proxy.start()

    try {
      const outcome = await Promise.race([
        fetch(`${connection.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'analyze', stream: true })
        }),
        new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 500))
      ])

      expect(outcome).toBeInstanceOf(Response)
      const response = outcome as Response
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: {
          type: 'api_error',
          message: 'Native Responses compatibility request failed'
        }
      })
      expect(upstreamSignal?.aborted).toBe(true)
      expect(logSpies.warn.mock.calls).toContainEqual([
        'native Responses compatibility request failed',
        expect.objectContaining({
          phase: 'upstream-fetch',
          outcome: 'error',
          errorCategory: 'timeout'
        })
      ])
    } finally {
      await proxy.close()
    }
  })

  it('selects matching Skills through the native Responses endpoint', async () => {
    const fetchImpl = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        void url
        void init
        return new Response(
          JSON.stringify({
            id: 'resp-skills',
            usage: {
              input_tokens: 12,
              input_tokens_details: { cached_tokens: 3 },
              output_tokens: 4
            },
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
      {
        name: 'mcp-pubmed',
        description: 'Search PubMed.',
        path: '/skills/pubmed/SKILL.md',
        source: 'connector' as const
      },
      {
        name: 'mcp-chemistry',
        description: 'Search chemistry.',
        path: '/skills/chem/SKILL.md',
        source: 'connector' as const
      }
    ]

    const observeUsage = vi.fn()
    await expect(
      proxy.selectSkills('查找肿瘤免疫相关的生物医学文献', catalog, undefined, observeUsage)
    ).resolves.toEqual([{ name: 'mcp-pubmed', path: '/skills/pubmed/SKILL.md' }])
    expect(observeUsage).toHaveBeenCalledWith({
      sourceInvocationId: 'resp-skills',
      usage: {
        inputTokens: 9,
        cacheTokens: 3,
        cachedReadTokens: 3,
        cachedWriteTokens: 0,
        outputTokens: 4
      }
    })
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
    const serializedLogs = JSON.stringify(Object.values(logSpies).flatMap((spy) => spy.mock.calls))
    expect(serializedLogs).not.toContain('查找肿瘤免疫相关的生物医学文献')
    expect(serializedLogs).not.toContain('mcp-pubmed')
  })

  it('selects an explicitly named connector Skill locally without an upstream request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      fetchImpl
    )
    const catalog = [
      {
        name: 'mcp-pubmed',
        description: 'Search PubMed.',
        path: '/skills/pubmed/SKILL.md',
        source: 'connector' as const
      },
      {
        name: 'mcp-chemistry',
        description: 'Search chemistry.',
        path: '/skills/chem/SKILL.md',
        source: 'connector' as const
      }
    ]

    await expect(proxy.selectSkills('用 PubMed 搜索肿瘤免疫文章', catalog)).resolves.toEqual([
      { name: 'mcp-pubmed', path: '/skills/pubmed/SKILL.md' }
    ])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('finds a named connector outside the bounded inference catalog', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      fetchImpl
    )
    const catalog = [
      ...Array.from({ length: 140 }, (_, index) => ({
        name: `skill-${index}`,
        description: `Description ${index}`,
        path: `/skills/${index}/SKILL.md`
      })),
      {
        name: 'mcp-pubmed',
        description: 'Search PubMed.',
        path: '/skills/pubmed/SKILL.md',
        source: 'connector' as const
      }
    ]

    await expect(proxy.selectSkills('用 PubMed 搜索文章', catalog)).resolves.toEqual([
      { name: 'mcp-pubmed', path: '/skills/pubmed/SKILL.md' }
    ])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('continues scanning for smaller Skills after a candidate exceeds the catalog byte budget', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = JSON.parse(String(init?.body)) as {
          tools: Array<{
            parameters: { properties: { skill_names: { items: Record<string, unknown> } } }
          }>
          instructions: string
        }
        expect(request.tools[0].parameters.properties.skill_names.items).toEqual({ type: 'string' })
        expect(request.instructions).toContain('mcp-late')
        return new Response(
          JSON.stringify({
            output: [
              {
                type: 'function_call',
                name: 'select_skills',
                arguments: '{"skill_names":["mcp-late"]}'
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      fetchImpl
    )
    const catalog = [
      ...Array.from({ length: 125 }, (_, index) => ({
        name: `mcp-filler-${index}`,
        description: 'x'.repeat(2_048),
        path: `/skills/filler-${index}/SKILL.md`
      })),
      {
        name: 'mcp-over-budget',
        description: 'x'.repeat(2_048),
        path: '/skills/over-budget/SKILL.md'
      },
      { name: 'mcp-late', description: 'Relevant small Skill.', path: '/skills/late/SKILL.md' }
    ]

    await expect(
      proxy.selectSkills('route this request to a delayed capability', catalog)
    ).resolves.toEqual([{ name: 'mcp-late', path: '/skills/late/SKILL.md' }])
  })

  it('replaces reviewer-session tools with only the scope-bounded reviewer surface', async () => {
    const upstreamRequests: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ id: 'review-response', output: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      {
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M3',
        reviewerScope: {
          namespacedTools: [
            {
              namespace: 'mcp__open_science_reviewer',
              name: 'submit_findings',
              description: 'Submit review findings.',
              parameters: { type: 'object' }
            }
          ]
        }
      },
      fetchImpl
    )
    const connection = await proxy.start()
    try {
      expect(proxy.unregisterReviewerSession('never-observed')).toBe(false)
      proxy.registerReviewerSession('reviewer-session')
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          prompt_cache_key: 'reviewer-session',
          stream: false,
          tools: [
            { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
            {
              type: 'namespace',
              name: 'mcp__open_science_notebook',
              tools: [{ type: 'function', name: 'repl_execute', parameters: { type: 'object' } }]
            }
          ]
        })
      })
      expect(response.ok).toBe(true)
      expect(upstreamRequests).toHaveLength(1)
      expect(upstreamRequests[0]).toMatchObject({
        prompt_cache_key: 'reviewer-session',
        tool_choice: 'auto',
        tools: [
          {
            type: 'function',
            name: 'mcp__open_science_reviewer__submit_findings',
            description: 'Submit review findings.',
            parameters: { type: 'object' }
          }
        ]
      })
      expect(JSON.stringify(upstreamRequests[0])).not.toContain('shell_command')
      expect(JSON.stringify(upstreamRequests[0])).not.toContain('repl_execute')
      expect(proxy.unregisterReviewerSession('reviewer-session')).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it('removes native and namespace tools for a registered one-shot session key', async () => {
    const upstreamRequests: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ id: 'tool-less-response', output: [] })
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.example/v1', model: 'model-a' },
      fetchImpl
    )
    const connection = await proxy.start()

    try {
      proxy.registerToolLessSession('reconstruction-session')
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          prompt_cache_key: 'reconstruction-session',
          stream: false,
          tools: [
            { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
            {
              type: 'namespace',
              name: 'mcp__open_science_notebook',
              tools: [{ type: 'function', name: 'repl_execute', parameters: { type: 'object' } }]
            }
          ],
          tool_choice: { type: 'function', name: 'shell_command' }
        })
      })

      expect(response.ok).toBe(true)
      expect(upstreamRequests[0]).toMatchObject({ tools: [], tool_choice: 'auto' })
      expect(JSON.stringify(upstreamRequests[0])).not.toContain('shell_command')
      expect(JSON.stringify(upstreamRequests[0])).not.toContain('repl_execute')
      expect(proxy.unregisterToolLessSession('reconstruction-session')).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it('replaces native declarations with the registered host-message-only scope', async () => {
    const upstreamRequests: Record<string, unknown>[] = []
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.example/v1', model: 'model-a' },
      vi.fn(async (_url, init) => {
        upstreamRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ id: 'host-message-response', output: [] })
      })
    )
    const connection = await proxy.start()
    try {
      proxy.registerHostMessageSession('side-session', [
        {
          namespace: 'mcp__open_science_host_message',
          name: 'send_message',
          parameters: { type: 'object' }
        }
      ])
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          prompt_cache_key: 'side-session',
          stream: false,
          tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
        })
      })

      expect(response.ok).toBe(true)
      expect(upstreamRequests[0]).toMatchObject({
        tool_choice: 'auto',
        tools: [
          {
            type: 'function',
            name: 'mcp__open_science_host_message__send_message'
          }
        ]
      })
      expect(JSON.stringify(upstreamRequests[0])).not.toContain('shell_command')

      const ordinaryResponse = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          prompt_cache_key: 'ordinary-session',
          stream: false,
          tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
        })
      })
      expect(ordinaryResponse.ok).toBe(true)
      expect(JSON.stringify(upstreamRequests[1])).toContain('shell_command')
      expect(proxy.unregisterHostMessageSession('side-session')).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  it('removes every native tool when a strict host-message boundary sees an unexpected Session key', async () => {
    const upstreamRequests: Record<string, unknown>[] = []
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.example/v1', model: 'model-a' },
      vi.fn(async (_url, init) => {
        upstreamRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({ id: 'host-message-mismatch', output: [] })
      })
    )
    const connection = await proxy.start()
    try {
      proxy.registerHostMessageSession(
        'expected-side-session',
        [
          {
            namespace: 'mcp__open_science_host_message',
            name: 'send_message',
            parameters: { type: 'object' }
          }
        ],
        { failClosedUnknownKeys: true }
      )
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'model-a',
          prompt_cache_key: 'unexpected-session',
          stream: false,
          tools: [{ type: 'function', name: 'shell_command', parameters: { type: 'object' } }]
        })
      })

      expect(response.ok).toBe(true)
      expect(upstreamRequests[0]).toMatchObject({ tools: [], tool_choice: 'auto' })
      expect(proxy.unregisterHostMessageSession('expected-side-session')).toBe(false)
    } finally {
      await proxy.close()
    }
  })

  it('forwards loopback requests without browser-controlled Fetch Metadata headers', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers)
        if (headers.has('sec-fetch-mode')) throw new Error('net::ERR_INVALID_ARGUMENT')

        return new Response(JSON.stringify({ id: 'response-1', output: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
      fetchImpl
    )
    const connection = await proxy.start()
    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          input: 'ping'
        })
      })

      expect(response.ok, await response.text()).toBe(true)
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      await proxy.close()
    }
  })

  it('logs a privacy-safe lifecycle that distinguishes an upstream 502', async () => {
    const privatePrompt = 'private medical prompt'
    const privateInstructions = 'private medical instructions'
    const privateToolName = 'private_medical_tool'
    const privateUpstreamDetail = 'private gateway diagnostic'
    const proxy = new NativeResponsesCompatibilityProxy(
      {
        baseUrl: 'https://api.deepseek.com/v1',
        key: 'private-api-key',
        model: 'deepseek-v4-flash'
      },
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: privateUpstreamDetail } }), {
          status: 502,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
    const connection = await proxy.start()
    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          prompt_cache_key: 'private-cache-key',
          instructions: privateInstructions,
          input: [{ type: 'message', role: 'user', content: privatePrompt }],
          tools: [
            {
              type: 'function',
              name: privateToolName,
              parameters: { type: 'object' }
            }
          ]
        })
      })
      expect(response.status).toBe(502)
      await response.text()

      const received = logSpies.info.mock.calls.find(
        ([message]) => message === 'native Responses compatibility request'
      )
      const upstream = logSpies.info.mock.calls.find(
        ([message]) => message === 'native Responses compatibility upstream response'
      )
      const completed = logSpies.info.mock.calls.find(
        ([message]) => message === 'native Responses compatibility request completed'
      )
      expect(received?.[1]).toMatchObject({
        requestId: expect.any(String),
        requestBytes: expect.any(Number),
        inputBytes: expect.any(Number),
        inputItemCount: 1,
        instructionTextBytes: expect.any(Number),
        toolDefinitionCount: 1,
        promptCacheKeyPresent: true
      })
      expect(received?.[1]?.requestBytes).toBeGreaterThan(0)
      expect(received?.[1]?.inputBytes).toBeGreaterThan(0)
      expect(received?.[1]?.instructionTextBytes).toBeGreaterThan(0)
      expect(upstream?.[1]).toMatchObject({
        requestId: received?.[1]?.requestId,
        status: 502,
        responseType: 'json',
        durationMs: expect.any(Number)
      })
      expect(completed?.[1]).toMatchObject({
        requestId: received?.[1]?.requestId,
        status: 502,
        durationMs: expect.any(Number)
      })
      const serialized = JSON.stringify(Object.values(logSpies).flatMap((spy) => spy.mock.calls))
      expect(serialized).not.toContain(privatePrompt)
      expect(serialized).not.toContain(privateInstructions)
      expect(serialized).not.toContain(privateToolName)
      expect(serialized).not.toContain('private-cache-key')
      expect(serialized).not.toContain(privateUpstreamDetail)
      expect(serialized).not.toContain('private-api-key')
      expect(serialized).not.toContain(connection.token)
      expect(serialized).not.toContain('api.deepseek.com')
    } finally {
      await proxy.close()
    }
  })

  it('classifies an upstream transport failure without logging its raw message', async () => {
    const privateError = Object.assign(
      new Error('fetch failed for https://private-gateway.example.test/account/alice'),
      { code: 'ECONNRESET' }
    )
    const fetchImpl = vi.fn().mockRejectedValue(privateError)
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.deepseek.com/v1', key: 'private-api-key' },
      fetchImpl
    )
    const connection = await proxy.start()
    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ model: 'private-model', input: 'private prompt' })
      })
      expect(response.status).toBe(502)
      const errorResponse = await response.json()
      expect(errorResponse).toEqual({
        error: {
          type: 'api_error',
          message: 'Native Responses compatibility request failed'
        }
      })
      expect(JSON.stringify(errorResponse)).not.toContain('private-gateway.example.test')
      expect(fetchImpl).toHaveBeenCalledOnce()

      expect(logSpies.warn.mock.calls).toContainEqual([
        'native Responses compatibility request failed',
        expect.objectContaining({
          requestId: expect.any(String),
          phase: 'upstream-fetch',
          outcome: 'error',
          errorCategory: 'network',
          errorCode: 'ECONNRESET',
          durationMs: expect.any(Number)
        })
      ])
      const serialized = JSON.stringify(Object.values(logSpies).flatMap((spy) => spy.mock.calls))
      expect(serialized).not.toContain('private-gateway.example.test')
      expect(serialized).not.toContain('private-api-key')
      expect(serialized).not.toContain('private-model')
      expect(serialized).not.toContain('private prompt')
    } finally {
      await proxy.close()
    }
  })

  it('forwards a near-limit multimodal request larger than 32 MiB', async () => {
    const upstreamBodies: string[] = []
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamBodies.push(String(init?.body))
        return new Response(JSON.stringify({ id: 'large-response', output: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    )
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' },
      fetchImpl
    )
    const connection = await proxy.start()
    try {
      const response = await fetch(`${connection.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          stream: false,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'p'.repeat(8 * 1024 * 1024) },
                {
                  type: 'input_image',
                  image_url: `data:image/png;base64,${'a'.repeat(24 * 1024 * 1024)}`
                }
              ]
            }
          ]
        })
      })

      expect(response.ok, await response.text()).toBe(true)
      expect(upstreamBodies).toHaveLength(1)
      expect(Buffer.byteLength(upstreamBodies[0], 'utf8')).toBeGreaterThan(32 * 1024 * 1024)
    } finally {
      await proxy.close()
    }
  })
})
