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
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] })
    })

    const result = await listProviderModels(
      { url: 'https://api.deepseek.com/v1/models', key: 'sk-1' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/models')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-1')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-1')
  })

  it('reports a non-2xx status without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 401, json: () => Promise.resolve({}) })

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
})
