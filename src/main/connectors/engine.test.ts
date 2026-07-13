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

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response)
    const engine = new ParserEngine({ fetchImpl })
    const desc: ToolDescriptor = {
      id: 't',
      connector: 'c',
      description: '',
      input: {},
      url: () => 'https://x.test',
      parse: (r) => r
    }
    await expect(engine.call(desc, {}, {})).rejects.toThrow(/HTTP 503/)
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
