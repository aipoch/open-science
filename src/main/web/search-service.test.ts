import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  searchInputSchema,
  WEB_RESULT_MAX_BYTES,
  WEB_RESULT_MAX_CODE_UNITS,
  webResultSchema,
  type WebResult
} from '../../shared/web-tools'
import { WebSessionSlots } from './limits'
import { SearchService } from './search-service'
import { createWebMcpServer } from './mcp-server'
import { ExaSearchProvider, SearchProviderError, type SearchProvider } from './search-provider'

const sources = (...urls: string[]): WebResult['sources'] =>
  urls.map((url, index) => ({
    source_id: String(index),
    url,
    title: `Source ${index}`,
    snippet: 'Research',
    evidence_kind: 'provider_excerpt'
  }))
const provider = (): { search: Mock<SearchProvider['search']> } => ({
  search: vi
    .fn<SearchProvider['search']>()
    .mockResolvedValue({ sources: sources('https://example.org/paper') })
})

describe('search request boundary', () => {
  it('enforces trimmed code points, raw serialized limits, unknown fields and finite bounds', () => {
    expect(searchInputSchema.safeParse({ query: '😀'.repeat(2000) }).success).toBe(true)
    for (const input of [
      { query: '   ' },
      { query: '😀'.repeat(2001) },
      { query: ' '.repeat(7000) + 'x' },
      { query: 'a', max_results: 0 },
      { query: 'a', max_results: 11 },
      { query: 'a', provider: 'fake' },
      { query: 'a', allowed_domains: Array(11).fill('example.org') },
      { query: 'a'.repeat(2000), allowed_domains: Array(10).fill('x'.repeat(60) + '.org') }
    ]) {
      // Last item stays below the serialized limit and is deliberately valid.
      if ('allowed_domains' in input && input.allowed_domains?.[0].startsWith('xxx'))
        expect(searchInputSchema.safeParse(input).success).toBe(true)
      else expect(searchInputSchema.safeParse(input).success).toBe(false)
    }
    expect(searchInputSchema.safeParse({ query: '\u0000'.repeat(1500) }).success).toBe(false)
  })
  it.each([
    'https://example.org',
    'example.org/path',
    '*.example.org',
    'user@example.org',
    'example.org:443',
    'example..org',
    '127.0.0.1',
    '[::1]'
  ])('rejects a non-domain allowlist entry %s', (domain) => {
    expect(
      searchInputSchema.safeParse({ query: 'science', allowed_domains: [domain] }).success
    ).toBe(false)
  })
})

