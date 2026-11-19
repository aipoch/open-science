import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { discoveryReferenceSchema, type DiscoveryReference } from '../src/contracts.js'
import { LiteratureRelatedFinder } from '../src/related.js'
import {
  literatureRelatedRequestSchema,
  literatureRelatedResultSchema
} from '../src/related-contracts.js'

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
const paper = {
  source: 'MED',
  id: '10647931',
  title: 'Seed',
  doi: '10.1234/seed',
  authorString: 'Hanahan D, Weinberg RA.'
}
const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
const identity = (rows: unknown[] = [paper]): Response =>
  json({ hitCount: rows.length, resultList: { result: rows } })
const page = (
  rows: unknown[] = [],
  {
    offset = 0,
    direction = 'references',
    count = rows.length,
    id = paper.id,
    source = paper.source
  } = {}
): Response =>
  json({
    hitCount: count,
    request: {
      id,
      source,
      pageSize: 20,
      offSet: offset / 20 + (direction === 'references' ? 1 : 0)
    },
    [direction === 'references' ? 'referenceList' : 'citationList']: {
      [direction === 'references' ? 'reference' : 'citation']: rows
    }
  })
function fixture(
  responses: Response[],
  item = reference()
): {
  finder: LiteratureRelatedFinder
  fetcher: Mock<typeof fetch>
  catalog: {
    get: Mock<() => Promise<DiscoveryReference>>
    sources: Mock<() => Promise<{ provider: string; externalId?: string }[]>>
  }
} {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    now += 1001
    return responses.shift()!
  })
  const catalog = {
    get: vi.fn(async () => item),
    sources: vi.fn<() => Promise<{ provider: string; externalId?: string }[]>>(async () => [])
  }
  return {
    finder: new LiteratureRelatedFinder({ fetch: fetcher, catalog }),
    fetcher,
    catalog
  }
}

