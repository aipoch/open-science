import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { discoveryReferenceSchema, type DiscoveryReference } from '../src/contracts.js'
import { LiteratureRelatedFinder } from '../src/related.js'
import {
  literatureRelatedPaperIdSchema,
  literatureRelatedRequestSchema,
  literatureRelatedResultSchema
} from '../src/related-contracts.js'

const reference = (): DiscoveryReference =>
  discoveryReferenceSchema.parse({
    id: 'local',
    metadataRevision: 1,
    attachments: [],
    item: {
      itemType: 'journalArticle',
      title: 'Seed',
      identifiers: [{ scheme: 'doi', value: '10.1234/seed' }]
    }
  })
const request = {
  itemId: 'local',
  expectedMetadataRevision: 1,
  direction: 'references' as const,
  offset: 0
}
const paper = { source: 'MED', id: '9999', title: 'Seed', doi: '10.1234/seed' }
const rootId = 'europe-pmc:MED:9999'
const json = (value: unknown): Response => new Response(JSON.stringify(value))
const identity = (): Response => json({ hitCount: 1, resultList: { result: [paper] } })
function page(input: string | URL | Request, ids: string[] = ['1'], count = ids.length): Response {
  const url = new URL(String(input))
  const [, source, id, direction] = /\/rest\/([^/]+)\/([^/]+)\/(references|citations)$/.exec(
    url.pathname
  )!
  const pageNumber = Number(url.searchParams.get('page'))
  return json({
    hitCount: count,
    request: {
      source,
      id,
      pageSize: 20,
      offSet: pageNumber - (direction === 'citations' ? 1 : 0)
    },
    [direction === 'references' ? 'referenceList' : 'citationList']: {
      [direction === 'references' ? 'reference' : 'citation']: ids.map((id) => ({
        source: 'MED',
        id,
        title: `Paper ${id}`
      }))
    }
  })
}
function fixture(): {
  finder: LiteratureRelatedFinder
  catalog: { get: Mock<() => Promise<DiscoveryReference>>; sources: Mock<() => Promise<never[]>> }
  fetcher: Mock<typeof fetch>
  advance(milliseconds: number): void
} {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const catalog = { get: vi.fn(async () => reference()), sources: vi.fn(async () => []) }
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    now += 1001
    return String(input).includes('/search?') ? identity() : page(input)
  })
  return {
    finder: new LiteratureRelatedFinder({ catalog, fetch: fetcher }),
    catalog,
    fetcher,
    advance: (milliseconds: number) => {
      now += milliseconds
    }
  }
}

