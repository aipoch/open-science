import { describe, expect, it, vi } from 'vitest'

import { listProviderModels, parseModelIds } from './list-models'

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
  })

  it('reports a non-2xx status without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }))

    const result = await listProviderModels(
      { url: 'https://api.deepseek.com/v1/models', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
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
      message: 'Model list response exceeded 2097152 bytes.'
    })
  })

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
      message: 'The vendor returned a model ID longer than 512 characters.'
    })
  })
})
