import { describe, expect, it, vi, type Mock } from 'vitest'
import { discoveryReferenceSchema, type DiscoveryReference } from '../src/contracts.js'
import { LiteratureRelatedFinder } from '../src/related.js'
import { literatureRelatedRequestSchema } from '../src/related-contracts.js'

const id = 'a'.repeat(40),
  child = 'b'.repeat(40)
const paper = {
  paperId: id,
  title: 'Seed',
  authors: [{ name: 'Full Name' }],
  externalIds: { DOI: '10.1234/seed' }
}
const reference = (
  identifiers: unknown[] = [{ scheme: 'doi', value: '10.1234/seed' }]
): DiscoveryReference =>
  discoveryReferenceSchema.parse({
    id: 'local',
    metadataRevision: 1,
    attachments: [],
    item: { itemType: 'journalArticle', title: 'Seed', identifiers }
  })
const request = {
  itemId: 'local',
  expectedMetadataRevision: 1,
  direction: 'references' as const,
  offset: 0
}
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const fixture = (
  rows: Response[],
  item = reference()
): {
  finder: LiteratureRelatedFinder
  fetcher: Mock<typeof fetch>
  catalog: { get: Mock<() => Promise<DiscoveryReference>>; sources: Mock<() => Promise<never[]>> }
} => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => rows.shift()!)
  const catalog = { get: vi.fn(async () => item), sources: vi.fn(async () => []) }
  const finder = new LiteratureRelatedFinder({
    catalog,
    fetch: fetcher,
    apiKey: async () => 'secret-key'
  })
  return { finder, catalog, fetcher }
}

describe('single-paper Semantic Scholar discovery', () => {
  it('uses DOI identity, plain relationship fields, safe attribution and literal authors', async () => {
    const { finder, fetcher } = fixture([
      json(paper),
      json({
        offset: 0,
        next: 20,
        data: [{ citedPaper: { ...paper, paperId: child } }, { citedPaper: null }]
      })
    ])
    const result = await finder.run(request)
    expect(result).toMatchObject({
      state: 'ready',
      nextOffset: 20,
      omitted: 1,
      records: [
        {
          paperId: child,
          item: {
            creators: [{ nameMode: 'organization', literalName: 'Full Name' }],
            url: `https://www.semanticscholar.org/paper/${child}`
          }
        }
      ]
    })
    expect(fetcher.mock.calls[0][0]).toContain('paper/DOI%3A10.1234%2Fseed')
    const url = new URL(String(fetcher.mock.calls[1][0]))
    expect(url.pathname).toBe(`/graph/v1/paper/${id}/references`)
    expect(url.searchParams.get('fields')).not.toContain('citedPaper.')
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      headers: { 'x-api-key': 'secret-key' }
    })
    expect(JSON.stringify(result)).not.toContain('secret-key')
  })
  it('uses the documented numeric PMCID form and preserves large citation offsets', async () => {
    const { finder, fetcher } = fixture(
      [json(paper), json({ offset: 0, next: 10000, data: [] })],
      reference([{ scheme: 'pmcid', value: 'PMC2323736' }])
    )
    expect((await finder.run(request)).nextOffset).toBe(10000)
    expect(String(fetcher.mock.calls[0][0])).toContain('paper/PMCID%3A2323736?')
  })
  it('requires confirmation of title matches and binds the token to the local reference', async () => {
    const { finder, fetcher } = fixture(
      [
        json({ data: [paper] }),
        json({ offset: 0, data: [{ citingPaper: { ...paper, paperId: child } }] })
      ],
      reference([])
    )
    const match = await finder.run(request)
    expect(match.state).toBe('match-required')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toContain('paper/search/match?query=Seed')
    const result = await finder.run({
      ...request,
      direction: 'citations',
      resolutionToken: match.resolutionToken
    })
    expect(result.records[0].paperId).toBe(child)
    expect(String(fetcher.mock.calls[1][0])).toContain('/citations?')
    expect(
      (
        await finder.run({
          ...request,
          expectedMetadataRevision: 2,
          resolutionToken: match.resolutionToken
        })
      ).issue
    ).toBe('reference-changed')
  })
  it('preserves pagination offsets and rejects regressing cursors', async () => {
    const { finder } = fixture([
      json(paper),
      json({ offset: 0, next: 20, data: [] }),
      json({ offset: 20, next: 20, data: [] })
    ])
    const first = await finder.run(request)
    expect(
      (await finder.run({ ...request, offset: 20, resolutionToken: first.resolutionToken })).issue
    ).toBe('response-invalid')
  })
  it('honors bounded Retry-After without retry storms or exposing response bodies', async () => {
    const { finder, fetcher } = fixture([
      new Response('secret upstream error', { status: 429, headers: { 'retry-after': '9999999' } })
    ])
    const result = await finder.run(request)
    expect(result.issue).toBe('rate-limited')
    expect(result.retryAt! - Date.now()).toBeLessThanOrEqual(300000)
    expect((await finder.run(request)).issue).toBe('rate-limited')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('secret upstream error')
  })
  it.each([401, 403, 404, 503])(
    'reports HTTP %s as failure, not an empty successful page',
    async (status) => {
      const { finder } = fixture([new Response('', { status })])
      expect(await finder.run(request)).toMatchObject({
        state: 'unavailable',
        issue: status === 404 ? 'no-match' : status === 503 ? 'unavailable' : 'authentication'
      })
    }
  )
  it('rejects oversized and malformed responses', async () => {
    for (const response of [
      new Response('x'.repeat(2 * 1024 * 1024 + 1)),
      json({ paperId: '../../secret', title: 'unsafe' })
    ]) {
      const { finder } = fixture([response])
      expect((await finder.run(request)).issue).toBe('response-invalid')
    }
  })
  it('discards responses when the reference changes during lookup and honors cancellation', async () => {
    const { finder, catalog } = fixture([json(paper), json({ offset: 0, data: [] })])
    catalog.get
      .mockResolvedValueOnce(reference())
      .mockResolvedValue({ ...reference(), metadataRevision: 2 })
    expect((await finder.run(request)).issue).toBe('reference-changed')
    const controller = new AbortController()
    controller.abort()
    await expect(finder.run(request, controller.signal)).rejects.toThrow()
  })
  it('rejects expired resolution tokens and arbitrary URLs or keyword search inputs', async () => {
    const { finder, fetcher } = fixture([])
    expect(
      (await finder.run({ ...request, resolutionToken: '00000000-0000-4000-8000-000000000000' }))
        .issue
    ).toBe('expired')
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      literatureRelatedRequestSchema.safeParse({ ...request, query: 'anything' }).success
    ).toBe(false)
    expect(literatureRelatedRequestSchema.safeParse({ ...request, offset: -1 }).success).toBe(false)
  })
})
