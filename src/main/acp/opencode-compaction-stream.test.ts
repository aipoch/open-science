import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createOpenCodeCompactionStream } from './opencode-compaction-stream'

const chunk = (sessionId: string, messageId?: string, thought = false): AnyMessage => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: {
      sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
      messageId,
      content: { type: 'text', text: 'INTERNAL_PATH_AND_INSTRUCTIONS' }
    }
  }
})
const response: AnyMessage = { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }
const native = (sessionID: string, id: string, summary: boolean, finish?: string): Response =>
  Response.json({ info: { sessionID, id, role: 'assistant', summary, finish }, parts: [] })
const nativePart = (
  sessionID: string,
  messageId: string,
  partId: string,
  summary: boolean
): Response =>
  Response.json([
    { info: { sessionID, id: messageId, role: 'assistant', summary }, parts: [{ id: partId }] }
  ])
const fixture = (
  messages: AnyMessage[],
  fetchImpl: typeof fetch,
  resolveSessionCwd = (): string => '/workspace'
): {
  stream: Stream
  abort: AbortController
  read: () => Promise<AnyMessage[]>
  outgoing: AnyMessage[]
} => {
  const abort = new AbortController()
  const outgoing: AnyMessage[] = []
  const stream = createOpenCodeCompactionStream(
    {
      readable: new ReadableStream({
        start(controller) {
          messages.forEach((message) => controller.enqueue(message))
          controller.close()
        }
      }),
      writable: new WritableStream({
        write(message) {
          outgoing.push(message)
        }
      })
    },
    {
      api: { baseUrl: 'http://localhost:1234', authorization: 'Basic test' },
      resolveSessionCwd,
      signal: abort.signal,
      fetchImpl
    }
  )
  const read = async (): Promise<AnyMessage[]> => {
    const reader = stream.readable.getReader()
    const result: AnyMessage[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) return result
      result.push(next.value)
    }
  }
  return { stream, abort, read, outgoing }
}

describe('OpenCode 1.x compaction stream', () => {
  it('uses provider-created identities for reviewer and adopted session directories', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('reviewer', 'm', false))
      .mockResolvedValueOnce(native('adopted', 'm', false))
    const replies: AnyMessage[] = [
      { jsonrpc: '2.0', id: 1, result: { sessionId: 'reviewer' } },
      { jsonrpc: '2.0', id: 2, result: { sessionId: 'adopted' } }
    ]
    const messages = [...replies, chunk('reviewer', 'm'), chunk('adopted', 'm')]
    const test = fixture(messages, fetchImpl, () => {
      throw new Error('Not a primary session')
    })
    const writer = test.stream.writable.getWriter()
    await writer.write({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/review' } })
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: '/adopted' }
    })
    expect(await test.read()).toEqual(messages)
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('directory')).toBe(
      '/review'
    )
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('directory')).toBe(
      '/adopted'
    )
  })

  it('aborts a pending lookup on connection cleanup without delivering its chunk', async () => {
    let lookupSignal: AbortSignal | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      lookupSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        lookupSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const test = fixture([chunk('s', 'm')], fetchImpl)
    const reading = test.read()
    const rejection = expect(reading).rejects.toThrow()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    test.abort.abort()
    await rejection
    expect(lookupSignal?.aborted).toBe(true)
  })

  it('releases a provider directory after successful session close', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(native('s', 'm', false))
    const test = fixture(
      [
        { jsonrpc: '2.0', id: 1, result: { sessionId: 's' } },
        chunk('s', 'm'),
        { jsonrpc: '2.0', id: 2, result: {} },
        chunk('s', 'm')
      ],
      fetchImpl,
      () => {
        throw new Error('Not a primary session')
      }
    )
    const writer = test.stream.writable.getWriter()
    await writer.write({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/review' } })
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/close',
      params: { sessionId: 's' }
    })
    await expect(test.read()).rejects.toThrow('OpenCode message classification failed')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('hides live summary text and reasoning before SDK delivery, retaining only lifecycle', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('s', 'm', true))
      .mockResolvedValueOnce(native('s', 'm', true, 'stop'))
    const test = fixture([chunk('s', 'm'), chunk('s', 'm', true), response], fetchImpl)
    await test.stream.writable.getWriter().write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const output = await test.read()
    expect(JSON.stringify(output)).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
    expect(output).toMatchObject([
      {
        params: {
          sessionId: 's',
          update: { _meta: { 'opencode/compaction': { status: 'started', messageId: 'm' } } }
        }
      },
      {
        params: {
          sessionId: 's',
          update: { _meta: { 'opencode/compaction': { status: 'completed', messageId: 'm' } } }
        }
      },
      response
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(test.outgoing).toHaveLength(1)
  })

  it('resolves reasoning part ids to their parent message before classification', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(nativePart('s', 'msg_1', 'prt_1', true))
      .mockResolvedValueOnce(native('s', 'msg_1', true, 'stop'))
    const test = fixture([chunk('s', 'prt_1', true)], fetchImpl)

    const output = await test.read()

    expect(output).toMatchObject([
      {
        params: {
          update: { _meta: { 'opencode/compaction': { messageId: 'msg_1', status: 'completed' } } }
        }
      }
    ])
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/session/s/message?directory=')
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/session/s/message/msg_1?directory=')
  })

  it('normalizes ordinary part-id chunks before SDK delivery', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(nativePart('s', 'msg_1', 'prt_1', false))
      .mockResolvedValueOnce(native('s', 'msg_1', false))
    const test = fixture([chunk('s', 'prt_1', true)], fetchImpl)

    const output = await test.read()

    expect(output).toMatchObject([
      { params: { update: { messageId: 'msg_1', sessionUpdate: 'agent_thought_chunk' } } }
    ])
  })

  it('keeps ordinary streaming text and isolates summary identity across sessions and replay', async () => {
    const messages = [
      chunk('a', 'same'),
      chunk('a', 'same', true),
      chunk('b', 'same'),
      chunk('b', 'same')
    ]
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('a', 'same', true, 'stop'))
      .mockResolvedValueOnce(native('b', 'same', false))
    const output = await fixture(messages, fetchImpl).read()
    expect(output).toHaveLength(3)
    expect(output.slice(1)).toEqual(messages.slice(2))
    expect(output[0]).toMatchObject({
      params: {
        sessionId: 'a',
        update: {
          _meta: { 'opencode/compaction': { status: 'completed' } }
        }
      }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/session/a/message/same?directory=')
  })

  it.each(['missing-id', 'http', 'wrong-message', 'invalid-summary'])(
    'fails closed without exposing provider payload when classification fails: %s',
    async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        failure === 'http'
          ? new Response('INTERNAL_PATH_AND_INSTRUCTIONS', { status: 500 })
          : failure === 'invalid-summary'
            ? Response.json({
                info: { sessionID: 's', id: 'm', role: 'assistant', summary: 'true' }
              })
            : native('s', 'other', false)
      )
      const test = fixture([chunk('s', failure === 'missing-id' ? undefined : 'm')], fetchImpl)
      await expect(test.read()).rejects.toThrow('OpenCode message classification failed')
    }
  )
})
