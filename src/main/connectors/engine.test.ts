import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from './engine'
import type { ToolDescriptor } from './types'

const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }) as Response

describe('ParserEngine declarative path', () => {
  it('builds the url, fetches json, and runs parse', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ value: 42 }))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: (a) => `https://example.test/${a.id}`,
      parse: (raw) => (raw as { value: number }).value
    }
    const out = await engine.call(desc, { id: 7 }, {})
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/7', expect.any(Object))
    expect(out).toBe(42)
  })

  it('throws on missing required args', async () => {
    const engine = new ParserEngine({ fetchImpl: vi.fn() })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      required: ['q'],
      url: () => 'x',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/required arg: q/)
  })

  it('retries transient 5xx and gives up after the configured retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)
    const engine = new ParserEngine({ fetchImpl, retries: 2, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/HTTP 503/)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('retries a transient 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce(jsonResponse({ value: 7 }))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => (raw as { value: number }).value
    }
    expect(await engine.call(desc, {}, {})).toBe(7)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries an immediate network error then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ value: 5 }))
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => (raw as { value: number }).value
    }
    expect(await engine.call(desc, {}, {})).toBe(5)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops after the first request timeout and distinguishes it from the REPL deadline', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          const requestSignal = init?.signal
          requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), {
            once: true
          })
        })
    )
    const engine = new ParserEngine({
      fetchImpl,
      timeoutMs: 5,
      retries: 2,
      retryBackoffMs: 0
    })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test/data',
      parse: (raw) => raw
    }

    await expect(engine.call(desc, {}, {})).rejects.toMatchObject({
      name: 'ConnectorRequestTimeoutError',
      message:
        "Connector request timed out after 1 attempt of 5ms for https://x.test/data. This is the Connector's own deadline; increasing an outer execution timeout will not extend it. Do not retry solely with a longer timeout."
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('resets the timeout while response body chunks keep arriving', async () => {
    const encoder = new TextEncoder()
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => controller.enqueue(encoder.encode('{"value":')), 10)
            setTimeout(() => controller.enqueue(encoder.encode('9}')), 20)
            setTimeout(() => controller.close(), 40)
          }
        })
      )
    )
    const engine = new ParserEngine({ fetchImpl, timeoutMs: 30, retries: 2, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test/data',
      parse: (raw) => (raw as { value: number }).value
    }

    await expect(engine.call(desc, {}, {})).resolves.toBe(9)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('enforces a tool total deadline while response body chunks keep arriving', async () => {
    const encoder = new TextEncoder()
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const chunks = ['{"value":', '9', '}', ' ']
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true
              })
            },
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 10))
              if (init?.signal?.aborted) return
              const next = chunks.shift()
              if (next === undefined) controller.close()
              else controller.enqueue(encoder.encode(next))
            }
          })
        )
      }
    )
    const engine = new ParserEngine({
      fetchImpl,
      timeoutMs: 30,
      retries: 0,
      retryBackoffMs: 0
    })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      totalTimeoutMs: 25,
      url: () => 'https://x.test/data',
      parse: (raw) => raw
    }

    await expect(engine.call(desc, {}, {})).rejects.toMatchObject({
      name: 'ConnectorRequestTimeoutError',
      message:
        "Connector call exceeded the 25ms total deadline for c/t. This is the Connector's own deadline; increasing an outer execution timeout will not extend it. Do not retry solely with a longer timeout."
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects a response as soon as it exceeds the tool byte limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('abcdef'))
    const engine = new ParserEngine({ fetchImpl, retries: 2, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      format: 'text',
      maxResponseBytes: 5,
      url: () => 'https://x.test/data',
      parse: (raw) => raw
    }

    await expect(engine.call(desc, {}, {})).rejects.toMatchObject({
      name: 'ConnectorResponseTooLargeError',
      message: 'Connector response exceeded the 5-byte limit for https://x.test/data'
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('allows a tool to raise both engine response budgets', async () => {
    const encoder = new TextEncoder()
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Response(
          new ReadableStream({
            start(controller) {
              const timer = setTimeout(() => {
                controller.enqueue(encoder.encode('abcdef'))
                controller.close()
              }, 10)
              init?.signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer)
                  controller.error(init.signal?.reason)
                },
                { once: true }
              )
            }
          })
        )
    )
    const engine = new ParserEngine({
      fetchImpl,
      timeoutMs: 30,
      totalTimeoutMs: 5,
      maxResponseBytes: 5,
      retries: 0
    })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      format: 'text',
      totalTimeoutMs: 50,
      maxResponseBytes: 6,
      url: () => 'https://x.test/data',
      parse: (raw) => raw
    }

    await expect(engine.call(desc, {}, {})).resolves.toBe('abcdef')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('times out without retrying when a response body stops producing chunks', async () => {
    const encoder = new TextEncoder()
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('{"value":'))
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true
              })
            }
          })
        )
    )
    const engine = new ParserEngine({
      fetchImpl,
      timeoutMs: 5,
      retries: 2,
      retryBackoffMs: 0
    })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test/data',
      parse: (raw) => raw
    }
    const result = engine.call(desc, {}, {}).catch((error: unknown) => error)

    await expect(
      Promise.race([
        result,
        new Promise((resolve) => setTimeout(() => resolve('still pending'), 100))
      ])
    ).resolves.toMatchObject({
      name: 'ConnectorRequestTimeoutError',
      message:
        "Connector request timed out after 1 attempt of 5ms for https://x.test/data. This is the Connector's own deadline; increasing an outer execution timeout will not extend it. Do not retry solely with a longer timeout."
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts an active request without retrying it', async () => {
    let observedSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          observedSignal = init?.signal ?? undefined
          observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), {
            once: true
          })
        })
    )
    const engine = new ParserEngine({ fetchImpl, retries: 2, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => raw
    }
    const cancellation = new AbortController()

    const call = engine.call(desc, {}, {}, cancellation.signal)
    await vi.waitFor(() => expect(observedSignal).toBeInstanceOf(AbortSignal))
    cancellation.abort()

    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts retry backoff before another request starts', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const engine = new ParserEngine({ fetchImpl, retries: 2, retryBackoffMs: 60_000 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (raw) => raw
    }
    const cancellation = new AbortController()

    const call = engine.call(desc, {}, {}, cancellation.signal)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await Promise.resolve()
    cancellation.abort()

    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('propagates caller cancellation through the run-style context signal', async () => {
    const engine = new ParserEngine({ fetchImpl: vi.fn() })
    const cancellation = new AbortController()
    let observed: AbortSignal | undefined
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      run: async (ctx) => {
        observed = ctx.signal
        return new Promise((_, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true })
        })
      }
    }
    const result = engine.call(desc, {}, {}, cancellation.signal)
    expect(observed).toBeInstanceOf(AbortSignal)
    expect(observed?.aborted).toBe(false)
    const reason = new Error('user cancelled')
    cancellation.abort(reason)
    await expect(result).rejects.toBe(reason)
    expect(observed?.reason).toBe(reason)
  })

  it('does not retry a client error (4xx other than 429)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 } as Response)
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/HTTP 400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('postJson sends a POST with a JSON body and parses the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      run: async (ctx) => ctx.postJson('https://gql.test/api', { query: 'q', variables: { a: 1 } })
    }
    const out = await engine.call(desc, {}, {})
    const init = fetchImpl.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'q', variables: { a: 1 } })
    expect(out).toEqual({ data: { ok: true } })
  })

  it('sends a User-Agent header (some APIs 403 without one)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }))
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://example.test',
      parse: (r) => r
    }
    await engine.call(desc, {}, {})
    const headers = (fetchImpl.mock.calls[0][1] as { headers: Record<string, string> }).headers
    expect(headers['user-agent']).toMatch(/OpenScience/)
  })

  it('redacts credentials from the URL in error messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response)
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://eutils.ncbi.nlm.nih.gov/entrez?email=a@b.com&api_key=SECRET',
      parse: (r) => r
    }
    let message = ''
    try {
      await engine.call(desc, {}, {})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('SECRET')
    expect(message).toContain('HTTP 401')
  })
})