describe('search service', () => {
  it('normalizes input, applies label-boundary post filters and records actual provenance/count', async () => {
    const p = provider()
    p.search.mockResolvedValue({
      sources: sources(
        'https://example.org/one',
        'https://sub.example.org/two',
        'https://badexample.org/three',
        'https://example.org.evil.com/four'
      )
    })
    const output = await new SearchService({ provider: p }).search('session', {
      query: '  science  ',
      allowed_domains: ['EXAMPLE.ORG.']
    })
    expect(p.search).toHaveBeenCalledWith(
      { query: 'science', allowed_domains: ['example.org'] },
      expect.any(AbortSignal)
    )
    expect(output).toMatchObject({
      status: 'ok',
      returned_count: 2,
      provider: { id: 'exa', auth_mode: 'anonymous' },
      effective_filters: { allowed_domains: ['example.org'], domain_mode: 'post_filter' }
    })
    expect(output.sources.map((source) => source.url)).toEqual([
      'https://example.org/one',
      'https://sub.example.org/two'
    ])
  })
  it('returns a successful empty result when all sources are outside the allowed domains', async () => {
    const output = await new SearchService({ provider: provider() }).search('s', {
      query: 'science',
      allowed_domains: ['different.org']
    })
    expect(output).toMatchObject({ status: 'ok', returned_count: 0, sources: [] })
  })
  it('retains Retry-After and cools down without a second provider request, then expires', async () => {
    const p = provider()
    let now = 10_000
    p.search.mockRejectedValueOnce(new SearchProviderError('RATE_LIMITED', true, 3000))
    const service = new SearchService({ provider: p, now: () => now })
    expect((await service.search('s', { query: 'one' })).error).toMatchObject({
      code: 'RATE_LIMITED',
      retry_after_ms: 3000
    })
    now += 1000
    expect((await service.search('different-session', { query: 'two' })).error).toMatchObject({
      code: 'RATE_LIMITED',
      retry_after_ms: 2000
    })
    expect(p.search).toHaveBeenCalledOnce()
    now += 2001
    expect((await service.search('s', { query: 'three' })).status).toBe('ok')
    expect(p.search).toHaveBeenCalledTimes(2)
  })
  it('keeps the longer cooldown when concurrent attempts return different Retry-After values', async () => {
    const p = provider()
    let now = 10_000
    const longWait = Promise.withResolvers<Awaited<ReturnType<SearchProvider['search']>>>()
    const shortWait = Promise.withResolvers<Awaited<ReturnType<SearchProvider['search']>>>()
    const dispatched = Promise.withResolvers<void>()
    p.search.mockReturnValueOnce(longWait.promise).mockImplementationOnce(() => {
      dispatched.resolve()
      return shortWait.promise
    })
    const service = new SearchService({ provider: p, now: () => now })
    const first = service.search('first', { query: 'one' })
    const second = service.search('second', { query: 'two' })
    await dispatched.promise
    longWait.reject(new SearchProviderError('RATE_LIMITED', true, 5000))
    await first
    shortWait.reject(new SearchProviderError('RATE_LIMITED', true, 1000))
    expect((await second).error?.retry_after_ms).toBe(1000)
    now += 1001
    expect((await service.search('s', { query: 'three' })).error).toMatchObject({
      code: 'RATE_LIMITED',
      retry_after_ms: 3999
    })
    expect(p.search).toHaveBeenCalledTimes(2)
  })
  it('uses a bounded default cooldown when the provider supplies no Retry-After', async () => {
    const p = provider()
    p.search.mockRejectedValueOnce(new SearchProviderError('RATE_LIMITED', true))
    expect(
      (await new SearchService({ provider: p }).search('s', { query: 'science' })).error
    ).toMatchObject({ code: 'RATE_LIMITED', retry_after_ms: 60_000 })
  })
  it('bounds the complete serialized Unicode envelope while preserving valid JSON and source identities', async () => {
    const p = provider()
    p.search.mockResolvedValue({
      sources: Array.from({ length: 10 }, (_, index) => ({
        ...sources(`https://example.org/${index}`)[0],
        source_id: String(index),
        title: '😀'.repeat(250),
        snippet: '"\\\u0000😀'.repeat(800)
      }))
    })
    const output = await new SearchService({ provider: p }).search('s', {
      query: 'science',
      max_results: 10
    })
    expect(output.status).toBe('ok')
    expect(output.results_truncated).toBe(true)
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(WEB_RESULT_MAX_CODE_UNITS)
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(WEB_RESULT_MAX_BYTES)
    expect(webResultSchema.safeParse(JSON.parse(JSON.stringify(output))).success).toBe(true)
    expect(output.returned_count).toBe(output.sources.length)
    expect(output.sources[0].url).toBe('https://example.org/0')
  })
  it('enforces the total deadline for a hung provider and leaves caller cancellation authoritative', async () => {
    const p = { search: vi.fn().mockImplementation(() => new Promise(() => undefined)) }
    const timed = await new SearchService({ provider: p, deadlineMs: 10 }).search('s', {
      query: 'science'
    })
    expect(timed.error?.code).toBe('TIMEOUT')
    expect(p.search.mock.calls[0][1].aborted).toBe(true)
    const controller = new AbortController()
    const running = new SearchService({ provider: p }).search(
      's',
      { query: 'science' },
      { signal: controller.signal }
    )
    controller.abort(new Error('user cancelled'))
    await expect(running).rejects.toThrow('user cancelled')
  })
  it('shares the session budget with fetch and honors cancellation while queued', async () => {
    const slots = new WebSessionSlots()
    const releases = await Promise.all(
      Array.from({ length: 3 }, () =>
        slots.acquire('project-session', new AbortController().signal)
      )
    )
    const p = provider()
    const onDispatch = vi.fn()
    const service = new SearchService({ provider: p, sessionSlots: slots, onDispatch })
    const controller = new AbortController()
    const cancelled = service.search(
      's',
      { query: 'one' },
      {
        signal: controller.signal,
        sessionSlotKey: 'project-session'
      }
    )
    controller.abort(new Error('cancel queue'))
    await expect(cancelled).rejects.toThrow('cancel queue')
    const queued = service.search('s', { query: 'two' }, { sessionSlotKey: 'project-session' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(p.search).not.toHaveBeenCalled()
    expect(onDispatch).not.toHaveBeenCalled()
    releases.forEach((release) => release())
    expect((await queued).status).toBe('ok')
    expect(p.search).toHaveBeenCalledOnce()
    expect(onDispatch).toHaveBeenCalledOnce()
  })
})

describe('Exa MCP integration', () => {
  it('applies month and domain filters through anonymous Exa on a Web MCP tool call', async () => {
    const endpoint = 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa'
    const publishedDate = '2026-11-17T08:00:00Z'
    const remoteSearch = vi.fn().mockReturnValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              {
                title: 'Older',
                url: 'https://example.org/older',
                publishedDate: '2026-10-01T00:00:00Z'
              },
              { title: 'Undated', url: 'https://example.org/undated' },
              { title: 'Newer', url: 'https://example.org/newer', publishedDate },
              { title: 'Off domain', url: 'https://example.net/newer', publishedDate }
            ]
          })
        }
      ]
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 405 })
      const message = JSON.parse(String(init?.body))
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      let result: unknown
      if (message.method === 'initialize') {
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'exa-advanced-fixture', version: '1' }
        }
      } else if (message.method === 'tools/call') {
        result = remoteSearch(message.params)
      } else {
        throw new Error(`Unexpected Exa MCP method: ${message.method}`)
      }
      return Response.json({ jsonrpc: '2.0', id: message.id, result })
    })
    const service = new SearchService({ provider: new ExaSearchProvider({ fetch }) })
    const server = createWebMcpServer({
      search: (input, context) => service.search('s', input, context),
      fetchPage: vi.fn()
    })
    const client = new Client({ name: 'search-freshness-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-18T10:00:00Z'))
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const input = {
        query: 'public science',
        freshness: 'month',
        max_results: 4,
        allowed_domains: ['example.org']
      }
      const result = await client.callTool({ name: 'web_search', arguments: input })
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent).not.toHaveProperty('routing')
      expect(result).toMatchObject({
        content: [],
        structuredContent: {
          request: input,
          status: 'ok',
          provider: { id: 'exa', auth_mode: 'anonymous' },
          attempts: [
            {
              index: 1,
              provider: { id: 'exa', auth_mode: 'anonymous' },
              status: 'ok',
              execution: 'direct_search',
              search_executed: true
            }
          ],
          effective_filters: {
            allowed_domains: ['example.org'],
            domain_mode: 'native',
            freshness: 'month'
          },
          sources: [
            {
              url: 'https://example.org/newer',
              published_at: publishedDate,
              attempt_index: 1,
              evidence_kind: 'provider_excerpt'
            }
          ],
          returned_count: 1
        }
      })
      expect(remoteSearch).toHaveBeenCalledExactlyOnceWith({
        name: 'web_search_advanced_exa',
        arguments: expect.objectContaining({
          query: input.query,
          numResults: input.max_results,
          startPublishedDate: '2026-10-19T10:00:00.000Z',
          endPublishedDate: '2026-11-18T10:00:00.000Z',
          includeDomains: ['example.org']
        })
      })
      expect(fetch.mock.calls.every(([url]) => String(url) === endpoint)).toBe(true)
    } finally {
      vi.useRealTimers()
      await client.close()
      await server.close()
    }
  })
})