describe('Europe PMC first, source-pinned citation discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reopens a saved preprint using its exact source and external ID', async () => {
    const preprint = { source: 'PPR', id: 'PPR1317127', title: 'Preprint' }
    const { finder, catalog, fetcher } = fixture(
      [identity([preprint]), page([], preprint)],
      reference([])
    )
    catalog.sources.mockResolvedValue([
      { provider: 'europe-pmc', externalId: 'europe-pmc:PPR:PPR1317127' }
    ])
    expect(await finder.run(request)).toMatchObject({
      state: 'ready',
      seed: { paperId: 'europe-pmc:PPR:PPR1317127' }
    })
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('query')).toBe(
      'EXT_ID:"PPR1317127" AND SRC:PPR'
    )
  })

  it('rejects a different preprint returned by the exact source search', async () => {
    const { finder, catalog } = fixture(
      [identity([{ source: 'PPR', id: 'PPR99', title: 'Other' }])],
      reference([])
    )
    catalog.sources.mockResolvedValue([
      { provider: 'europe-pmc', externalId: 'europe-pmc:PPR:PPR1317127' }
    ])
    expect(await finder.run(request)).toMatchObject({ state: 'unavailable', issue: 'no-match' })
  })

  const nativeIdentityCases = [
    {
      source: 'MED',
      id: '111',
      scheme: 'pmid',
      conflicting: '222',
      equivalent: ' PMID:111 ',
      other: { pmcid: 'PMC999' }
    },
    {
      source: 'PMC',
      id: 'PMC111',
      scheme: 'pmcid',
      conflicting: 'PMC222',
      equivalent: ' pmcid:pmc111 ',
      other: { pmid: '999' }
    }
  ] as const

  it.each(nativeIdentityCases)(
    'rejects a $source root whose native ID contradicts its explicit identifier',
    async ({ source, id, scheme, conflicting }) => {
      const { finder, fetcher } = fixture(
        [identity([{ ...paper, source, id, [scheme]: conflicting }]), page([], { source, id })],
        reference([{ scheme, value: conflicting }])
      )
      const result = await finder.run(request)
      expect(result).toMatchObject({ state: 'unavailable', issue: 'no-match', records: [] })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it.each(
    nativeIdentityCases.flatMap((entry) =>
      (['references', 'citations'] as const).map((direction) => ({ ...entry, direction }))
    )
  )(
    'omits contradictory $source native identities from $direction without granting exploration',
    async ({ source, id, scheme, conflicting, direction }) => {
      const { finder, fetcher } = fixture([
        identity(),
        page([{ ...paper, source, id, [scheme]: conflicting }], { direction })
      ])
      const result = await finder.run({ ...request, direction })
      expect(result).toMatchObject({ state: 'ready', records: [], omitted: 1 })
      expect(result.resolutionToken).toBeDefined()
      expect(
        await finder.run({
          ...request,
          direction,
          resolutionToken: result.resolutionToken,
          seedPaperId: `europe-pmc:${source}:${id}`
        })
      ).toMatchObject({ issue: 'expired', records: [] })
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it.each(
    nativeIdentityCases.flatMap((entry) =>
      (['references', 'citations'] as const).map((direction) => ({ ...entry, direction }))
    )
  )(
    'keeps normalized $source native identities and independent cross-library aliases in $direction',
    async ({ source, id, scheme, equivalent, other, direction }) => {
      const { finder } = fixture([
        identity(),
        page([{ ...paper, source, id, [scheme]: equivalent, ...other }], { direction })
      ])
      expect(await finder.run({ ...request, direction })).toMatchObject({
        state: 'ready',
        records: [
          {
            paperId: `europe-pmc:${source}:${id}`,
            item: {
              identifiers: expect.arrayContaining([expect.objectContaining({ scheme, value: id })])
            }
          }
        ]
      })
    }
  )

  it.each([
    {
      direction: 'references',
      source: 'MED',
      id: '111',
      scheme: 'doi',
      left: '10.1234/a',
      right: '10.1234/b'
    },
    {
      direction: 'citations',
      source: 'PMC',
      id: 'PMC111',
      scheme: 'pmid',
      left: '201',
      right: '202'
    },
    {
      direction: 'citations',
      source: 'MED',
      id: '111',
      scheme: 'pmcid',
      left: 'PMC201',
      right: 'PMC202'
    }
  ] as const)(
    'omits the whole $source group with conflicting $scheme claims from $direction',
    async ({ direction, source, id, scheme, left, right }) => {
      const child = { source, id, title: 'Duplicate record' }
      const neighbor = { source: 'MED', id: '222', title: 'Neighbor', doi: '10.1234/Article' }
      const { finder, fetcher } = fixture([
        identity(),
        page(
          [
            { ...child, [scheme]: left },
            neighbor,
            child,
            { ...child, [scheme]: right },
            { ...neighbor, title: 'Revised title', doi: 'https://doi.org/10.1234/article' },
            { ...child, [scheme]: left }
          ],
          { direction, count: 25 }
        )
      ])
      const result = await finder.run({ ...request, direction })
      expect(result).toMatchObject({
        state: 'ready',
        omitted: 4,
        nextOffset: 20,
        records: [{ paperId: 'europe-pmc:MED:222', item: { title: 'Revised title' } }]
      })
      expect(
        await finder.run({
          ...request,
          direction,
          resolutionToken: result.resolutionToken,
          seedPaperId: `europe-pmc:${source}:${id}`
        })
      ).toMatchObject({ issue: 'expired', records: [] })
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it('prefers exact Europe PMC identities, preserves native IDs, metadata and omitted entries', async () => {
    const child = {
      source: 'MED',
      id: '9647866',
      title: 'Child',
      pubYear: 1998,
      authorString: 'Aplin AE, Howe A.',
      journalAbbreviation: 'Pharmacol Rev'
    }
    const preprint = { source: 'PPR', id: 'PPR1317127', title: 'Preprint' }
    const { finder, fetcher } = fixture([
      identity(),
      page([child, { title: 'Unmatched reference', match: 'N' }, preprint], { count: 102 })
    ])
    const result = await finder.run(request)
    expect(result).toMatchObject({
      state: 'ready',
      provider: 'europe-pmc',
      omitted: 1,
      nextOffset: 20,
      seed: { paperId: 'europe-pmc:MED:10647931' },
      records: [
        {
          paperId: 'europe-pmc:MED:9647866',
          item: {
            issuedYear: 1998,
            containerTitle: 'Pharmacol Rev',
            url: 'https://europepmc.org/article/MED/9647866',
            identifiers: [{ scheme: 'pmid', value: '9647866' }],
            creators: [{ literalName: 'Aplin AE, Howe A.', nameMode: 'organization' }]
          }
        },
        { paperId: 'europe-pmc:PPR:PPR1317127', item: { itemType: 'preprint' } }
      ]
    })
    for (const [url, options] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://www.ebi.ac.uk')
      expect(options).toMatchObject({
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json' }
      })
      expect(options?.headers).not.toHaveProperty('x-api-key')
    }
  })

  it('uses one-based page parameters for both directions with their distinct response offsets', async () => {
    const { finder, fetcher } = fixture([
      identity(),
      page([{ ...paper, id: '1' }], { count: 42 }),
      page([{ ...paper, id: '2' }], { offset: 20, count: 42 }),
      page([{ ...paper, id: '3' }], { direction: 'citations', count: 30 }),
      page([{ ...paper, id: '4' }], { direction: 'citations', offset: 20, count: 30 })
    ])
    const root = await finder.run(request)
    expect(
      await finder.run({ ...request, resolutionToken: root.resolutionToken, offset: 20 })
    ).toMatchObject({ nextOffset: 40, records: [{ paperId: 'europe-pmc:MED:2' }] })
    expect(
      await finder.run({
        ...request,
        resolutionToken: root.resolutionToken,
        direction: 'citations'
      })
    ).toMatchObject({ nextOffset: 20 })
    expect(
      await finder.run({
        ...request,
        resolutionToken: root.resolutionToken,
        direction: 'citations',
        offset: 20
      })
    ).not.toHaveProperty('nextOffset')
    expect(
      fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('page'))
    ).toEqual(['1', '2', '1', '2'])
  })

  it.each(
    (['no-match', 'wrong-doi', 'first-direction-fails'] as const).flatMap((failure) =>
      ([undefined, 'auto'] as const).map((provider) => ({ failure, provider }))
    )
  )(
    'keeps default/legacy auto on Europe PMC after $failure (provider=$provider)',
    async ({ failure, provider }) => {
      const responses =
        failure === 'no-match'
          ? [identity([])]
          : failure === 'wrong-doi'
            ? [identity([{ ...paper, doi: '10.1234/wrong' }])]
            : [identity(), new Response('', { status: 503 })]
      const { finder, fetcher } = fixture(responses)
      const result = await finder.run({ ...request, provider })
      expect(result).toMatchObject({
        state: 'unavailable',
        provider: 'europe-pmc',
        issue: failure === 'first-direction-fails' ? 'unavailable' : 'no-match'
      })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(failure === 'first-direction-fails' ? 2 : 1)
      expect(fetcher.mock.calls.every(([url]) => String(url).includes('www.ebi.ac.uk'))).toBe(true)
    }
  )

  it('does not treat an empty source page as a failure or mix sources after pinning', async () => {
    const { finder, fetcher } = fixture([identity(), page(), new Response('', { status: 503 })])
    const root = await finder.run(request)
    expect(root).toMatchObject({ state: 'ready', provider: 'europe-pmc', records: [] })
    expect(
      await finder.run({
        ...request,
        resolutionToken: root.resolutionToken,
        direction: 'citations'
      })
    ).toMatchObject({ provider: 'europe-pmc', issue: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('www.ebi.ac.uk'))).toBe(true)
  })

  it('pins exploration tokens and refuses unknown or cross-provider seed identities', async () => {
    const { finder, fetcher } = fixture([
      identity(),
      page([{ ...paper, id: '9' }]),
      page([], { id: '9' }),
      new Response('', { status: 503 })
    ])
    const root = await finder.run(request)
    const neighbor = await finder.run({
      ...request,
      resolutionToken: root.resolutionToken,
      seedPaperId: 'europe-pmc:MED:9'
    })
    expect(neighbor).toMatchObject({
      provider: 'europe-pmc',
      seed: { paperId: 'europe-pmc:MED:9' }
    })
    expect(neighbor.resolutionToken).not.toBe(root.resolutionToken)
    expect(
      await finder.run({
        ...request,
        resolutionToken: neighbor.resolutionToken,
        direction: 'citations'
      })
    ).toMatchObject({ issue: 'unavailable', provider: 'europe-pmc' })
    for (const change of [
      { seedPaperId: 'opencitations:br/9' },
      { provider: 'opencitations' as const }
    ])
      expect(
        await finder.run({ ...request, resolutionToken: root.resolutionToken, ...change })
      ).toMatchObject({ issue: 'expired' })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it.each(['pmid', 'pmcid'] as const)(
    'resolves exact %s without a DOI and keeps identifiers for review',
    async (scheme) => {
      const native =
        scheme === 'pmid'
          ? paper
          : { ...paper, source: 'PMC', id: 'PMC123', pmcid: 'PMC123', doi: undefined }
      const value = scheme === 'pmid' ? paper.id : 'PMC123'
      const { finder, fetcher } = fixture(
        [identity([native]), page([], { source: native.source, id: native.id })],
        reference([{ scheme, value }])
      )
      expect(await finder.run(request)).toMatchObject({
        state: 'ready',
        provider: 'europe-pmc',
        seed: {
          item: {
            identifiers: expect.arrayContaining([expect.objectContaining({ scheme, value })])
          }
        }
      })
      expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('query')).toContain(
        scheme === 'pmid' ? 'EXT_ID:' : 'PMCID:'
      )
    }
  )

  it('normalizes exact DOI matching and prefers MED over PMC for the same DOI', async () => {
    const { finder } = fixture(
      [identity([{ ...paper, source: 'PMC', id: 'PMC123' }, paper]), page()],
      reference([{ scheme: 'doi', value: 'https://doi.org/10.1234/SEED' }])
    )
    expect(await finder.run(request)).toMatchObject({
      state: 'ready',
      seed: { paperId: 'europe-pmc:MED:10647931' }
    })
  })

  it('refuses an exact DOI match with a contradictory saved PMID', async () => {
    const { finder, fetcher } = fixture(
      [identity()],
      reference([
        { scheme: 'doi', value: '10.1234/seed' },
        { scheme: 'pmid', value: '123' }
      ])
    )
    expect(await finder.run({ ...request, provider: 'europe-pmc' })).toMatchObject({
      provider: 'europe-pmc',
      state: 'unavailable',
      issue: 'no-match'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not guess between distinct exact same-source identities or fabricate IDs', async () => {
    const { finder } = fixture([identity([paper, { ...paper, id: '2' }])])
    expect(await finder.run({ ...request, provider: 'europe-pmc' })).toMatchObject({
      issue: 'no-match'
    })
    for (const paperId of [
      'europe-pmc:MED:../x',
      'europe-pmc:PMC:123',
      'europe-pmc:med:123',
      'europe-pmc:MED:abc'
    ])
      expect(
        literatureRelatedRequestSchema.safeParse({ ...request, seedPaperId: paperId }).success
      ).toBe(false)
    expect(
      literatureRelatedResultSchema.safeParse({
        itemId: 'local',
        metadataRevision: 1,
        direction: 'references',
        state: 'ready',
        records: []
      }).success
    ).toBe(true)
  })

  it.each(['changed', 'cancelled'] as const)(
    'never falls back or publishes a token after root %s',
    async (failure) => {
      const { finder, catalog, fetcher } = fixture([identity(), page()])
      const controller = new AbortController()
      catalog.get
        .mockImplementationOnce(async () => reference())
        .mockImplementation(async () => {
          if (failure === 'cancelled') controller.abort()
          return { ...reference(), metadataRevision: failure === 'changed' ? 2 : 1 }
        })
      const pending = finder.run(request, controller.signal)
      if (failure === 'cancelled') await expect(pending).rejects.toThrow()
      else
        expect(await pending).toMatchObject({
          issue: 'reference-changed'
        })
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it('cancels an in-flight transport that ignores abort without starting fallback', async () => {
    const controller = new AbortController()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Promise<Response>(() => {}))
    const finder = new LiteratureRelatedFinder({
      catalog: { get: async () => reference(), sources: async () => [] },
      fetch: fetcher
    })
    const pending = finder.run(request, controller.signal)
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejection
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['oversized', 'malformed', 'wrong-page'] as const)(
    'rejects %s Europe PMC payloads without turning them into empty pages',
    async (failure) => {
      const bad =
        failure === 'oversized'
          ? new Response('x'.repeat(2 * 1024 * 1024 + 1))
          : failure === 'malformed'
            ? json({ hitCount: 1 })
            : page([paper], { offset: 20 })
      const { finder } = fixture([identity(), bad])
      expect(await finder.run({ ...request, provider: 'europe-pmc' })).toMatchObject({
        state: 'unavailable',
        provider: 'europe-pmc',
        issue: failure === 'oversized' ? 'source-limit' : 'response-invalid'
      })
    }
  )

  it.each(['references', 'citations'] as const)(
    'validates the raw %s row count against the remaining hits before deduplication',
    async (direction) => {
      const child = { ...paper, id: '123' }
      const { finder } = fixture([
        identity(),
        page([child], { direction, count: 0 }),
        identity(),
        page([child], { direction, count: 21 }),
        page([child, child], { direction, offset: 20, count: 21 }),
        page([child], { direction, offset: 20, count: 21 })
      ])
      const first = { ...request, direction }
      expect(await finder.run(first)).toMatchObject({ issue: 'response-invalid', records: [] })
      const valid = await finder.run(first)
      expect(valid).toMatchObject({ state: 'ready', nextOffset: 20 })
      const last = { ...first, resolutionToken: valid.resolutionToken, offset: 20 }
      expect(await finder.run(last)).toMatchObject({ issue: 'response-invalid', records: [] })
      expect(await finder.run(last)).toMatchObject({
        state: 'ready',
        records: [{ paperId: 'europe-pmc:MED:123' }]
      })
    }
  )

  it('honors Europe PMC Retry-After without retrying pinned requests', async () => {
    const { finder, fetcher } = fixture([
      identity(),
      page(),
      new Response('', { status: 429, headers: { 'retry-after': '999999' } })
    ])
    const root = await finder.run(request)
    const limited = await finder.run({
      ...request,
      resolutionToken: root.resolutionToken,
      direction: 'citations'
    })
    expect(limited).toMatchObject({ provider: 'europe-pmc', issue: 'rate-limited' })
    expect(limited.retryAt! - Date.now()).toBeLessThanOrEqual(300_000)
    expect(
      await finder.run({
        ...request,
        direction: 'citations',
        resolutionToken: root.resolutionToken
      })
    ).toMatchObject({ retryAt: limited.retryAt })
    expect(await finder.run(request)).toMatchObject({ state: 'ready', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('enforces one overall deadline even when injected transports ignore abort', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    const catalog = { get: async () => reference(), sources: async () => [] }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Promise<Response>(() => {}))
    const finder = new LiteratureRelatedFinder({ catalog, fetch: fetcher })
    const pending = finder.run(request)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(25_001)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({
      state: 'unavailable',
      provider: 'europe-pmc',
      issue: 'timeout'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