describe('ParserEngine request lifecycle regressions', () => {
  const descriptor: ToolDescriptor = {
    id: 'lifecycle',
    connector: 'test',
    description: '',
    input: {},
    url: () => 'https://x.test/data',
    parse: (raw) => raw,
    format: 'text'
  }

  it.each([400, 429, 503])('F02 cancels every unfinished HTTP %i body', async (status) => {
    const cancellations: ReturnType<typeof vi.fn>[] = []
    const fetchImpl = vi.fn(async () => {
      const cancel = vi.fn()
      cancellations.push(cancel)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel
        }),
        { status }
      )
    })
    const engine = new ParserEngine({ fetchImpl, retryBackoffMs: 0 })
    await expect(engine.call(descriptor, {}, {})).rejects.toThrow(`HTTP ${status}`)
    expect(fetchImpl).toHaveBeenCalledTimes(status === 400 ? 1 : 3)
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledOnce()
  })

  it('F03 includes retry backoff in the call deadline', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
      const engine = new ParserEngine({ fetchImpl, totalTimeoutMs: 30, retryBackoffMs: 40 })
      const result = engine.call(descriptor, {}, {}).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(30)
      expect(await Promise.race([result, Promise.resolve('still pending')])).toMatchObject({
        name: 'ConnectorRequestTimeoutError',
        message: expect.stringContaining('30ms total deadline')
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      await vi.runAllTimersAsync()
      await result
    } finally {
      vi.useRealTimers()
    }
  })

  it('F03 stops waiting for a run descriptor that ignores cancellation', async () => {
    vi.useFakeTimers()
    try {
      const result = new ParserEngine({ totalTimeoutMs: 30 })
        .call(
          {
            ...descriptor,
            run: async () => new Promise(() => {})
          },
          {},
          {}
        )
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(30)
      expect(await Promise.race([result, Promise.resolve('still pending')])).toMatchObject({
        name: 'ConnectorRequestTimeoutError'
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('F03 shares the call deadline across sequential fetches', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20)
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(init.signal?.reason)
            },
            { once: true }
          )
        })
        return new Response('ok')
      })
      const engine = new ParserEngine({ fetchImpl, totalTimeoutMs: 30 })
      const result = engine
        .call(
          {
            ...descriptor,
            run: async (ctx) => {
              await ctx.fetchText('https://x.test/one')
              return ctx.fetchText('https://x.test/two')
            }
          },
          {},
          {}
        )
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(40)
      expect(await result).toMatchObject({ name: 'ConnectorRequestTimeoutError' })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['60', 'Sat, 05 Sep 2026 00:01:00 GMT'])(
    'F04 does not retry before Retry-After %s',
    async (retryAfter) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-05T00:00:00Z'))
      try {
        const fetchImpl = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } })
          )
          .mockResolvedValueOnce(new Response('ok'))
        const result = new ParserEngine({ fetchImpl }).call(descriptor, {}, {})
        await vi.advanceTimersByTimeAsync(59_999)
        expect(fetchImpl).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(1)
        await expect(result).resolves.toBe('ok')
        expect(fetchImpl).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('F04 returns HTTP status and retry time when the call budget cannot fit Retry-After', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': '60' }
          })
      )
      const result = new ParserEngine({ fetchImpl, totalTimeoutMs: 30_000 })
        .call(descriptor, {}, {})
        .catch((error: unknown) => error)
      await vi.runAllTimersAsync()
      expect(await result).toMatchObject({
        message: expect.stringMatching(/HTTP 429.*Retry after 60s/)
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ParserEngine body cleanup edge cases', () => {
  const descriptor: ToolDescriptor = {
    id: 'cleanup',
    connector: 'test',
    description: '',
    input: {},
    url: () => 'https://x.test/data',
    parse: (raw) => raw,
    format: 'text'
  }

  it.each(['reject', 'pending'])(
    'F02 preserves HTTP failure when cancellation is %s',
    async (mode) => {
      const cancel = vi.fn(() =>
        mode === 'reject' ? Promise.reject(new Error('cancel failed')) : new Promise<void>(() => {})
      )
      const response = new Response(new ReadableStream({ cancel }), { status: 400 })
      const engine = new ParserEngine({ fetchImpl: vi.fn().mockResolvedValue(response) })
      await expect(engine.call(descriptor, {}, {})).rejects.toThrow('HTTP 400')
      expect(cancel).toHaveBeenCalledOnce()
    }
  )

  it('F02 cancels the remainder of an oversized successful body', async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10))
        },
        cancel
      })
    )
    const engine = new ParserEngine({
      fetchImpl: vi.fn().mockResolvedValue(response),
      maxResponseBytes: 5
    })
    await expect(engine.call(descriptor, {}, {})).rejects.toMatchObject({
      name: 'ConnectorResponseTooLargeError'
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it('F02 attempts cleanup after a body read fails without hiding the error', async () => {
    const error = new Error('stream read failed')
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(error)
        }
      })
    )
    const cancel = vi.spyOn(response.body!, 'cancel')
    const engine = new ParserEngine({ fetchImpl: vi.fn().mockResolvedValue(response), retries: 0 })
    await expect(engine.call(descriptor, {}, {})).rejects.toBe(error)
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it.each(['user', 'idle', 'total'])(
    'F02 cancels a stalled body on %s cancellation',
    async (mode) => {
      vi.useFakeTimers()
      try {
        const cancel = vi.fn()
        const response = new Response(new ReadableStream({ cancel }))
        const caller = new AbortController()
        const engine = new ParserEngine({
          fetchImpl: vi.fn().mockResolvedValue(response),
          timeoutMs: mode === 'idle' ? 10 : 100,
          totalTimeoutMs: mode === 'total' ? 10 : 100
        })
        const result = engine
          .call(descriptor, {}, {}, caller.signal)
          .catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(0)
        if (mode === 'user') caller.abort()
        await vi.advanceTimersByTimeAsync(10)
        expect(await Promise.race([result, Promise.resolve('still pending')])).toMatchObject({
          name: mode === 'user' ? 'AbortError' : 'ConnectorRequestTimeoutError'
        })
        expect(cancel).toHaveBeenCalledOnce()
        expect(response.body?.locked).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
