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
const fixture = (
  messages: AnyMessage[],
  fetchImpl: typeof fetch
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
      resolveSessionCwd: () => '/workspace',
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
