import type { AnyMessage } from '@agentclientprotocol/sdk'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { createOpenCodeCompactionStream } from './opencode-compaction-stream'

const metadata = JSON.stringify({ info: { sessionID: 's', id: 'm', role: 'assistant' } })
const chunk: AnyMessage = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 's',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm',
      content: { type: 'text', text: 'classified output' }
    }
  }
}
const response = (id: number): AnyMessage => ({
  jsonrpc: '2.0',
  id,
  result: { stopReason: 'end_turn' }
})

const withServer = async (
  handle: (response: ServerResponse, attempt: number) => void,
  run: (baseUrl: string, attempts: () => number) => Promise<void>
): Promise<void> => {
  let attempts = 0
  const server = createServer((_request, response) => handle(response, ++attempts))
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    await run(`http://127.0.0.1:${address.port}`, () => attempts)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const fixture = (
  baseUrl: string,
  onHeaders?: () => void
): {
  reader: ReadableStreamDefaultReader<AnyMessage>
  prompt: (id: number) => Promise<void>
  abort: AbortController
  headers: number[]
} => {
  const abort = new AbortController()
  const headers: number[] = []
  let source!: ReadableStreamDefaultController<AnyMessage>
  const stream = createOpenCodeCompactionStream(
    {
      readable: new ReadableStream({
        start(controller) {
          source = controller
        }
      }),
      writable: new WritableStream()
    },
    {
      api: { baseUrl, authorization: 'Basic test' },
      resolveSessionCwd: () => '/workspace',
      signal: abort.signal,
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init)
        headers.push(response.status)
        onHeaders?.()
        return response
      }
    }
  )
  const writer = stream.writable.getWriter()
  return {
    reader: stream.readable.getReader(),
    abort,
    headers,
    prompt: async (id) => {
      await writer.write({
        jsonrpc: '2.0',
        id,
        method: 'session/prompt',
        params: { sessionId: 's', prompt: [] }
      })
      source.enqueue(chunk)
      source.enqueue(response(id))
    }
  }
}

it('retries a reset after successful headers and delivers the classified response', async () => {
  let interrupted: ServerResponse | undefined
  await withServer(
    (res, attempt) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (attempt === 1) {
        res.write('{"info":')
        interrupted = res
      } else res.end(metadata)
    },
    async (url, attempts) => {
      const test = fixture(url, () => {
        interrupted?.destroy()
        interrupted = undefined
      })
      try {
        await test.prompt(1)
        expect((await test.reader.read()).value).toEqual(chunk)
        expect((await test.reader.read()).value).toEqual(response(1))
        expect(attempts()).toBe(2)
        // Both fetches resolved; the first failure was in the body, not before headers.
        expect(test.headers).toEqual([200, 200])
      } finally {
        test.abort.abort()
      }
    }
  )
})

it('bounds repeated body resets and permits a later prompt on the same stream', async () => {
  let healthy = false
  let interrupted: ServerResponse | undefined
  await withServer(
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (healthy) res.end(metadata)
      else {
        res.write('{"private_context":"INTERNAL_PATH_AND_INSTRUCTIONS",')
        interrupted = res
      }
    },
    async (url, attempts) => {
      const test = fixture(url, () => {
        interrupted?.destroy()
        interrupted = undefined
      })
      try {
        await test.prompt(1)
        const failed = (await test.reader.read()).value
        expect(failed).toMatchObject({ id: 1, error: { code: -32603 } })
        expect(JSON.stringify(failed)).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
        expect(attempts()).toBe(2)
        healthy = true
        await test.prompt(2)
        expect((await test.reader.read()).value).toEqual(chunk)
        expect((await test.reader.read()).value).toEqual(response(2))
        expect(attempts()).toBe(3)
      } finally {
        test.abort.abort()
      }
    }
  )
})

it('does not retry a complete malformed JSON response or expose its body', async () => {
  await withServer(
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"private_context":"INTERNAL_PATH_AND_INSTRUCTIONS",')
    },
    async (url, attempts) => {
      const test = fixture(url)
      try {
        await test.prompt(1)
        const failed = (await test.reader.read()).value
        expect(failed).toMatchObject({ id: 1, error: { code: -32603 } })
        expect(JSON.stringify(failed)).not.toContain('INTERNAL_PATH_AND_INSTRUCTIONS')
        expect(attempts()).toBe(1)
      } finally {
        test.abort.abort()
      }
    }
  )
})

it('retries a stalled body after its deadline without closing ACP', async () => {
  await withServer(
    (res, attempt) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (attempt === 1) res.write('{"info":')
      else res.end(metadata)
    },
    async (url, attempts) => {
      const test = fixture(url)
      try {
        await test.prompt(1)
        expect((await test.reader.read()).value).toEqual(chunk)
        expect((await test.reader.read()).value).toEqual(response(1))
        expect(attempts()).toBe(2)
        expect(test.headers).toEqual([200, 200])
      } finally {
        test.abort.abort()
      }
    }
  )
})

it('cancels a pending body read on cleanup without retrying', async () => {
  await withServer(
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"info":')
    },
    async (url, attempts) => {
      const test = fixture(url)
      try {
        await test.prompt(1)
        const reading = expect(test.reader.read()).rejects.toThrow()
        await vi.waitFor(() => expect(test.headers).toEqual([200]))
        test.abort.abort()
        await reading
        expect(attempts()).toBe(1)
      } finally {
        test.abort.abort()
      }
    }
  )
})
