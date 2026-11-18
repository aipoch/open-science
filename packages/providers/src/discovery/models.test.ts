import { describe, expect, it, vi } from 'vitest'

import { listProviderModels, parseModelIds } from './models'

describe('parseModelIds', () => {
  it('extracts non-empty string ids from a { data: [{ id }] } payload', () => {
    expect(parseModelIds({ data: [{ id: 'a' }, { id: 'b' }, { id: '' }, { id: 5 }, {}] })).toEqual([
      'a',
      'b'
    ])
  })

  it('returns [] for non-list shapes', () => {
    expect(parseModelIds(null)).toEqual([])
    expect(parseModelIds({ data: 'nope' })).toEqual([])
    expect(parseModelIds({})).toEqual([])
  })
})

describe('listProviderModels', () => {
  it('requests the given models URL with auth and returns the parsed ids', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] })
      )

    const result = await listProviderModels(
      { url: 'https://api.deepseek.com/v1/models', vendorId: 'deepseek', key: 'sk-1' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/models')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-1')
    expect((init.headers as Record<string, string>)['x-api-key']).toBeUndefined()
  })

  it('uses only x-api-key for the Anthropic model catalog', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'claude-opus-5' }] }))

    await expect(
      listProviderModels(
        { url: 'https://api.anthropic.com/v1/models', vendorId: 'anthropic', key: 'sk-ant-1' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toMatchObject({ ok: true })

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(headers['x-api-key']).toBe('sk-ant-1')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('reports a non-2xx status without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }))

    const result = await listProviderModels(
      { url: 'https://api.deepseek.com/v1/models', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ status: 401, code: 'authentication' })
  })

  it('cancels an unread error body before returning the failure', async () => {
    const cancel = vi.fn()
    const fetchImpl = vi.fn(
      async () => new Response(new ReadableStream({ cancel }), { status: 429 })
    )
    await expect(
      listProviderModels({ url: 'https://example.test/models' }, { fetchImpl })
    ).resolves.toMatchObject({ ok: false, status: 429, code: 'rate-limit' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('requires at least one usable advertised route across the complete catalog', async () => {
    const target = {
      url: 'https://example.test/models',
      options: { auth: 'none', routes: { type: 'map', path: 'api', baseUrlPath: 'base_url' } }
    } as const
    const unknown = { id: 'unknown', api: { future: { base_url: target.url } } }
    const supported = { id: 'supported', api: { messages: { base_url: target.url } } }
    for (const data of [
      [unknown],
      [{ id: 'missing' }],
      [{ id: 'malformed', api: { messages: { base_url: '?' } } }]
    ]) {
      expect(
        await listProviderModels(target, { fetchImpl: async () => Response.json({ data }) })
      ).toMatchObject({ ok: false, code: 'invalid-response' })
    }
    expect(
      await listProviderModels(target, {
        fetchImpl: async () => Response.json({ data: [unknown, supported] })
      })
    ).toMatchObject({
      ok: true,
      catalog: [
        { id: 'unknown', routes: {} },
        { id: 'supported', routes: { messages: target.url } }
      ]
    })
  })

  it('fails on an invalid model-list URL', async () => {
    expect((await listProviderModels({ url: 'not a url' })).ok).toBe(false)
  })

  it('rejects a model-list response that exceeds the byte budget', async () => {
    const body = JSON.stringify({
      data: [{ id: 'model-a' }],
      padding: 'x'.repeat(2 * 1024 * 1024)
    })
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 }))

    await expect(
      listProviderModels(
        { url: 'https://api.deepseek.com/v1/models', key: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toEqual({
      ok: false,
      code: 'resource-limit',
      message: 'Model list response exceeded 2097152 bytes.'
    })
  })

  it.each(['declared', 'streamed'] as const)(
    'classifies an oversized configured catalog as a resource limit (%s bytes)',
    async (source) => {
      const response =
        source === 'declared'
          ? new Response(null, { headers: { 'content-length': '10' } })
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"data":'))
                  controller.enqueue(new TextEncoder().encode('[]}'))
                  controller.close()
                }
              })
            )

      const result = await listProviderModels(
        { url: 'https://example.test/models', options: { auth: 'none' } },
        { fetchImpl: async () => response, limits: { modelListResponseBytes: 8 } }
      )

      expect(result).toMatchObject({ ok: false, code: 'resource-limit' })
    }
  )

  it('rejects a model catalog with more than 2000 model ids', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json({
        data: Array.from({ length: 2_001 }, (_, index) => ({ id: `model-${index}` }))
      })
    )

    await expect(
      listProviderModels(
        { url: 'https://api.deepseek.com/v1/models', key: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toEqual({
      ok: false,
      status: 200,
      code: 'resource-limit',
      message: 'The vendor returned more than 2000 models.'
    })
  })

  it('rejects a model catalog containing an oversized model id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'm'.repeat(513) }] }))

    await expect(
      listProviderModels(
        { url: 'https://api.deepseek.com/v1/models', key: 'k' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toEqual({
      ok: false,
      status: 200,
      code: 'resource-limit',
      message: 'The vendor returned a model ID longer than 512 characters.'
    })
  })
})

it('does not send a pre-cancelled discovery request', async () => {
  const fetchImpl = vi.fn()
  const result = await listProviderModels(
    { url: 'https://example.test/models' },
    {
      fetchImpl,
      signal: AbortSignal.abort(new Error('caller cancelled'))
    }
  )
  expect(result).toEqual({ ok: false, code: 'network', message: 'caller cancelled' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

it.each(['caller', 'timeout'])(
  'cancels stalled response reads on %s cancellation',
  async (source) => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn(),
        controller = new AbortController()
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel })))
      const request = listProviderModels(
        { url: 'https://example.test/models' },
        {
          fetchImpl,
          signal: controller.signal,
          timeoutMs: 10
        }
      )
      await vi.advanceTimersByTimeAsync(0)
      if (source === 'caller') controller.abort(new Error('caller cancelled'))
      else await vi.advanceTimersByTimeAsync(10)
      expect(await request).toMatchObject({ ok: false })
      expect(cancel).toHaveBeenCalledOnce()
      expect(fetchImpl.mock.calls).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  }
)

it.each(['modelListResponseBytes', 'fetchedModels', 'modelIdCharacters'] as const)(
  'rejects invalid %s limits before sending',
  async (field) => {
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const fetchImpl = vi.fn()
      expect(
        await listProviderModels(
          { url: 'https://example.test/models' },
          { fetchImpl, limits: { [field]: value } }
        )
      ).toEqual({
        ok: false,
        code: 'resource-limit',
        message: 'Invalid model-list resource limits.'
      })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  }
)

it('retains default limits for undefined options and rejects overflowing timeouts', async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ data: Array.from({ length: 2001 }, (_, index) => ({ id: `m${index}` })) })
  )
  expect(
    await listProviderModels(
      { url: 'https://example.test/models' },
      { fetchImpl, timeoutMs: undefined, limits: { fetchedModels: undefined } }
    )
  ).toMatchObject({ ok: false, message: 'The vendor returned more than 2000 models.' })
  for (const timeoutMs of [0, -1, Infinity, 2_147_483_648]) {
    expect(
      await listProviderModels({ url: 'https://example.test/models' }, { fetchImpl, timeoutMs })
    ).toEqual({ ok: false, code: 'resource-limit', message: 'Invalid model-list resource limits.' })
  }
  expect(fetchImpl).toHaveBeenCalledOnce()
})