describe('v1/v2 evidence boundary', () => {
  it('reads strict historical v1 without invented attempts and rejects extension smuggling or unknown versions', () => {
    const old = {
      schema: 'open-science.web.v1',
      invocation_id: 'old',
      operation: 'search',
      status: 'ok',
      request: { query: 'old' },
      retrieved_at: '2026-11-16T00:00:00Z',
      duration_ms: 1,
      provider: { id: 'exa', auth_mode: 'anonymous', data_policy_version: 'historic' },
      sources: [],
      returned_count: 0
    }
    expect(webResultSchema.parse(old)).toEqual(old)
    expect(webResultSchema.safeParse({ ...old, attempts: [] }).success).toBe(false)
    expect(webResultSchema.safeParse({ ...old, schema: 'open-science.web.v3' }).success).toBe(false)
  })
  it('requires a real successful executed attempt for citations and keeps metering finite and bounded', async () => {
    const result = await new SearchService({
      provider: { search: async () => ({ sources: sources('https://example.org/paper') }) }
    }).search('s', { query: 'science' })
    expect(webResultSchema.safeParse(result).success).toBe(true)
    expect(
      webResultSchema.safeParse({
        ...result,
        sources: [{ ...result.sources[0], attempt_index: 2 }]
      }).success
    ).toBe(false)
    expect(
      webResultSchema.safeParse({
        ...result,
        attempts: [{ ...result.attempts![0], usage: { credits: Infinity } }]
      }).success
    ).toBe(false)
    expect(
      webResultSchema.safeParse({
        ...result,
        attempts: [{ ...result.attempts![0], search_executed: false }]
      }).success
    ).toBe(false)
  })
})
