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
  resolveSessionCwd = (): string => '/workspace',
  keepOpen = false
): {
  stream: Stream
  abort: AbortController
  read: () => Promise<AnyMessage[]>
  outgoing: AnyMessage[]
  send: (message: AnyMessage) => void
  end: () => void
} => {
  const abort = new AbortController()
  const outgoing: AnyMessage[] = []
  let source!: ReadableStreamDefaultController<AnyMessage>
  const stream = createOpenCodeCompactionStream(
    {
      readable: new ReadableStream({
        start(controller) {
          source = controller
          messages.forEach((message) => controller.enqueue(message))
          if (!keepOpen) controller.close()
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
  return {
    stream,
    abort,
    read,
    outgoing,
    send: (message) => source.enqueue(message),
    end: () => source.close()
  }
}

describe('OpenCode 1.x compaction stream', () => {
  it.each(['lookup', 'retry'])(
    'interrupts %s on Stop and preserves the native cancelled response',
    async (phase) => {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        if (phase === 'retry' && fetchImpl.mock.calls.length === 1)
          return new Response(null, { status: 500 })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
      })
      const test = fixture([], fetchImpl, undefined, true)
      const writer = test.stream.writable.getWriter()
      await writer.write({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: { sessionId: 's', prompt: [] }
      })
      const reading = test.read()
      test.send(chunk('s', 'slow'))
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(phase === 'lookup' ? 1 : 2))
      await writer.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } })
      test.send(chunk('s', 'queued'))
      const cancelled: AnyMessage = { jsonrpc: '2.0', id: 1, result: { stopReason: 'cancelled' } }
      test.send(cancelled)
      test.end()
      expect(await reading).toEqual([cancelled])
      expect(fetchImpl).toHaveBeenCalledTimes(phase === 'lookup' ? 1 : 2)
    }
  )

  it('does not report success if the Agent ignores Stop after output was withheld', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const test = fixture([], fetchImpl, undefined, true)
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    await writer.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } })
    test.send(chunk('s', 'withheld'))
    test.send(response)
    test.end()
    expect(await test.read()).toMatchObject([{ id: 1, error: { code: -32603 } }])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not cancel another session lookup when Stop targets a different session', async () => {
    let finishLookup!: (response: Response) => void
    let lookupSignal: AbortSignal | null | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      lookupSignal = init?.signal
      return new Promise<Response>((resolve) => {
        finishLookup = resolve
      })
    })
    const test = fixture([], fetchImpl, undefined, true)
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reading = test.read()
    test.send(chunk('s', 'm'))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await writer.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'other' } })
    expect(lookupSignal?.aborted).toBe(false)
    finishLookup(native('s', 'm', false))
    test.send(response)
    test.end()
    expect(await reading).toEqual([chunk('s', 'm'), response])
  })

  it('does not let a later prompt claim an unowned chunk while its lookup is pending', async () => {
    const lookupStarted = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<Response>()
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/message/orphan?')) {
        lookupStarted.resolve()
        return lookup.promise
      }
      return native('s', 'new', false)
    })
    const test = fixture(
      [
        chunk('s', 'orphan'),
        chunk('s', 'new'),
        { jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } }
      ],
      fetchImpl
    )
    const reading = test.read()
    const rejected = expect(reading).rejects.toThrow('OpenCode message classification failed')
    await lookupStarted.promise
    await test.stream.writable.getWriter().write({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    lookup.resolve(new Response(null, { status: 404 }))

    await rejected
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not fail a later prompt when an earlier chunk lookup fails', async () => {
    const lookupStarted = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<Response>()
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/message/old?')) {
        lookupStarted.resolve()
        return lookup.promise
      }
      return native('s', 'new', false)
    })
    const nextResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture([chunk('s', 'old'), response, chunk('s', 'new'), nextResponse], fetchImpl)
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reading = test.read()
    await lookupStarted.promise
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    lookup.resolve(new Response(null, { status: 404 }))

    const output = await reading
    expect(output[0]).toMatchObject({ id: 1, error: { code: -32603 } })
    expect(output.slice(1)).toEqual([chunk('s', 'new'), nextResponse])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not fail a later prompt when an earlier terminal lookup fails', async () => {
    const lookupStarted = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<Response>()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('s', 'summary', true))
      .mockImplementationOnce(async () => {
        lookupStarted.resolve()
        return lookup.promise
      })
      .mockImplementation(async () => native('s', 'new', false))
    const nextResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture(
      [chunk('s', 'summary'), response, chunk('s', 'new'), nextResponse],
      fetchImpl
    )
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reading = test.read()
    await lookupStarted.promise
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    lookup.resolve(new Response(null, { status: 404 }))

    const output = await reading
    expect(output.slice(0, 3)).toMatchObject([
      { params: { update: { _meta: { 'opencode/compaction': { status: 'started' } } } } },
      { params: { update: { _meta: { 'opencode/compaction': { status: 'failed' } } } } },
      { id: 1, error: { code: -32603 } }
    ])
    expect(JSON.stringify(output.slice(0, 3))).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
    expect(output.slice(3)).toEqual([chunk('s', 'new'), nextResponse])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('rejects overlapping prompts when their output cannot be attributed after a failure', async () => {
    const lookupStarted = Promise.withResolvers<void>()
    const lookup = Promise.withResolvers<Response>()
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      lookupStarted.resolve()
      return lookup.promise
    })
    const nextResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture([chunk('s', 'old'), chunk('s', 'new'), nextResponse, response], fetchImpl)
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reading = test.read()
    await lookupStarted.promise
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    lookup.resolve(new Response(null, { status: 404 }))

    const output = await reading
    expect(output).toMatchObject([
      { id: 2, error: { code: -32603 } },
      { id: 1, error: { code: -32603 } }
    ])
    expect(JSON.stringify(output)).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps an earlier summary pending until its own prompt terminal arrives', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('s', 'summary', true))
      .mockImplementation(async () => new Response(null, { status: 404 }))
    const nextResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture([chunk('s', 'summary'), nextResponse, response], fetchImpl)
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reader = test.stream.readable.getReader()
    const started = (await reader.read()).value
    expect(started).toMatchObject({
      params: { update: { _meta: { 'opencode/compaction': { status: 'started' } } } }
    })
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })

    expect((await reader.read()).value).toEqual(nextResponse)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const failed = (await reader.read()).value
    expect(failed).toMatchObject({
      params: { update: { _meta: { 'opencode/compaction': { status: 'failed' } } } }
    })
    const terminal = (await reader.read()).value
    expect(terminal).toMatchObject({ id: 1, error: { code: -32603 } })
    expect(JSON.stringify([started, failed, terminal])).not.toContain(
      'INTERNAL_PATH_AND_INSTRUCTIONS'
    )
    expect((await reader.read()).done).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects every possible owner when summary verification fails at a busy sibling terminal', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('s', 'summary', true))
      .mockImplementation(async () => new Response(null, { status: 404 }))
    const busyResponse: AnyMessage = {
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32603, message: 'Session busy' }
    }
    const test = fixture([chunk('s', 'summary'), busyResponse, response], fetchImpl)
    const writer = test.stream.writable.getWriter()
    for (const id of [1, 2]) {
      await writer.write({
        jsonrpc: '2.0',
        id,
        method: 'session/prompt',
        params: { sessionId: 's', prompt: [] }
      })
    }

    const output = await test.read()
    expect(output).toMatchObject([
      { params: { update: { _meta: { 'opencode/compaction': { status: 'started' } } } } },
      { params: { update: { _meta: { 'opencode/compaction': { status: 'failed' } } } } },
      { id: 2, error: { code: -32603 } },
      { id: 1, error: { code: -32603 } }
    ])
    expect(JSON.stringify(output)).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('verifies another pending summary after one request fails instead of marking it failed', async () => {
    let firstSummaryLookups = 0
    let secondSummaryLookups = 0
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/message/summary-a?')) {
        firstSummaryLookups++
        return firstSummaryLookups === 1
          ? native('s', 'summary-a', true)
          : new Response(null, { status: 404 })
      }
      secondSummaryLookups++
      return native('s', 'summary-b', true, secondSummaryLookups === 1 ? undefined : 'stop')
    })
    const nextResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture(
      [chunk('s', 'summary-a'), chunk('s', 'summary-b'), response, nextResponse],
      fetchImpl
    )
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reader = test.stream.readable.getReader()
    expect((await reader.read()).value).toMatchObject({
      params: {
        update: { _meta: { 'opencode/compaction': { messageId: 'summary-a', status: 'started' } } }
      }
    })
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    expect((await reader.read()).value).toMatchObject({
      params: {
        update: { _meta: { 'opencode/compaction': { messageId: 'summary-b', status: 'started' } } }
      }
    })

    expect((await reader.read()).value).toMatchObject({
      params: {
        update: { _meta: { 'opencode/compaction': { messageId: 'summary-a', status: 'failed' } } }
      }
    })
    expect((await reader.read()).value).toMatchObject({
      params: {
        update: {
          _meta: { 'opencode/compaction': { messageId: 'summary-b', status: 'completed' } }
        }
      }
    })
    expect((await reader.read()).value).toMatchObject({ id: 1, error: { code: -32603 } })
    expect((await reader.read()).value).toEqual(nextResponse)
    expect((await reader.read()).done).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it.each([
    { outcome: 'completed', normalChunk: true },
    { outcome: 'unavailable', normalChunk: true },
    { outcome: 'completed', normalChunk: false },
    { outcome: 'unavailable', normalChunk: false }
  ])(
    'preserves unowned summary completion without assigning its failure to a later prompt: $outcome, normalChunk=$normalChunk',
    async ({ outcome, normalChunk }) => {
      let summaryLookups = 0
      const fetchImpl = vi.fn<typeof fetch>(async (url) => {
        if (!String(url).includes('/message/summary?')) return native('s', 'new', false)
        summaryLookups++
        return summaryLookups === 1
          ? native('s', 'summary', true)
          : outcome === 'completed'
            ? native('s', 'summary', true, 'stop')
            : new Response(null, { status: 404 })
      })
      const test = fixture(
        normalChunk
          ? [chunk('s', 'summary'), chunk('s', 'new'), response]
          : [chunk('s', 'summary'), response],
        fetchImpl
      )
      const reader = test.stream.readable.getReader()
      expect((await reader.read()).value).toMatchObject({
        params: { update: { _meta: { 'opencode/compaction': { status: 'started' } } } }
      })
      await test.stream.writable.getWriter().write({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/prompt',
        params: { sessionId: 's', prompt: [] }
      })

      if (outcome === 'unavailable') {
        await expect(reader.read()).rejects.toThrow('OpenCode message classification failed')
      } else {
        expect((await reader.read()).value).toMatchObject({
          params: { update: { _meta: { 'opencode/compaction': { status: 'completed' } } } }
        })
        if (normalChunk) expect((await reader.read()).value).toEqual(chunk('s', 'new'))
        expect((await reader.read()).value).toEqual(response)
        expect((await reader.read()).done).toBe(true)
      }
      expect(fetchImpl).toHaveBeenCalledTimes(normalChunk ? 3 : 2)
    }
  )

  it('verifies an independent summary when an ambiguous failure rejects both possible owners', async () => {
    let firstSummaryLookups = 0
    let secondSummaryLookups = 0
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/message/summary-b?')) {
        firstSummaryLookups++
        return native('s', 'summary-b', true, firstSummaryLookups === 1 ? undefined : 'stop')
      }
      secondSummaryLookups++
      return secondSummaryLookups === 1
        ? native('s', 'summary-a', true)
        : new Response(null, { status: 404 })
    })
    const nextResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture(
      [chunk('s', 'summary-b'), chunk('s', 'summary-a'), response, nextResponse],
      fetchImpl
    )
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reader = test.stream.readable.getReader()
    expect((await reader.read()).value).toMatchObject({
      params: {
        update: { _meta: { 'opencode/compaction': { messageId: 'summary-b', status: 'started' } } }
      }
    })
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    // Both requests existed when summary-a arrived; its terminal trigger cannot identify its producer.
    expect((await reader.read()).value).toMatchObject({
      params: {
        update: { _meta: { 'opencode/compaction': { messageId: 'summary-a', status: 'started' } } }
      }
    })

    expect((await reader.read()).value).toMatchObject({
      params: {
        update: { _meta: { 'opencode/compaction': { messageId: 'summary-a', status: 'failed' } } }
      }
    })
    expect((await reader.read()).value).toMatchObject({ id: 1, error: { code: -32603 } })
    expect((await reader.read()).value).toMatchObject({
      params: {
        update: {
          _meta: { 'opencode/compaction': { messageId: 'summary-b', status: 'completed' } }
        }
      }
    })
    expect((await reader.read()).value).toMatchObject({ id: 2, error: { code: -32603 } })
    expect((await reader.read()).done).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('retries a temporary metadata failure without replaying the prompt', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('PRIVATE_METADATA_FAILURE', { status: 503 }))
      .mockResolvedValueOnce(native('s', 'm', false))
    const messages = [chunk('s', 'm'), response]
    const test = fixture(messages, fetchImpl)
    await test.stream.writable.getWriter().write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })

    expect(await test.read()).toEqual(messages)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(test.outgoing).toHaveLength(1)
  })

  it('fails only the owning prompt when metadata is unavailable and permits the next prompt', async () => {
    const unavailableResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: { stopReason: 'end_turn' }
    } as const
    const recoveredResponse = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } } as const
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/message/unavailable?')
        ? new Response('PRIVATE_METADATA_FAILURE', { status: 503 })
        : native('s', 'recovered', false)
    )
    const test = fixture(
      [chunk('s', 'unavailable'), unavailableResponse, chunk('s', 'recovered'), recoveredResponse],
      fetchImpl
    )
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reader = test.stream.readable.getReader()
    const failed = await reader.read()
    expect(failed.value).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32603,
        message: expect.stringContaining('OpenCode message classification failed')
      }
    })
    expect(JSON.stringify(failed.value)).not.toContain('PRIVATE_METADATA_FAILURE')
    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    expect((await reader.read()).value).toEqual(chunk('s', 'recovered'))
    expect((await reader.read()).value).toEqual(recoveredResponse)
    expect((await reader.read()).done).toBe(true)
  })

  it.each(['session/load', 'session/resume'])(
    'keeps a sibling session available when %s replay cannot be classified',
    async (method) => {
      const siblingChunk = chunk('sibling', 'safe')
      const siblingResponse: AnyMessage = {
        jsonrpc: '2.0',
        id: 2,
        result: { stopReason: 'end_turn' }
      }
      const fetchImpl = vi.fn<typeof fetch>(async (url) =>
        String(url).includes('/session/sibling/')
          ? native('sibling', 'safe', false)
          : new Response('PRIVATE_METADATA_FAILURE', { status: 503 })
      )
      const test = fixture(
        [
          chunk('s', 'unavailable'),
          chunk('s', 'also-withheld'),
          siblingChunk,
          siblingResponse,
          response
        ],
        fetchImpl
      )
      const writer = test.stream.writable.getWriter()
      await writer.write({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { sessionId: 's', cwd: '/replay' }
      })
      await writer.write({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'sibling', prompt: [] }
      })

      const output = await test.read()
      expect(output.slice(0, 2)).toEqual([siblingChunk, siblingResponse])
      expect(output[2]).toMatchObject({
        id: 1,
        error: {
          code: -32603,
          message: expect.stringContaining('OpenCode message classification failed')
        }
      })
      expect(JSON.stringify(output)).not.toContain('PRIVATE_METADATA_FAILURE')
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    }
  )

  it('rejects an unverified summary terminal without emitting a successful compaction', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('s', 'summary', true))
      .mockImplementation(async () => new Response('PRIVATE_METADATA_FAILURE', { status: 503 }))
    const test = fixture([chunk('s', 'summary'), chunk('s', 'summary', true), response], fetchImpl)
    await test.stream.writable.getWriter().write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })

    const output = await test.read()
    expect(output).toMatchObject([
      { params: { update: { _meta: { 'opencode/compaction': { status: 'started' } } } } },
      { params: { update: { _meta: { 'opencode/compaction': { status: 'failed' } } } } },
      { id: 1, error: { code: -32603 } }
    ])
    expect(JSON.stringify(output)).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
    expect(JSON.stringify(output)).not.toContain('completed')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('reclassifies an unfinished summary after its owning request failed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(native('s', 'summary', true))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(native('s', 'summary', true, 'stop'))
    const secondResponse: AnyMessage = { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } }
    const test = fixture(
      [chunk('s', 'summary'), response, chunk('s', 'summary'), secondResponse],
      fetchImpl
    )
    const writer = test.stream.writable.getWriter()
    await writer.write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    const reader = test.stream.readable.getReader()
    await reader.read()
    await reader.read()
    expect((await reader.read()).value).toMatchObject({ id: 1, error: { code: -32603 } })

    await writer.write({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })
    expect((await reader.read()).value).toMatchObject({
      params: { update: { _meta: { 'opencode/compaction': { status: 'completed' } } } }
    })
    expect((await reader.read()).value).toEqual(secondResponse)
    expect((await reader.read()).done).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('rejects invalid metadata without retrying or exposing later output in the same prompt', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(native('s', 'wrong-identity', false))
    const test = fixture([chunk('s', 'm'), chunk('s', 'later'), response], fetchImpl)
    await test.stream.writable.getWriter().write({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [] }
    })

    expect(await test.read()).toMatchObject([{ id: 1, error: { code: -32603 } }])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

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
