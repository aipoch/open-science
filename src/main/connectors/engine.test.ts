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

  it('retries a network/timeout error then succeeds', async () => {
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
