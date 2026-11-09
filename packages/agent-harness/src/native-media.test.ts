import { describe, expect, it, vi } from 'vitest'
import { createChatCompletionsModel } from './chat-completions'
import { createMessagesModel } from './messages'
import { createResponsesModel } from './responses'
import { openAgentSession } from './session'
import { createMemoryAgentStore } from './memory-store'
import { mcpToolResult } from './mcp'
import type { AgentModel, ContentBlock, ModelRequest } from './session-types'

const pdf: ContentBlock = {
  type: 'file',
  mimeType: 'application/pdf',
  source: 'data:application/pdf;base64,JVBERg==',
  filename: 'evidence.pdf'
}
const audio: ContentBlock = {
  type: 'audio',
  mimeType: 'audio/wav',
  source: 'data:audio/wav;base64,AA=='
}
const video: ContentBlock = {
  type: 'video',
  mimeType: 'video/mp4',
  source: 'data:video/mp4;base64,AA=='
}
const cases = [
  {
    protocol: 'chat',
    create: createChatCompletionsModel,
    wire: { type: 'file', file: { file_data: pdf.source, filename: 'evidence.pdf' } }
  },
  {
    protocol: 'messages',
    create: createMessagesModel,
    wire: {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' }
    }
  },
  {
    protocol: 'responses',
    create: createResponsesModel,
    wire: { type: 'input_file', file_data: pdf.source, filename: 'evidence.pdf' }
  }
] as const
function fixture(
  protocol: string,
  create: typeof createChatCompletionsModel,
  videoInput = false
): {
  model: AgentModel
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>
  apiKey: ReturnType<typeof vi.fn<() => string>>
} {
  const events =
    protocol === 'chat'
      ? [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]
      : protocol === 'messages'
        ? [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]
        : [{ type: 'response.completed', response: {} }]
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') +
          (protocol === 'chat' ? 'data: [DONE]\n\n' : ''),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  )
  const apiKey = vi.fn(() => 'secret')
  return {
    model: create({
      id: 'account/model',
      endpoint: 'https://example.test/native',
      model: 'fixture',
      apiKey,
      fetch,
      inputCapabilities: { video: videoInput }
    }),
    fetch,
    apiKey
  }
}
const request = (blocks: ContentBlock[]): ModelRequest => ({
  requestId: 'r',
  instructions: 'stable system',
  maxOutputTokens: 100,
  tools: [],
  messages: [{ id: 'user', role: 'user', content: blocks }]
})
async function send(model: AgentModel, input: ModelRequest): Promise<void> {
  for await (const event of model.stream(input, new AbortController().signal))
    expect(event).toBeDefined()
}
const body = (
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>
): ReturnType<typeof JSON.parse> => JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))

