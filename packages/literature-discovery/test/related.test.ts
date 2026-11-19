import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { discoveryReferenceSchema, type DiscoveryReference } from '../src/contracts.js'
import { LiteratureRelatedFinder } from '../src/related.js'
import { resolveEuropePmc } from '../src/related-europe-pmc.js'
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

it.each([
  ['Targeting &lt;i&gt;Cirsium japonicum&lt;/i&gt;', 'Targeting Cirsium japonicum'],
  ['H<sub>2</sub>O &amp; &#945;', 'H2O & α'],
  ['Effects at p < 0.05 & controls', 'Effects at p < 0.05 & controls'],
  ['A &lt;gene&gt; marker', 'A <gene> marker'],
  ['Broken <i>format', 'Broken <i>format']
])('normalizes source title %s without interpreting arbitrary markup', async (title, expected) => {
  const result = await resolveEuropePmc(
    reference(),
    async () => ({ hitCount: 1, resultList: { result: [{ ...paper, title }] } }),
    async () => []
  )
  expect(result?.item.title).toBe(expected)
})

const json = (value: unknown): Response => new Response(JSON.stringify(value))
const identity = (): Response => json({ hitCount: 1, resultList: { result: [paper] } })
function page(input: string | URL | Request, ids: string[] = ['1'], count?: number): Response {
  const url = new URL(String(input))
  const [, source, id, direction] = /\/rest\/([^/]+)\/([^/]+)\/(references|citations)$/.exec(
    url.pathname
  )!
  const pageNumber = Number(url.searchParams.get('page'))
  return json({
    hitCount: count ?? (pageNumber - 1) * 20 + ids.length,
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

  it('reuses pages across reopened views, directions and pagination without sharing mutable output', async () => {
    const { finder, fetcher } = fixture()
    const first = await finder.run(request)
    const original = structuredClone(first)
    first.records[0].item.title = 'Changed in consumer'
    expect(await finder.run(request)).toEqual(original)
    const citations = await finder.run({ ...request, direction: 'citations' })
    const next = await finder.run({
      ...request,
      resolutionToken: first.resolutionToken,
      offset: 20
    })
    expect(citations.resolutionToken).toBe(first.resolutionToken)
    expect(await finder.run({ ...request, direction: 'citations' })).toEqual(citations)
    expect(
      await finder.run({ ...request, resolutionToken: first.resolutionToken, offset: 20 })
    ).toEqual(next)
    expect(fetcher).toHaveBeenCalledTimes(4)
    const child = await finder.run({
      ...request,
      resolutionToken: first.resolutionToken,
      seedPaperId: 'europe-pmc:MED:1'
    })
    expect(child.seed?.paperId).toBe('europe-pmc:MED:1')
    expect(await finder.run(request)).toEqual(original)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('caches successful empty pages but retries failures', async () => {
    const { finder, fetcher, advance } = fixture()
    const root = await finder.run(request)
    const citations = {
      ...request,
      direction: 'citations' as const,
      resolutionToken: root.resolutionToken
    }
    fetcher.mockImplementationOnce(async () => {
      advance(1001)
      return new Response('', { status: 503 })
    })
    expect(await finder.run(citations)).toMatchObject({ state: 'unavailable' })
    fetcher.mockImplementationOnce(async (input) => {
      advance(1001)
      return page(input, [])
    })
    expect(await finder.run(citations)).toMatchObject({ state: 'ready', records: [] })
    expect(await finder.run(citations)).toMatchObject({ state: 'ready', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('refreshes reopened roots after absolute expiry or metadata changes', async () => {
    const { finder, fetcher, catalog, advance } = fixture()
    const root = await finder.run(request)
    advance(23 * 60 * 60_000)
    expect((await finder.run(request)).resolutionToken).toBe(root.resolutionToken)
    advance(60 * 60_000)
    const fresh = await finder.run(request)
    expect(fresh.resolutionToken).not.toBe(root.resolutionToken)
    expect(fetcher).toHaveBeenCalledTimes(4)
    catalog.get.mockResolvedValue({ ...reference(), metadataRevision: 2 })
    expect(await finder.run(request)).toMatchObject({ issue: 'reference-changed' })
    expect(await finder.run({ ...request, expectedMetadataRevision: 2 })).toMatchObject({
      state: 'ready',
      metadataRevision: 2
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('does not serve cached pages to deleted roots or cancelled callers', async () => {
    const { finder, catalog, fetcher } = fixture()
    await finder.run(request)
    const controller = new AbortController()
    controller.abort()
    await expect(finder.run(request, controller.signal)).rejects.toThrow()
    catalog.get.mockResolvedValue({ ...reference(), deletedAt: Date.now() })
    expect(await finder.run(request)).toMatchObject({ issue: 'reference-changed', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('bounds cached pages without preventing older pages from being loaded again', async () => {
    const { finder, fetcher } = fixture()
    const root = await finder.run(request)
    for (let offset = 20; offset <= 200; offset += 20)
      await finder.run({ ...request, resolutionToken: root.resolutionToken, offset })
    expect(fetcher).toHaveBeenCalledTimes(12)
    await finder.run({ ...request, resolutionToken: root.resolutionToken, offset: 200 })
    expect(fetcher).toHaveBeenCalledTimes(12)
    await finder.run(request)
    expect(fetcher).toHaveBeenCalledTimes(13)
  })

  it('refreshes explicitly, retains the old cache on failure and keeps acquisition times stable', async () => {
    const { finder, fetcher, advance } = fixture()
    const old = await finder.run(request)
    advance(60_000)
    expect(await finder.run(request)).toEqual(old)
    expect(old.records[0].retrievedAt).toBe(old.retrievedAt)
    fetcher.mockImplementationOnce(async () => {
      advance(1001)
      return new Response('', { status: 503 })
    })
    expect(await finder.run({ ...request, refresh: true })).toMatchObject({ state: 'unavailable' })
    expect(await finder.run(request)).toEqual(old)
    const fresh = await finder.run({ ...request, refresh: true })
    expect(fresh.state).toBe('ready')
    expect(fresh.retrievedAt).toBeGreaterThan(old.retrievedAt!)
    expect(fresh.resolutionToken).not.toBe(old.resolutionToken)
    expect(await finder.run(request)).toEqual(fresh)
    expect(await finder.run({ ...request, resolutionToken: old.resolutionToken })).toEqual(old)
  })

  it('allows old cached pages but requires restarting stale live offset pagination', async () => {
    const { finder, advance, fetcher } = fixture()
    const first = await finder.run(request)
    const second = await finder.run({
      ...request,
      resolutionToken: first.resolutionToken,
      offset: 20
    })
    advance(15 * 60_000)
    expect(
      await finder.run({ ...request, resolutionToken: first.resolutionToken, offset: 20 })
    ).toEqual(second)
    expect(
      await finder.run({ ...request, resolutionToken: first.resolutionToken, offset: 40 })
    ).toMatchObject({ issue: 'expired' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect((await finder.run(request)).resolutionToken).not.toBe(first.resolutionToken)
  })

  it('coalesces equivalent requests while cancellation remains local to each caller', async () => {
    const { finder, fetcher, advance } = fixture()
    let release!: (response: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const controller = new AbortController()
    const cancelled = finder.run(
      { ...request, requestId: '00000000-0000-4000-8000-000000000001' },
      controller.signal
    )
    const rejection = expect(cancelled).rejects.toThrow()
    const retained = finder.run({ ...request, requestId: '00000000-0000-4000-8000-000000000002' })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejection
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
    advance(1001)
    release(identity())
    expect(await retained).toMatchObject({ state: 'ready' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('cancels the shared transport when its final caller leaves', async () => {
    const { finder, fetcher } = fixture()
    fetcher.mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = finder.run(request, controller.signal)
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejection
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('evicts sessions by retained byte budget before the session-count bound', async () => {
    const { finder, catalog, fetcher, advance } = fixture()
    fetcher.mockImplementation(async (input) => {
      advance(1001)
      if (String(input).includes('/search?')) return identity()
      const response = await page(input, ['1', '2', '3']).json()
      for (const record of response.referenceList.reference) {
        record.title = 'x'.repeat(90_000)
        record.abstractText = 'y'.repeat(90_000)
      }
      return json(response)
    })
    const first = await finder.run(request)
    for (let index = 0; index < 40; index++) {
      catalog.get.mockResolvedValue({ ...reference(), id: `budget-${index}` })
      expect(await finder.run({ ...request, itemId: `budget-${index}` })).toMatchObject({
        state: 'ready'
      })
    }
    catalog.get.mockResolvedValue(reference())
    expect(await finder.run({ ...request, resolutionToken: first.resolutionToken })).toMatchObject({
      issue: 'expired'
    })
  })

  it('rejects unknown graph inputs before any catalog or transport access', async () => {
    const { finder, catalog, fetcher } = fixture()
    expect(
      literatureRelatedRequestSchema.safeParse({ ...request, provider: 'unknown-source' }).success
    ).toBe(false)
    for (const seedPaperId of ['a'.repeat(40), 'A'.repeat(40)]) {
      expect(literatureRelatedPaperIdSchema.safeParse(seedPaperId).success).toBe(false)
      await expect(finder.run({ ...request, seedPaperId })).rejects.toThrow()
    }
    await expect(finder.run({ ...request, provider: 'unknown-source' } as never)).rejects.toThrow()
    expect(catalog.get).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const result = { ...request, state: 'ready', records: [], metadataRevision: 1 }
    delete (result as { expectedMetadataRevision?: number }).expectedMetadataRevision
    delete (result as { offset?: number }).offset
    expect(literatureRelatedResultSchema.safeParse(result).success).toBe(true)
    for (const obsolete of [
      { provider: 'unknown-source' },
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
        { ...request, direction: 'citations', resolutionToken: root.resolutionToken },
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

  it('expires a token after twenty-four hours without restarting root resolution', async () => {
    const { finder, advance, fetcher } = fixture()
    const root = await finder.run(request)
    advance(24 * 60 * 60_000)
    expect(await finder.run({ ...request, resolutionToken: root.resolutionToken })).toMatchObject({
      issue: 'expired'
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('bounds the number of retained sessions without invalidating the latest session', async () => {
    const { finder, catalog, fetcher } = fixture()
    const first = await finder.run(request)
    let last = first
    for (let index = 0; index < 200; index++) {
      catalog.get.mockResolvedValue({ ...reference(), id: `root-${index}` })
      last = await finder.run({ ...request, itemId: `root-${index}` })
    }
    catalog.get.mockResolvedValue(reference())
    expect(await finder.run({ ...request, resolutionToken: first.resolutionToken })).toMatchObject({
      issue: 'expired'
    })
    catalog.get.mockResolvedValue({ ...reference(), id: last.itemId })
    expect(
      await finder.run({ ...request, itemId: last.itemId, resolutionToken: last.resolutionToken })
    ).toMatchObject({ state: 'ready' })
    expect(fetcher).toHaveBeenCalledTimes(402)
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