describe('citation discovery session safeguards', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rejects removed Semantic Scholar graph inputs before any catalog or transport access', async () => {
    const { finder, catalog, fetcher } = fixture()
    expect(
      literatureRelatedRequestSchema.safeParse({ ...request, provider: 'semantic-scholar' }).success
    ).toBe(false)
    for (const seedPaperId of ['a'.repeat(40), 'A'.repeat(40)]) {
      expect(literatureRelatedPaperIdSchema.safeParse(seedPaperId).success).toBe(false)
      await expect(finder.run({ ...request, seedPaperId })).rejects.toThrow()
    }
    await expect(
      finder.run({ ...request, provider: 'semantic-scholar' } as never)
    ).rejects.toThrow()
    expect(catalog.get).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const result = { ...request, state: 'ready', records: [], metadataRevision: 1 }
    delete (result as { expectedMetadataRevision?: number }).expectedMetadataRevision
    delete (result as { offset?: number }).offset
    expect(literatureRelatedResultSchema.safeParse(result).success).toBe(true)
    for (const obsolete of [
      { provider: 'semantic-scholar' },
      { fallbackFrom: 'europe-pmc' },
      { issue: 'api-key-required' },
      { state: 'match-required' }
    ])
      expect(literatureRelatedResultSchema.safeParse({ ...result, ...obsolete }).success).toBe(
        false
      )
  })

  it('inherits a token source when provider is omitted and accepts legacy auto for Europe PMC', async () => {
    const { finder, fetcher } = fixture()
    const root = await finder.run(request)
    for (const provider of [undefined, 'auto', 'europe-pmc'] as const)
      expect(
        await finder.run({ ...request, provider, resolutionToken: root.resolutionToken })
      ).toMatchObject({
        state: 'ready',
        provider: 'europe-pmc',
        resolutionToken: root.resolutionToken
      })
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith('https://www.ebi.ac.uk/'))
    ).toBe(true)
    expect(
      fetcher.mock.calls.every(
        ([, options]) => options?.headers && !('x-api-key' in options.headers)
      )
    ).toBe(true)
  })

  it('grants exploration only to completed pages and preserves the original token', async () => {
    const { finder, fetcher } = fixture()
    const root = await finder.run(request)
    const child = await finder.run({
      ...request,
      resolutionToken: root.resolutionToken,
      seedPaperId: 'europe-pmc:MED:1'
    })
    expect(child).toMatchObject({ state: 'ready', seed: { paperId: 'europe-pmc:MED:1' } })
    expect(child.resolutionToken).not.toBe(root.resolutionToken)
    expect(
      await finder.run({
        ...request,
        direction: 'citations',
        resolutionToken: root.resolutionToken
      })
    ).toMatchObject({
      state: 'ready',
      seed: { paperId: rootId },
      resolutionToken: root.resolutionToken
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(String(fetcher.mock.calls[2][0])).toContain('/MED/1/references?')
    for (const change of [
      { seedPaperId: 'europe-pmc:MED:1' },
      { resolutionToken: root.resolutionToken, seedPaperId: 'europe-pmc:MED:2' },
      { resolutionToken: root.resolutionToken, seedPaperId: 'europe-pmc:MED:1', offset: 20 },
      { resolutionToken: root.resolutionToken, provider: 'opencitations' as const }
    ])
      expect(await finder.run({ ...request, ...change })).toMatchObject({ issue: 'expired' })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it.each(['revision', 'deleted', 'merged'] as const)(
    'rechecks root %s before exploration',
    async (change) => {
      const { finder, catalog, fetcher } = fixture()
      const root = await finder.run(request)
      catalog.get.mockResolvedValue({
        ...reference(),
        ...(change === 'revision'
          ? { metadataRevision: 2 }
          : change === 'deleted'
            ? { deletedAt: Date.now() }
            : { id: 'survivor' })
      })
      expect(
        await finder.run({
          ...request,
          resolutionToken: root.resolutionToken,
          seedPaperId: 'europe-pmc:MED:1'
        })
      ).toMatchObject({ issue: 'reference-changed' })
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['changed', 'cancelled'] as const)(
    'does not grant new capabilities after a completed page is %s',
    async (failure) => {
      const { finder, catalog, fetcher } = fixture()
      const root = await finder.run(request)
      const controller = new AbortController()
      fetcher.mockImplementationOnce(async (input) => page(input, ['2']))
      catalog.get.mockResolvedValueOnce(reference()).mockImplementationOnce(async () => {
        if (failure === 'cancelled') controller.abort()
        return { ...reference(), metadataRevision: failure === 'changed' ? 2 : 1 }
      })
      const pending = finder.run(
        { ...request, resolutionToken: root.resolutionToken },
        controller.signal
      )
      if (failure === 'cancelled') await expect(pending).rejects.toThrow()
      else expect(await pending).toMatchObject({ issue: 'reference-changed', records: [] })
      expect(
        await finder.run({
          ...request,
          resolutionToken: root.resolutionToken,
          seedPaperId: 'europe-pmc:MED:2'
        })
      ).toMatchObject({ issue: 'expired' })
      expect(fetcher).toHaveBeenCalledTimes(3)
    }
  )

  it.each(['page', 'explore'] as const)(
    'binds a resolution token to its saved root during %s requests',
    async (action) => {
      const { finder, catalog, fetcher } = fixture()
      const root = await finder.run(request)
      catalog.get.mockResolvedValue({ ...reference(), id: 'another-root' })
      const result = await finder.run({
        ...request,
        itemId: 'another-root',
        resolutionToken: root.resolutionToken,
        ...(action === 'explore' ? { seedPaperId: 'europe-pmc:MED:1' } : { offset: 20 })
      })
      expect(result).toMatchObject({ state: 'unavailable', issue: 'expired', records: [] })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it('binds a resolution token to the original metadata revision', async () => {
    const { finder, catalog, fetcher } = fixture()
    const root = await finder.run(request)
    catalog.get.mockResolvedValue({ ...reference(), metadataRevision: 2 })
    expect(
      await finder.run({
        ...request,
        expectedMetadataRevision: 2,
        resolutionToken: root.resolutionToken
      })
    ).toMatchObject({ state: 'unavailable', issue: 'expired', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('expires a token after fifteen minutes without restarting root resolution', async () => {
    const { finder, advance, fetcher } = fixture()
    const root = await finder.run(request)
    advance(15 * 60_000)
    expect(await finder.run({ ...request, resolutionToken: root.resolutionToken })).toMatchObject({
      issue: 'expired'
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('bounds the number of retained sessions without invalidating the latest session', async () => {
    const { finder, fetcher } = fixture()
    const first = await finder.run(request)
    let last = first
    for (let index = 0; index < 200; index++) last = await finder.run(request)
    expect(await finder.run({ ...request, resolutionToken: first.resolutionToken })).toMatchObject({
      issue: 'expired'
    })
    expect(await finder.run({ ...request, resolutionToken: last.resolutionToken })).toMatchObject({
      state: 'ready'
    })
    expect(fetcher).toHaveBeenCalledTimes(403)
  })

  it('retains only the latest 2000 observed neighbors while keeping the seed explorable', async () => {
    const { finder, fetcher, advance } = fixture()
    fetcher.mockImplementation(async (input) => {
      advance(1001)
      const url = new URL(String(input))
      if (url.pathname.endsWith('/search')) return identity()
      const offset = (Number(url.searchParams.get('page')) - 1) * 20
      return page(
        input,
        Array.from({ length: 20 }, (_, index) => String(offset + index + 1)),
        2020
      )
    })
    const root = await finder.run(request)
    for (let offset = 20; offset <= 2000; offset += 20)
      expect(
        await finder.run({ ...request, resolutionToken: root.resolutionToken, offset })
      ).toMatchObject({ state: 'ready' })
    expect(
      await finder.run({
        ...request,
        resolutionToken: root.resolutionToken,
        seedPaperId: 'europe-pmc:MED:1'
      })
    ).toMatchObject({ issue: 'expired' })
    expect(
      await finder.run({
        ...request,
        resolutionToken: root.resolutionToken,
        seedPaperId: 'europe-pmc:MED:2020'
      })
    ).toMatchObject({ state: 'ready' })
    expect(
      await finder.run({ ...request, resolutionToken: root.resolutionToken, seedPaperId: rootId })
    ).toMatchObject({ state: 'ready' })
  })

  it('rejects unknown tokens and untrusted search inputs without fetching', async () => {
    const { finder, fetcher } = fixture()
    expect(
      await finder.run({ ...request, resolutionToken: '00000000-0000-4000-8000-000000000000' })
    ).toMatchObject({ issue: 'expired' })
    for (const invalid of [{ query: 'anything' }, { url: 'https://example.org' }, { offset: -1 }])
      expect(literatureRelatedRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(
        false
      )
    expect(fetcher).not.toHaveBeenCalled()
  })
})