describe('native media input', () => {
  it.each(cases)(
    '$protocol preserves oversized-input evidence and permits an explicit clean fork',
    async ({ protocol, create }) => {
      const f = fixture(protocol, create)
      const model = create({
        endpoint: 'https://example.test/native',
        model: 'fixture',
        apiKey: f.apiKey,
        fetch: f.fetch,
        maxRequestBytes: 2048
      })
      const store = createMemoryAgentStore()
      const options = { store, model, maxSteps: 1, maxOutputTokens: 64 }
      const session = await openAgentSession({ ...options, sessionId: 'large' })
      let fork: Awaited<ReturnType<typeof openAgentSession>> | undefined
      try {
        await session.prompt([{ type: 'text', text: 'keep this fact' }])
        const boundary = (await session.snapshot()).messages.at(-1)!.id
        f.fetch.mockClear()
        await expect(session.prompt([{ type: 'text', text: 'x'.repeat(8192) }])).rejects.toThrow(
          'request exceeds byte limit'
        )
        expect(f.fetch).not.toHaveBeenCalled()
        const failed = await session.snapshot()
        expect(failed.run?.status).toBe('failed')
        expect(failed.requests.at(-1)?.status).toBe('failed')
        await session.fork('clean', boundary)
        fork = await openAgentSession({ ...options, sessionId: 'clean' })
        expect(await fork.prompt([{ type: 'text', text: 'continue' }])).toBe('complete')
        expect(f.fetch).toHaveBeenCalledTimes(1)
        expect((await session.snapshot()).messages).toEqual(failed.messages)
      } finally {
        await session.dispose()
        await fork?.dispose()
      }
    }
  )

  it.each(cases)(
    '$protocol bounds serialized UTF-8 requests before credentials or I/O',
    async ({ protocol, create }) => {
      const f = fixture(protocol, create)
      const input = request([pdf, { type: 'text', text: '证据🌏' }])
      await send(f.model, input)
      const bytes = Buffer.byteLength(String(f.fetch.mock.calls[0][1]?.body))
      const limited = (maxRequestBytes: number): AgentModel =>
        create({
          id: 'account/model',
          endpoint: 'https://example.test/native',
          model: 'fixture',
          apiKey: f.apiKey,
          fetch: f.fetch,
          maxRequestBytes
        })
      f.fetch.mockClear()
      f.apiKey.mockClear()
      await expect(send(limited(bytes - 1), input)).rejects.toThrow('request exceeds byte limit')
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.apiKey).not.toHaveBeenCalled()
      await send(limited(bytes), input)
      expect(f.fetch).toHaveBeenCalledTimes(1)
      for (const invalid of [0, -1, 1.5, NaN, Infinity])
        expect(() => limited(invalid)).toThrow('Invalid request limit')
    }
  )

  it.each(cases)(
    '$protocol preserves PDF input and tool output through native blocks',
    async ({ protocol, create, wire }) => {
      const f = fixture(protocol, create)
      const input = request([pdf])
      await send(f.model, input)
      expect(
        protocol === 'responses'
          ? body(f.fetch).input[0].content
          : body(f.fetch).messages[protocol === 'chat' ? 1 : 0].content
      ).toEqual([wire])
      input.messages.push(
        {
          id: 'assistant',
          role: 'assistant',
          content: [],
          calls: [{ id: 'call', name: 'read', arguments: {} }]
        },
        {
          id: 'result',
          role: 'tool',
          invocationId: 'assistant/call',
          content: [pdf],
          isError: true
        }
      )
      await send(f.model, input)
      const b = body(f.fetch)
      if (protocol === 'chat') {
        expect(b.messages.at(-2).role).toBe('tool')
        expect(b.messages.at(-1).content).toContainEqual(wire)
        expect(b.messages.at(-1).content[0].text).toContain('untrusted tool output')
      }
      if (protocol === 'messages')
        expect(b.messages.at(-1).content[0]).toMatchObject({
          type: 'tool_result',
          tool_use_id: 'call',
          content: [wire],
          is_error: true
        })
      if (protocol === 'responses')
        expect(b.input.at(-1)).toEqual({
          type: 'function_call_output',
          call_id: 'call',
          output: [wire]
        })
    }
  )
  it.each(cases)(
    '$protocol accepts declared video input and rejects it by default',
    async ({ protocol, create }) => {
      const enabled = fixture(protocol, create, true)
      await send(enabled.model, request([video]))
      expect(JSON.stringify(body(enabled.fetch))).toContain(
        protocol === 'chat'
          ? 'video_url'
          : protocol === 'messages'
            ? '"type":"video"'
            : 'input_video'
      )
      const disabled = fixture(protocol, create)
      await expect(send(disabled.model, request([video]))).rejects.toThrow()
      expect(disabled.apiKey).not.toHaveBeenCalled()
      expect(disabled.fetch).not.toHaveBeenCalled()
    }
  )
  it('sends audio only through the Chat audio input contract', async () => {
    const f = fixture('chat', createChatCompletionsModel)
    await send(f.model, request([audio]))
    expect(body(f.fetch).messages[1].content).toEqual([
      { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }
    ])
    for (const { protocol, create } of cases.slice(1)) {
      const f = fixture(protocol, create)
      await expect(send(f.model, request([audio]))).rejects.toThrow()
      expect(f.fetch).not.toHaveBeenCalled()
    }
  })
  it('supports Responses text/office files and rejects unsupported file transports before credentials', async () => {
    const f = fixture('responses', createResponsesModel)
    await send(
      f.model,
      request([{ type: 'file', mimeType: 'text/plain', source: 'data:text/plain;base64,SGk=' }])
    )
    expect(body(f.fetch).input[0].content).toEqual([
      { type: 'input_file', file_data: 'data:text/plain;base64,SGk=', filename: 'document.txt' }
    ])
    await send(
      f.model,
      request([
        {
          type: 'file',
          mimeType: 'application/pdf',
          source: { url: 'https://example.test/report.pdf' }
        }
      ])
    )
    expect(body(f.fetch).input[0].content).toEqual([
      { type: 'input_file', file_url: 'https://example.test/report.pdf' }
    ])
    const chat = fixture('chat', createChatCompletionsModel)
    await expect(
      send(chat.model, request([{ ...pdf, source: 'https://example.test/report.pdf' }]))
    ).rejects.toThrow()
    await expect(
      send(chat.model, request([{ ...pdf, filename: '../private.pdf' }]))
    ).rejects.toThrow()
    expect(chat.apiKey).not.toHaveBeenCalled()
    expect(chat.fetch).not.toHaveBeenCalled()
  })
  it.each(cases)(
    '$protocol scopes uploaded IDs to their original adapter identity',
    async ({ protocol, create }) => {
      const f = fixture(protocol, create)
      await send(
        f.model,
        request([{ ...pdf, source: { fileId: 'file_123', adapterId: f.model.id } }])
      )
      expect(JSON.stringify(body(f.fetch))).toContain('file_123')
      f.apiKey.mockClear()
      f.fetch.mockClear()
      await expect(
        send(
          f.model,
          request([{ ...pdf, source: { fileId: 'file_123', adapterId: 'other-account' } }])
        )
      ).rejects.toThrow()
      expect(f.apiKey).not.toHaveBeenCalled()
      expect(f.fetch).not.toHaveBeenCalled()
    }
  )
  it.each(cases)(
    '$protocol rejects invalid sources, media types and assistant inputs before I/O',
    async ({ protocol, create }) => {
      for (const block of [
        { ...pdf, source: 'file:///tmp/private.pdf' },
        { ...pdf, source: 'https://user:secret@example.test/a.pdf' },
        { ...pdf, source: 'data:text/plain;base64,AA==' },
        { ...pdf, source: 'data:application/pdf;base64,%%%=' },
        { ...audio, mimeType: 'audio/unknown' }
      ]) {
        const f = fixture(protocol, create)
        await expect(send(f.model, request([block]))).rejects.toThrow()
        expect(f.apiKey).not.toHaveBeenCalled()
        expect(f.fetch).not.toHaveBeenCalled()
      }
      const f = fixture(protocol, create),
        r = request([pdf])
      r.messages[0].role = 'assistant'
      await expect(send(f.model, r)).rejects.toThrow()
      expect(f.fetch).not.toHaveBeenCalled()
    }
  )
  it('keeps native audio/video in durable message projections and rejects incompatible model switches', async () => {
    const store = createMemoryAgentStore(),
      f = fixture('chat', createChatCompletionsModel, true)
    const options = { sessionId: 'media', store, model: f.model, maxSteps: 2, maxOutputTokens: 100 }
    const session = await openAgentSession(options)
    await session.prompt([audio, video])
    await session.dispose()
    const resumed = await openAgentSession(options)
    expect((await resumed.snapshot()).messages[0].content).toEqual([audio, video])
    await resumed.configure({
      model: {
        ...f.model,
        id: 'text-only',
        capabilities: { tools: true, images: false, files: false }
      }
    })
    const before = f.fetch.mock.calls.length
    await expect(resumed.prompt([{ type: 'text', text: 'continue' }])).rejects.toThrow(
      /audio|video/
    )
    expect(f.fetch.mock.calls.length).toBe(before)
    await resumed.dispose()
  })
  it('maps inline MCP audio and binary resources without fetching resource links', () => {
    expect(
      mcpToolResult({
        content: [
          { type: 'audio', mimeType: 'audio/wav', data: 'AA==' },
          {
            type: 'resource',
            resource: { uri: 'private://document', mimeType: 'application/pdf', blob: 'JVBERg==' }
          }
        ]
      }).content
    ).toEqual([audio, { type: 'file', mimeType: 'application/pdf', source: pdf.source }])
    expect(
      mcpToolResult({
        content: [
          { type: 'resource_link', uri: 'https://example.test/private.pdf', name: 'private' }
        ]
      }).content[0].type
    ).toBe('text')
  })
  it('retains valid MIME-less MCP resources as evidence without guessing their native type', () => {
    const resource = { type: 'resource', resource: { uri: 'private://unknown', blob: 'AA==' } }
    expect(mcpToolResult({ content: [resource] }).content).toEqual([
      { type: 'text', text: JSON.stringify(resource) }
    ])
    expect(() =>
      mcpToolResult({ content: [{ type: 'audio', mimeType: 'image/png', data: 'AA==' }] })
    ).toThrow('Invalid MCP audio')
  })
})
