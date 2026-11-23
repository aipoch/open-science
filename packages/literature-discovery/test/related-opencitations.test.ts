import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { discoveryReferenceSchema, type DiscoveryReference } from '../src/contracts.js'
import { literatureRelatedRequestSchema } from '../src/related-contracts.js'
import { LiteratureRelatedFinder, type LiteratureRelatedDiagnostic } from '../src/related.js'

const doi = '10.1234/seed'
const rootFilter = `identifiers.scheme:doi,identifiers.id:${doi}`
const request = {
  itemId: 'local',
  expectedMetadataRevision: 1,
  direction: 'references' as const,
  provider: 'opencitations' as const,
  offset: 0
}
const sourceId = (id: string): string => `https://w3id.org/oc/meta/br/${id}`
const root = {
  local_identifier: sourceId('061234'),
  titles: { none: ['Real title'] },
  identifiers: [{ scheme: 'doi', value: doi }],
  related_products: { cites: [sourceId('9')] },
  contributions: [
    { role: 'author', by: { entity_type: 'person', given_name: 'Ada', family_name: 'Lovelace' } }
  ],
  manifestations: [
    {
      type: { class: 'http://purl.org/spar/fabio/JournalArticle' },
      dates: { publication: ['2024-02-03T00:00:00'] },
      biblio: { in: { name: 'Journal' } }
    }
  ]
}
const reference = (identifiers: unknown[] = [{ scheme: 'doi', value: doi }]): DiscoveryReference =>
  discoveryReferenceSchema.parse({
    id: 'local',
    metadataRevision: 1,
    attachments: [],
    item: { itemType: 'journalArticle', title: 'Saved title', identifiers }
  })
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status })
const pageUrl = (filter: string, offset = 0): string =>
  `https://api.opencitations.net/skg-if/v1/products?${new URLSearchParams({ filter, page: String(offset / 20 + 1), page_size: '20' })}`
type SearchBody = {
  meta: {
    local_identifier: string
    part_of: { total_items: number }
    next_page?: { local_identifier: string }
  }
  '@graph': unknown[]
}
const search = (
  rows: unknown[],
  filter = rootFilter,
  offset = 0,
  total = rows.length
): SearchBody => ({
  meta: {
    local_identifier: pageUrl(filter, offset),
    part_of: { total_items: total },
    ...(offset + 20 < total
      ? { next_page: { local_identifier: pageUrl(filter, offset + 20) } }
      : {})
  },
  '@graph': rows
})
const identity = (rows: unknown[] = [root], filter = rootFilter): Response =>
  json(search(rows, filter))
const metadata = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `omid:br/${id}`,
  title: `Paper ${id}`,
  ...extra
})
const citing = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  local_identifier: sourceId(id),
  titles: { none: [`Citing ${id}`] },
  ...extra
})
const citationPage = (
  rows: unknown[] = [],
  offset = 0,
  total = rows.length,
  target = doi
): Response => json(search(rows, `cf.cites_doi:${target}`, offset, total))
function fixture(
  responses: (Response | Error)[],
  item = reference(),
  onDiagnostic?: (diagnostic: LiteratureRelatedDiagnostic) => void
): {
  finder: LiteratureRelatedFinder
  fetcher: Mock<typeof fetch>
  catalog: {
    get: Mock<(id: string) => Promise<DiscoveryReference>>
    sources: Mock<() => Promise<{ provider: string; externalId?: string }[]>>
  }
} {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    now += 1001
    const response = responses.shift()
    if (!response) throw new Error('Unexpected source request')
    if (response instanceof Error) throw response
    return response
  })
  const catalog = {
    get: vi.fn<(id: string) => Promise<DiscoveryReference>>(async () => item),
    sources: vi.fn<() => Promise<{ provider: string; externalId?: string }[]>>(async () => [])
  }
  return {
    finder: new LiteratureRelatedFinder({ fetch: fetcher, catalog, onDiagnostic }),
    fetcher,
    catalog
  }
}

describe('manual OpenCitations discovery with stable SKG-IF reference snapshots', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reopens a saved product without a DOI and follows its verified references', async () => {
    const product = { ...root, identifiers: [] }
    const path = `https://api.opencitations.net/skg-if/v1/products/${root.local_identifier}`
    const { finder, catalog, fetcher } = fixture(
      [json({ meta: { local_identifier: path }, '@graph': [product] }), json([metadata('9')])],
      reference([])
    )
    catalog.sources.mockResolvedValue([
      { provider: 'opencitations', externalId: 'opencitations:br/061234' }
    ])
    expect(await finder.run(request)).toMatchObject({
      state: 'ready',
      seed: { paperId: 'opencitations:br/061234' },
      records: [{ paperId: 'opencitations:br/9' }]
    })
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(new URL(path).pathname)
  })

  it('rejects ambiguous saved OMIDs without contacting the provider', async () => {
    const { finder, catalog, fetcher } = fixture([], reference([]))
    catalog.sources.mockResolvedValue(
      ['1', '2'].map((id) => ({ provider: 'opencitations', externalId: `opencitations:br/${id}` }))
    )
    expect(await finder.run(request)).toMatchObject({ state: 'unavailable', issue: 'no-match' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses exact lowercase DOI identity and Meta references on the fixed origin', async () => {
    const child = metadata('9', {
      id: 'doi:10.1234/CHILD pmid:123 omid:br/9',
      author: 'Smith, A [orcid:0000-0001-2345-6789 omid:ra/1]; Research Group [omid:ra/2]',
      pub_date: '2007-09-11',
      venue: 'Real Journal [issn:1234-5678 omid:br/5]',
      type: 'journal article',
      volume: '4',
      issue: '2',
      page: '1-8'
    })
    const { finder, fetcher } = fixture(
      [identity(), json([child])],
      reference([{ scheme: 'doi', value: 'https://doi.org/10.1234/SEED' }])
    )
    expect(await finder.run(request)).toMatchObject({
      state: 'ready',
      provider: 'opencitations',
      seed: {
        paperId: 'opencitations:br/061234',
        item: {
          title: 'Real title',
          issuedText: '2024-02-03',
          creators: [{ nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace' }]
        }
      },
      records: [
        {
          paperId: 'opencitations:br/9',
          item: {
            itemType: 'journalArticle',
            title: 'Paper 9',
            issuedText: '2007-09-11',
            issuedYear: 2007,
            containerTitle: 'Real Journal',
            url: sourceId('9'),
            typeFields: { volume: '4', issue: '2', pages: '1-8' },
            creators: [
              { nameMode: 'organization', literalName: 'Smith, A' },
              { nameMode: 'organization', literalName: 'Research Group' }
            ],
            identifiers: expect.arrayContaining([
              { scheme: 'doi', value: '10.1234/CHILD', isPrimary: false }
            ])
          }
        }
      ]
    })
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('filter')).toBe(rootFilter)
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe('/meta/v1/metadata/omid:br/9')
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.opencitations.net')
      expect(init).toMatchObject({
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json' }
      })
      expect(init?.headers).not.toHaveProperty('x-api-key')
    }
  })

  it('unions every verified DOI alias, deduplicates and stably sorts native reference IDs', async () => {
    const alias = {
      ...root,
      local_identifier: sourceId('999'),
      related_products: { cites: [sourceId('8'), sourceId('9')] }
    }
    for (const rows of [
      [alias, root],
      [root, alias]
    ]) {
      const { finder, fetcher } = fixture([identity(rows), json([metadata('9'), metadata('8')])])
      expect(await finder.run(request)).toMatchObject({
        seed: { paperId: 'opencitations:br/061234' },
        records: [{ paperId: 'opencitations:br/8' }, { paperId: 'opencitations:br/9' }]
      })
      expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe(
        '/meta/v1/metadata/omid:br/8__omid:br/9'
      )
    }
  })

  it('pages the same complete snapshot across direction changes without rereading identity', async () => {
    const ids = Array.from({ length: 42 }, (_, index) => String(index + 1).padStart(3, '0'))
    const { finder, fetcher } = fixture([
      identity([{ ...root, related_products: { cites: ids.toReversed().map(sourceId) } }]),
      json(ids.slice(0, 20).map((id) => metadata(id))),
      json(ids.slice(20, 40).map((id) => metadata(id))),
      citationPage([citing('777')]),
      json(ids.slice(40).map((id) => metadata(id)))
    ])
    const first = await finder.run(request)
    expect(first).toMatchObject({ nextOffset: 20 })
    expect(first.records).toHaveLength(20)
    expect(
      await finder.run({ ...request, resolutionToken: first.resolutionToken, offset: 20 })
    ).toMatchObject({
      nextOffset: 40,
      records: expect.arrayContaining([
        expect.objectContaining({ paperId: 'opencitations:br/021', item: expect.any(Object) })
      ])
    })
    expect(
      await finder.run({
        ...request,
        resolutionToken: first.resolutionToken,
        direction: 'citations'
      })
    ).toMatchObject({ records: [{ paperId: 'opencitations:br/777' }] })
    const last = await finder.run({
      ...request,
      resolutionToken: first.resolutionToken,
      offset: 40
    })
    expect(last.records.map((record) => record.paperId)).toEqual([
      'opencitations:br/041',
      'opencitations:br/042'
    ])
    expect(last.nextOffset).toBeUndefined()
    expect(
      fetcher.mock.calls.filter(
        ([url]) => new URL(String(url)).searchParams.get('filter') === rootFilter
      )
    ).toHaveLength(1)
  })

  it('matches complete OMID tokens, ignores foreign rows and emits at most one record per requested ID', async () => {
    const { finder, fetcher } = fixture([
      identity([{ ...root, related_products: { cites: ['1', '2', '3', '4'].map(sourceId) } }]),
      json([
        metadata('1', { title: 'Z title' }),
        metadata('1', { id: 'omid:br/1 omid:br/999', title: 'A title' }),
        metadata('2', { title: '' }),
        metadata('30'),
        metadata('4-extra'),
        metadata('888')
      ])
    ])
    const result = await finder.run(request)
    expect(result).toMatchObject({
      records: [{ paperId: 'opencitations:br/1', item: { title: 'A title' } }],
      omitted: 3
    })
    expect(
      await finder.run({
        ...request,
        resolutionToken: result.resolutionToken,
        seedPaperId: 'opencitations:br/999'
      })
    ).toMatchObject({ issue: 'expired' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('replaces the private snapshot when exploring a DOI center and preserves original-root checks', async () => {
    const center = {
      ...root,
      local_identifier: sourceId('9'),
      identifiers: [{ scheme: 'doi', value: '10.1234/child' }],
      related_products: { cites: [sourceId('10')] }
    }
    const { finder, fetcher, catalog } = fixture([
      identity(),
      json([metadata('9', { id: 'omid:br/9 doi:10.1234/CHILD' })]),
      identity([center], 'identifiers.scheme:doi,identifiers.id:10.1234/child'),
      json([metadata('10')]),
      citationPage([], 0, 0, '10.1234/child')
    ])
    const first = await finder.run(request)
    const explored = await finder.run({
      ...request,
      resolutionToken: first.resolutionToken,
      seedPaperId: 'opencitations:br/9'
    })
    expect(explored).toMatchObject({
      state: 'ready',
      seed: { paperId: 'opencitations:br/9' },
      records: [{ paperId: 'opencitations:br/10' }]
    })
    expect(explored.resolutionToken).not.toBe(first.resolutionToken)
    expect(
      await finder.run({
        ...request,
        direction: 'citations',
        resolutionToken: explored.resolutionToken
      })
    ).toMatchObject({ state: 'ready' })
    expect(await finder.run({ ...request, resolutionToken: first.resolutionToken })).toMatchObject({
      records: [{ paperId: 'opencitations:br/9' }]
    })
    expect(catalog.get.mock.calls.every(([id]) => id === 'local')).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('does not cache a new center snapshot before the final original-root validation', async () => {
    const center = {
      ...root,
      local_identifier: sourceId('9'),
      identifiers: [{ scheme: 'doi', value: '10.1234/child' }],
      related_products: { cites: [sourceId('10')] }
    }
    const { finder, fetcher, catalog } = fixture([
      identity(),
      json([metadata('9', { id: 'omid:br/9 doi:10.1234/child' })]),
      citationPage([], 0, 0, '10.1234/child'),
      identity([center], 'identifiers.scheme:doi,identifiers.id:10.1234/child'),
      json([metadata('10')]),
      identity(
        [{ ...center, related_products: { cites: [sourceId('11')] } }],
        'identifiers.scheme:doi,identifiers.id:10.1234/child'
      ),
      json([metadata('11')])
    ])
    const first = await finder.run(request)
    const explored = await finder.run({
      ...request,
      direction: 'citations',
      resolutionToken: first.resolutionToken,
      seedPaperId: 'opencitations:br/9'
    })
    catalog.get
      .mockResolvedValueOnce(reference())
      .mockResolvedValueOnce({ ...reference(), metadataRevision: 2 })
    expect(
      await finder.run({ ...request, resolutionToken: explored.resolutionToken })
    ).toMatchObject({ issue: 'reference-changed' })
    expect(
      await finder.run({ ...request, resolutionToken: explored.resolutionToken })
    ).toMatchObject({ records: [{ paperId: 'opencitations:br/11' }] })
    expect(
      fetcher.mock.calls.filter(
        ([url]) =>
          new URL(String(url)).searchParams.get('filter') ===
          'identifiers.scheme:doi,identifiers.id:10.1234/child'
      )
    ).toHaveLength(2)
  })

  it('retains both directions capabilities when pages on one token complete concurrently', async () => {
    const { finder, fetcher } = fixture([identity(), citationPage([citing('8')], 0, 21)])
    const first = await finder.run({ ...request, direction: 'citations' })
    let instant = Date.now()
    vi.mocked(Date.now).mockImplementation(() => (instant += 1001))
    let completeReferences!: (value: Response) => void
    let completeCitations!: (value: Response) => void
    fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.startsWith('/meta/'))
        return new Promise((resolve) => {
          completeReferences = resolve
        })
      return new Promise((resolve) => {
        completeCitations = resolve
      })
    })
    const references = finder.run({ ...request, resolutionToken: first.resolutionToken })
    const citations = finder.run({
      ...request,
      direction: 'citations',
      offset: 20,
      resolutionToken: first.resolutionToken
    })
    await vi.waitFor(() => {
      expect(completeReferences).toBeDefined()
      expect(completeCitations).toBeDefined()
    })
    completeReferences(json([metadata('9')]))
    expect(await references).toMatchObject({ records: [{ paperId: 'opencitations:br/9' }] })
    completeCitations(citationPage([citing('7')], 20, 21))
    expect(await citations).toMatchObject({ records: [{ paperId: 'opencitations:br/7' }] })
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname
      const id = path.split('/').at(-1)!
      return json({
        meta: { local_identifier: `https://api.opencitations.net${path}` },
        '@graph': [{ local_identifier: sourceId(id), related_products: { cites: [] } }]
      })
    })
    for (const id of ['9', '7'])
      expect(
        await finder.run({
          ...request,
          resolutionToken: first.resolutionToken,
          seedPaperId: `opencitations:br/${id}`
        })
      ).toMatchObject({ state: 'ready', seed: { paperId: `opencitations:br/${id}` } })
  })

  it('uses a validated single-product identity for an observed center without a DOI', async () => {
    const path = '/skg-if/v1/products/https://w3id.org/oc/meta/br/9'
    const single = {
      meta: { local_identifier: `https://api.opencitations.net${path}` },
      '@graph': [{ local_identifier: sourceId('9'), related_products: { cites: [sourceId('10')] } }]
    }
    const { finder, fetcher } = fixture([
      identity(),
      json([metadata('9')]),
      json(single),
      json([metadata('10')])
    ])
    const first = await finder.run(request)
    expect(
      await finder.run({
        ...request,
        resolutionToken: first.resolutionToken,
        seedPaperId: 'opencitations:br/9'
      })
    ).toMatchObject({ records: [{ paperId: 'opencitations:br/10' }] })
    expect(new URL(String(fetcher.mock.calls[2][0])).pathname).toBe(path)
  })

  it.each(['wrong-id', 'wrong-origin'])(
    'rejects an invalid single-product response: %s',
    async (failure) => {
      const single = {
        meta: {
          local_identifier:
            failure === 'wrong-origin'
              ? 'https://attacker.invalid/product'
              : 'https://api.opencitations.net/skg-if/v1/products/https://w3id.org/oc/meta/br/9'
        },
        '@graph': [
          {
            local_identifier: sourceId(failure === 'wrong-id' ? '999' : '9'),
            related_products: { cites: [sourceId('10')] }
          }
        ]
      }
      const { finder, fetcher } = fixture([identity(), json([metadata('9')]), json(single)])
      const first = await finder.run(request)
      expect(
        await finder.run({
          ...request,
          resolutionToken: first.resolutionToken,
          seedPaperId: 'opencitations:br/9'
        })
      ).toMatchObject({ issue: 'response-invalid' })
      expect(fetcher).toHaveBeenCalledTimes(3)
    }
  )

  it.each(['no-doi', 'ambiguous-doi', 'wrong-doi', 'contradictory-pmid'])(
    'rejects an unsupported or contradictory root without a title guess: %s',
    async (failure) => {
      const identifiers =
        failure === 'no-doi'
          ? []
          : failure === 'ambiguous-doi'
            ? [
                { scheme: 'doi', value: doi },
                { scheme: 'doi', value: '10.1234/other' }
              ]
            : failure === 'contradictory-pmid'
              ? [
                  { scheme: 'doi', value: doi },
                  { scheme: 'pmid', value: '123' }
                ]
              : [{ scheme: 'doi', value: doi }]
      const paper =
        failure === 'wrong-doi'
          ? { ...root, identifiers: [{ scheme: 'doi', value: '10.1234/wrong' }] }
          : failure === 'contradictory-pmid'
            ? { ...root, identifiers: [...root.identifiers, { scheme: 'pmid', value: '999' }] }
            : root
      const { finder, fetcher } = fixture([identity([paper])], reference(identifiers))
      expect(await finder.run(request)).toMatchObject({
        provider: 'opencitations',
        issue: 'no-match'
      })
      expect(fetcher).toHaveBeenCalledTimes(['no-doi', 'ambiguous-doi'].includes(failure) ? 0 : 1)
    }
  )

  it.each([
    'too-many-aliases',
    'partial-alias',
    'wrong-alias-doi',
    'wrong-br-origin',
    'malformed-adjacency',
    'adjacency-limit'
  ])(
    'rejects incomplete or unsafe adjacency without publishing a snapshot: %s',
    async (failure) => {
      let body = search([root])
      if (failure === 'too-many-aliases') body = search([root], rootFilter, 0, 21)
      if (failure === 'partial-alias') body = search([root], rootFilter, 0, 2)
      if (failure === 'wrong-alias-doi')
        body = search([
          root,
          {
            ...root,
            local_identifier: sourceId('2'),
            identifiers: [{ scheme: 'doi', value: '10.1234/wrong' }]
          }
        ])
      if (failure === 'wrong-br-origin')
        body = search([{ ...root, related_products: { cites: ['https://attacker.invalid/br/9'] } }])
      if (failure === 'malformed-adjacency')
        body = search([{ ...root, related_products: { cites: 'not-an-array' } }])
      if (failure === 'adjacency-limit')
        body = search([
          {
            ...root,
            related_products: {
              cites: Array.from({ length: 2001 }, (_, index) => sourceId(String(index)))
            }
          }
        ])
      const { finder, fetcher } = fixture([json(body)])
      const result = await finder.run(request)
      expect(result).toMatchObject({
        issue: ['too-many-aliases', 'adjacency-limit'].includes(failure)
          ? 'source-limit'
          : 'response-invalid',
        records: []
      })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('observes an empty adjacency without requesting Meta or an unbounded Index list', async () => {
    const { finder, fetcher } = fixture([identity([{ ...root, related_products: { cites: [] } }])])
    expect(await finder.run(request)).toMatchObject({ state: 'ready', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['404', 'malformed', 'oversized'])(
    'does not treat a failed Meta batch as an empty successful page: %s',
    async (failure) => {
      const bad =
        failure === '404'
          ? json(search([]), 404)
          : failure === 'malformed'
            ? json({ rows: [] })
            : new Response('x'.repeat(2 * 1024 * 1024 + 1))
      const { finder, fetcher } = fixture([identity(), bad])
      const result = await finder.run(request)
      expect(result).toMatchObject({
        state: 'unavailable',
        issue:
          failure === '404'
            ? 'unavailable'
            : failure === 'oversized'
              ? 'source-limit'
              : 'response-invalid'
      })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it('retains SKG-IF empty-search 404 semantics only for identity and citation searches', async () => {
    const missing = fixture([json(search([]), 404)])
    expect(await missing.finder.run(request)).toMatchObject({ issue: 'no-match' })
    const emptyCitations = fixture([identity(), json(search([], `cf.cites_doi:${doi}`), 404)])
    expect(await emptyCitations.finder.run({ ...request, direction: 'citations' })).toMatchObject({
      state: 'ready',
      records: []
    })
  })

  it.each(['next-origin', 'next-filter', 'next-page', 'current-page', 'empty-nonzero'])(
    'keeps citation pagination validation intact: %s',
    async (failure) => {
      const body = search([citing('1')], `cf.cites_doi:${doi}`, 0, 30)
      if (failure === 'next-origin')
        body.meta.next_page!.local_identifier = 'https://attacker.invalid/page'
      if (failure === 'next-filter')
        body.meta.next_page!.local_identifier = pageUrl('cf.cites_doi:10.1234/other', 20)
      if (failure === 'next-page')
        body.meta.next_page!.local_identifier = pageUrl(`cf.cites_doi:${doi}`, 40)
      if (failure === 'current-page')
        body.meta.local_identifier = pageUrl(`cf.cites_doi:${doi}`, 20)
      if (failure === 'empty-nonzero') body['@graph'] = []
      const { finder, fetcher } = fixture([identity(), json(body)])
      expect(await finder.run({ ...request, direction: 'citations' })).toMatchObject({
        issue: 'response-invalid'
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it('retains citation pagination, real IDs and omission of missing titles', async () => {
    const { finder } = fixture([
      identity(),
      citationPage([citing('1'), citing('2', { titles: null })], 0, 21),
      citationPage([citing('3')], 20, 21)
    ])
    const first = await finder.run({ ...request, direction: 'citations' })
    expect(first).toMatchObject({
      omitted: 1,
      nextOffset: 20,
      records: [{ paperId: 'opencitations:br/1' }]
    })
    expect(
      await finder.run({
        ...request,
        direction: 'citations',
        offset: 20,
        resolutionToken: first.resolutionToken
      })
    ).toMatchObject({ records: [{ paperId: 'opencitations:br/3' }] })
  })

  it.each([
    ['2007-09-11T00:00:00', '2007-09-11'],
    ['2007-09-11T00:30:00+08:00', '2007-09-11'],
    ['2007-09-11T23:30:00Z', '2007-09-11'],
    ['2007-09', '2007-09'],
    ['2007', '2007']
  ])(
    'retains source publication precision without timezone conversion: %s',
    async (value, expected) => {
      const paper = {
        ...root,
        manifestations: [{ ...root.manifestations[0], dates: { publication: [value] } }]
      }
      const { finder } = fixture([identity([paper]), json([metadata('9')])])
      expect(await finder.run(request)).toMatchObject({
        seed: { item: { issuedText: expected, issuedYear: 2007 } }
      })
    }
  )

  it('refuses unknown/cross-provider capabilities and invalid page offsets without requests', async () => {
    const { finder, fetcher } = fixture([identity(), json([metadata('9')])])
    const first = await finder.run(request)
    for (const change of [
      { seedPaperId: 'opencitations:br/999' },
      { seedPaperId: 'europe-pmc:MED:9' },
      { provider: 'europe-pmc' as const }
    ])
      expect(
        await finder.run({ ...request, resolutionToken: first.resolutionToken, ...change })
      ).toMatchObject({ issue: 'expired' })
    expect(
      await finder.run({ ...request, resolutionToken: first.resolutionToken, offset: 1 })
    ).toMatchObject({ issue: 'response-invalid' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const paperId of [
      'opencitations:br/../9',
      'opencitations:br/9?x',
      'opencitations:ra/9',
      'opencitations:br/９',
      `opencitations:br/${'9'.repeat(31)}`
    ])
      expect(
        literatureRelatedRequestSchema.safeParse({ ...request, seedPaperId: paperId }).success
      ).toBe(false)
  })

  it('revalidates the original root after completing metadata before granting capabilities', async () => {
    const { finder, catalog } = fixture([identity(), json([metadata('9')])])
    catalog.get
      .mockResolvedValueOnce(reference())
      .mockResolvedValue({ ...reference(), metadataRevision: 2 })
    const result = await finder.run(request)
    expect(result).toMatchObject({ issue: 'reference-changed', records: [] })
    expect(result.resolutionToken).toBeUndefined()
  })

  it('keeps legacy automatic lookup limited to Europe PMC without contacting optional sources', async () => {
    const { finder, fetcher } = fixture([new Response('', { status: 503 })])
    expect(await finder.run({ ...request, provider: 'auto' })).toMatchObject({
      state: 'unavailable',
      provider: 'europe-pmc',
      issue: 'unavailable'
    })
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([
      'https://www.ebi.ac.uk'
    ])
  })

  it('applies the same provider cooldown to Meta', async () => {
    const { finder, fetcher } = fixture([
      identity(),
      new Response('', { status: 429, headers: { 'retry-after': '999999' } })
    ])
    const result = await finder.run(request)
    expect(result).toMatchObject({ issue: 'rate-limited', provider: 'opencitations' })
    expect(result.retryAt! - Date.now()).toBeLessThanOrEqual(300_000)
    expect(await finder.run(request)).toMatchObject({
      issue: 'rate-limited',
      retryAt: result.retryAt
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('propagates cancellation during an uncooperative metadata transport without publishing a token', async () => {
    const { finder, fetcher } = fixture([identity()])
    const controller = new AbortController()
    fetcher
      .mockImplementationOnce(async () => identity())
      .mockImplementation(async () => new Promise<Response>(() => {}))
    const pending = finder.run(request, controller.signal)
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 2000 })
    controller.abort()
    await rejection
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps one 30-second deadline across identity and metadata', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(identity())
      .mockImplementation(async () => new Promise<Response>(() => {}))
    const finder = new LiteratureRelatedFinder({
      catalog: { get: async () => reference(), sources: async () => [] },
      fetch: fetcher
    })
    const pending = finder.run(request)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 2000 })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await pending).toMatchObject({ issue: 'timeout', provider: 'opencitations' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([502, 503, 504])(
    'retries HTTP %s once within the same source and reports safe recovery',
    async (status) => {
      const diagnostics: LiteratureRelatedDiagnostic[] = []
      const { finder, fetcher, catalog } = fixture(
        [new Response('', { status }), identity(), json([metadata('9')])],
        reference(),
        (event) => diagnostics.push(event)
      )
      const result = await finder.run(request)
      expect(result).toMatchObject({ state: 'ready', provider: 'opencitations' })
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(catalog.get).toHaveBeenCalledTimes(3)
      expect(diagnostics).toMatchObject([
        {
          provider: 'opencitations',
          endpoint: 'identity',
          phase: 'http',
          status,
          attempt: 1,
          outcome: 'failed'
        },
        {
          provider: 'opencitations',
          endpoint: 'identity',
          phase: 'parse',
          status: 200,
          attempt: 2,
          outcome: 'recovered'
        }
      ])
    }
  )

  it('does not immediately retry HTTP 503 with a valid Retry-After hint', async () => {
    const { finder, fetcher } = fixture([
      new Response('', { status: 503, headers: { 'retry-after': '60' } }),
      identity()
    ])
    expect(await finder.run(request)).toMatchObject({ issue: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'EAI_AGAIN'])(
    'retries only a recognized nested transient transport code: %s',
    async (code) => {
      const diagnostics: LiteratureRelatedDiagnostic[] = []
      const error = new TypeError('https://private.invalid/secret?token=credential', {
        cause: Object.assign(new Error('private upstream message'), { code })
      })
      const { finder, fetcher } = fixture(
        [error, identity(), json([metadata('9')])],
        reference(),
        (event) => diagnostics.push(event)
      )
      expect(await finder.run(request)).toMatchObject({ state: 'ready' })
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(diagnostics[0]).toMatchObject({ phase: 'fetch', code, attempt: 1, outcome: 'failed' })
      expect(Object.keys(diagnostics[1]).sort()).toEqual([
        'attempt',
        'bytes',
        'elapsedMs',
        'endpoint',
        'outcome',
        'phase',
        'provider',
        'status'
      ])
      expect(JSON.stringify(diagnostics)).not.toMatch(
        /private|credential|token|https:|10\.1234|local|started/
      )
    }
  )

  it('recognizes an exact Chromium reset while leaving arbitrary messages non-retryable', async () => {
    const recovered = fixture([
      new Error('net::ERR_CONNECTION_RESET'),
      identity(),
      json([metadata('9')])
    ])
    expect(await recovered.finder.run(request)).toMatchObject({ state: 'ready' })
    const unknown = fixture([new Error('net::ERR_CONNECTION_RESET https://private.invalid')])
    expect(await unknown.finder.run(request)).toMatchObject({ issue: 'unavailable' })
    expect(unknown.fetcher).toHaveBeenCalledTimes(1)
  })

  it('spends only one retry across identity and metadata in an entire run', async () => {
    const { finder, fetcher } = fixture([
      new Response('', { status: 503 }),
      identity(),
      new Response('', { status: 503 }),
      json([metadata('9')])
    ])
    const result = await finder.run(request)
    expect(result).toMatchObject({ issue: 'unavailable', records: [] })
    expect(result.resolutionToken).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([429, 403])(
    'preserves authoritative HTTP %s when error-body cleanup rejects',
    async (status) => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error('Cleanup rejected')
        }
      })
      const { finder, fetcher } = fixture([
        new Response(body, { status, headers: { 'retry-after': '60' } })
      ])
      const result = await finder.run(request)
      expect(result).toMatchObject({ issue: status === 429 ? 'rate-limited' : 'authentication' })
      if (status === 429) {
        expect(result.retryAt).toBeGreaterThan(Date.now())
        expect(await finder.run(request)).toMatchObject({
          issue: 'rate-limited',
          retryAt: result.retryAt
        })
      }
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('preserves a response size failure when stream cleanup also rejects', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
      },
      cancel() {
        throw Object.assign(new Error('Cleanup socket error'), { code: 'ECONNRESET' })
      }
    })
    const { finder, fetcher } = fixture([new Response(body)])
    expect(await finder.run(request)).toMatchObject({ issue: 'source-limit' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retries a reset while reading a successful response body, with separate phase diagnostics', async () => {
    const diagnostics: LiteratureRelatedDiagnostic[] = []
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(
          Object.assign(new Error('private socket details'), { code: 'UND_ERR_SOCKET' })
        )
      }
    })
    const { finder, fetcher } = fixture(
      [new Response(body), identity(), json([metadata('9')])],
      reference(),
      (event) => diagnostics.push(event)
    )
    expect(await finder.run(request)).toMatchObject({ state: 'ready' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(diagnostics[0]).toMatchObject({ phase: 'body', status: 200, code: 'UND_ERR_SOCKET' })
  })

  it.each([
    'unknown-transport',
    'tls',
    'json',
    'schema',
    'authentication',
    'rate-limit',
    'http500'
  ])('does not retry deterministic, unsafe or unclassified failures: %s', async (failure) => {
    const failed =
      failure === 'unknown-transport'
        ? new TypeError('fetch failed')
        : failure === 'tls'
          ? new TypeError('fetch failed', {
              cause: Object.assign(new Error('untrusted certificate'), { code: 'CERT_HAS_EXPIRED' })
            })
          : failure === 'json'
            ? new Response('{')
            : failure === 'schema'
              ? json({ '@graph': [] })
              : new Response('', {
                  status: failure === 'authentication' ? 401 : failure === 'rate-limit' ? 429 : 500
                })
    const { finder, fetcher } = fixture([failed])
    expect(await finder.run(request)).toMatchObject({ state: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rechecks the original root before retrying and never publishes after it changes', async () => {
    const { finder, fetcher, catalog } = fixture([new Response('', { status: 503 }), identity()])
    catalog.get
      .mockResolvedValueOnce(reference())
      .mockResolvedValue({ ...reference(), metadataRevision: 2 })
    const result = await finder.run(request)
    expect(result).toMatchObject({ issue: 'reference-changed', records: [] })
    expect(result.resolutionToken).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not retry or diagnose a caller cancellation as a source timeout', async () => {
    const controller = new AbortController()
    const observer = vi.fn()
    const { finder, fetcher } = fixture([], reference(), observer)
    fetcher.mockImplementation(async () => {
      controller.abort()
      throw Object.assign(new Error('Reset after cancellation'), { code: 'ECONNRESET' })
    })
    await expect(finder.run(request, controller.signal)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(observer).not.toHaveBeenCalled()
  })

  it('revalidates the root after a retried metadata response before publishing capabilities', async () => {
    const { finder, catalog, fetcher } = fixture([
      identity(),
      new Response('', { status: 503 }),
      json([metadata('9')])
    ])
    catalog.get
      .mockResolvedValueOnce(reference())
      .mockResolvedValueOnce(reference())
      .mockResolvedValue({ ...reference(), metadataRevision: 2 })
    const result = await finder.run(request)
    expect(result).toMatchObject({ issue: 'reference-changed', records: [] })
    expect(result.resolutionToken).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('keeps the original signal and 30-second deadline during a retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementation(async () => new Promise<Response>(() => {}))
    const finder = new LiteratureRelatedFinder({
      catalog: { get: async () => reference(), sources: async () => [] },
      fetch: fetcher
    })
    const started = Date.now()
    const pending = finder.run(request)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2), { timeout: 2000 })
    expect(fetcher.mock.calls[1][1]?.signal).toBe(fetcher.mock.calls[0][1]?.signal)
    await vi.advanceTimersByTimeAsync(29_999 - (Date.now() - started))
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toMatchObject({ issue: 'timeout', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps observer errors isolated from successful recovery', async () => {
    const { finder } = fixture(
      [new Response('', { status: 503 }), identity(), json([metadata('9')])],
      reference(),
      () => {
        throw new Error('Observer failure')
      }
    )
    expect(await finder.run(request)).toMatchObject({ state: 'ready' })
  })

  it('diagnoses invalid relationship envelopes without retrying or leaking response contents', async () => {
    const observer = vi.fn()
    const { finder, fetcher } = fixture(
      [identity(), json({ secret: 'private metadata' })],
      reference(),
      observer
    )
    expect(await finder.run(request)).toMatchObject({ issue: 'response-invalid' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'metadata',
        phase: 'validation',
        issue: 'response-invalid',
        outcome: 'failed'
      })
    )
    expect(JSON.stringify(observer.mock.calls)).not.toContain('private metadata')
  })
})

describe('explicit OpenCitations Index sessions', () => {
  const indexRequest = { ...request, opencitationsMode: 'index' as const }
  const indexIdentity = (): Response =>
    json([metadata('061234', { id: `omid:br/061234 doi:${doi}` })])
  const edge = (
    id = '9',
    direction: 'references' | 'citations' = 'references'
  ): { oci: string; citing: string; cited: string } => ({
    oci: direction === 'references' ? `061234-${id}` : `${id}-061234`,
    citing: direction === 'references' ? `omid:br/061234 doi:${doi}` : `omid:br/${id}`,
    cited: direction === 'references' ? `omid:br/${id}` : `omid:br/061234 doi:${doi}`
  })

  it.each(
    (['references', 'citations'] as const).flatMap((direction) =>
      ['identity', 'edge'].map((stage) => ({ direction, stage }))
    )
  )(
    'accepts official multi-DOI aliases at the $stage target: $direction',
    async ({ direction, stage }) => {
      // Index v2 documents one native entity with multiple DOI identifiers.
      const row = edge('9', direction)
      row[direction === 'references' ? 'citing' : 'cited'] += ' doi:10.1234/alias'
      const { finder, fetcher } = fixture([
        stage === 'identity'
          ? json([metadata('061234', { id: `omid:br/061234 doi:${doi} doi:10.1234/alias` })])
          : indexIdentity(),
        json([row]),
        json([metadata('9')])
      ])
      const result = await finder.run({ ...indexRequest, direction })
      expect(result).toMatchObject({ state: 'ready', records: [{ paperId: 'opencitations:br/9' }] })
      expect(result.resolutionToken).toBeDefined()
      expect(String(fetcher.mock.calls[1][0])).toContain(
        stage === 'identity'
          ? `/index/v2/${direction}/omid:br/061234?`
          : `/index/v2/${direction}/doi:`
      )
    }
  )

  it('reopens a saved multi-DOI neighbor through its unique native provenance', async () => {
    const aliases = metadata('9', { id: 'omid:br/9 doi:10.1234/a doi:10.1234/b' })
    const { finder, catalog, fetcher } = fixture([
      indexIdentity(),
      json([{ ...edge(), cited: aliases.id }]),
      json([aliases]),
      json([aliases]),
      json([{ oci: '9-8', citing: aliases.id, cited: 'omid:br/8' }]),
      json([metadata('8')])
    ])
    const discovered = await finder.run(indexRequest)
    expect(discovered.state).toBe('ready')
    const neighbor = discovered.records[0]
    const saved = discoveryReferenceSchema.parse({
      ...reference(),
      id: 'saved-neighbor',
      item: neighbor.item
    })
    catalog.get.mockResolvedValue(saved)
    catalog.sources.mockResolvedValue([{ provider: 'opencitations', externalId: neighbor.paperId }])
    const reopened = await finder.run({ ...indexRequest, itemId: saved.id })
    expect(reopened).toMatchObject({
      state: 'ready',
      seed: { paperId: neighbor.paperId },
      records: [{ paperId: 'opencitations:br/8' }]
    })
    expect(fetcher.mock.calls.slice(3).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/meta/v1/metadata/omid:br/9',
      '/index/v2/references/omid:br/9',
      '/meta/v1/metadata/omid:br/8'
    ])
  })

  it.each(['missing-native', 'ambiguous-native', 'missing-alias', 'foreign-native'])(
    'does not guess a saved multi-DOI root when evidence is %s',
    async (failure) => {
      const { finder, catalog, fetcher } = fixture(
        [
          json([
            metadata(failure === 'foreign-native' ? '8' : '9', {
              id:
                failure === 'foreign-native'
                  ? 'omid:br/8 doi:10.1234/a doi:10.1234/b'
                  : 'omid:br/9 doi:10.1234/a'
            })
          ])
        ],
        reference([
          { scheme: 'doi', value: '10.1234/a' },
          { scheme: 'doi', value: '10.1234/b' }
        ])
      )
      catalog.sources.mockResolvedValue(
        failure === 'missing-native'
          ? []
          : [
              { provider: 'opencitations', externalId: 'opencitations:br/9' },
              ...(failure === 'ambiguous-native'
                ? [{ provider: 'opencitations', externalId: 'opencitations:br/8' }]
                : [])
            ]
      )
      expect(await finder.run(indexRequest)).toMatchObject({
        state: 'unavailable',
        issue: 'no-match',
        records: []
      })
      expect(fetcher).toHaveBeenCalledTimes(
        ['missing-native', 'ambiguous-native'].includes(failure) ? 0 : 1
      )
    }
  )
  afterEach(() => vi.restoreAllMocks())

  it('keeps reopened page caches separate for SKG-IF, Index and Europe PMC', async () => {
    const { finder, fetcher } = fixture([
      identity(),
      json([metadata('9')]),
      indexIdentity(),
      json([edge()]),
      json([metadata('9')]),
      json({ hitCount: 0, resultList: { result: [] } })
    ])
    const skg = await finder.run(request)
    const index = await finder.run(indexRequest)
    expect(skg.state).toBe('ready')
    expect(index.state).toBe('ready')
    expect(index.resolutionToken).not.toBe(skg.resolutionToken)
    expect(await finder.run(request)).toEqual(skg)
    expect(await finder.run(indexRequest)).toEqual(index)
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(await finder.run({ ...request, provider: 'europe-pmc' })).toMatchObject({
      provider: 'europe-pmc',
      issue: 'no-match'
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('fixes the explicit Index mode across directions, legacy requests and expiry checks', async () => {
    const { finder, fetcher } = fixture([
      indexIdentity(),
      json([edge()]),
      json([metadata('9')]),
      json([edge('8', 'citations')]),
      json([metadata('8')])
    ])
    const first = await finder.run(indexRequest)
    expect(first).toMatchObject({
      state: 'ready',
      opencitationsMode: 'index',
      records: [{ paperId: 'opencitations:br/9' }]
    })
    expect(
      await finder.run({
        ...request,
        resolutionToken: first.resolutionToken,
        direction: 'citations'
      })
    ).toMatchObject({
      state: 'ready',
      opencitationsMode: 'index',
      records: [{ paperId: 'opencitations:br/8' }]
    })
    expect(
      await finder.run({
        ...request,
        resolutionToken: first.resolutionToken,
        opencitationsMode: 'skg-if'
      })
    ).toMatchObject({ issue: 'expired', records: [] })
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/meta/v1/metadata/doi:10.1234%2Fseed',
      '/index/v2/references/doi:10.1234%2Fseed',
      '/meta/v1/metadata/omid:br/9',
      '/index/v2/citations/doi:10.1234%2Fseed',
      '/meta/v1/metadata/omid:br/8'
    ])
  })

  it.each(['references', 'citations'] as const)(
    'reuses the complete immutable %s snapshot for later offsets',
    async (direction) => {
      const rows = Array.from({ length: 21 }, (_, index) => edge(String(index + 1), direction))
      const papers = Array.from({ length: 21 }, (_, index) => metadata(String(index + 1)))
      const { finder, fetcher } = fixture([indexIdentity(), json(rows), json(papers), json(papers)])
      const first = await finder.run({ ...indexRequest, direction })
      expect(first).toMatchObject({ state: 'ready', nextOffset: 20 })
      expect(first.records).toHaveLength(20)
      const second = await finder.run({
        ...request,
        direction,
        resolutionToken: first.resolutionToken,
        offset: 20
      })
      expect(second).toMatchObject({ state: 'ready', opencitationsMode: 'index' })
      expect(second.records).toHaveLength(1)
      expect(second.nextOffset).toBeUndefined()
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/index/'))).toHaveLength(1)
    }
  )

  it.each(['foreign target DOI', 'foreign OCI', 'extra OMID', 'malformed OMID', 'oversize'])(
    'rejects unsafe complete snapshots: %s',
    async (failure) => {
      const row = edge()
      if (failure === 'foreign target DOI') row.citing = 'omid:br/061234 doi:10.1234/other'
      if (failure === 'foreign OCI') row.oci = '061234-99'
      if (failure === 'extra OMID') row.cited += ' omid:br/99'
      if (failure === 'malformed OMID') row.cited += ' omid:br/invalid'
      const { finder, fetcher } = fixture([
        indexIdentity(),
        json(failure === 'oversize' ? Array(2001).fill(row) : [row])
      ])
      const result = await finder.run(indexRequest)
      expect(result).toMatchObject({
        issue: failure === 'oversize' ? 'source-limit' : 'response-invalid',
        records: []
      })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it('accepts exactly 2000 edges, and Meta matches only complete exact OMID tokens', async () => {
    const { finder } = fixture([
      indexIdentity(),
      json(Array.from({ length: 2000 }, (_, index) => edge(String(index + 1)))),
      json([metadata('99999', { id: 'omid:br/10suffix', title: 'Foreign' })])
    ])
    const result = await finder.run(indexRequest)
    expect(result).toMatchObject({ state: 'ready', omitted: 20, records: [], nextOffset: 20 })
    expect(result.resolutionToken).toBeDefined()
  })

  it.each(['metadata conflict', 'edge conflict', 'alias overlap'])(
    'checks neighbor DOI evidence while allowing real aliases: %s',
    async (scenario) => {
      const row = { ...edge(), cited: 'omid:br/9 doi:10.1234/a doi:10.1234/alias' }
      const rows =
        scenario === 'edge conflict' ? [row, { ...row, cited: 'omid:br/9 doi:10.1234/b' }] : [row]
      const { finder } = fixture([
        indexIdentity(),
        json(rows),
        json([
          metadata('9', {
            id: `omid:br/9 doi:10.1234/${scenario === 'alias overlap' ? 'alias' : 'b'}`
          })
        ])
      ])
      expect(await finder.run(indexRequest)).toMatchObject(
        scenario === 'alias overlap'
          ? { state: 'ready', records: [{ paperId: 'opencitations:br/9' }] }
          : { issue: 'response-invalid', records: [] }
      )
    }
  )

  it.each(
    (['references', 'citations'] as const).flatMap((direction) =>
      ['012', '021', '102', '120', '201', '210'].map((order) => ({ direction, order }))
    )
  )(
    'rejects disjoint DOI claims regardless of edge order: $direction, $order',
    async ({ direction, order }) => {
      const claims = ['doi:10.1234/a', 'doi:10.1234/b', 'doi:10.1234/a doi:10.1234/b']
      const rows = [...order].map((position) => {
        const row = edge('9', direction)
        row[direction === 'references' ? 'cited' : 'citing'] += ` ${claims[Number(position)]}`
        return row
      })
      const { finder, fetcher } = fixture([
        indexIdentity(),
        json(rows),
        json([metadata('9', { id: 'omid:br/9 doi:10.1234/a' })])
      ])
      const result = await finder.run({ ...indexRequest, direction })
      expect(result).toMatchObject({ issue: 'response-invalid', records: [] })
      expect(result.resolutionToken).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
    }
  )

  it.each(
    (['references', 'citations'] as const).flatMap((direction) =>
      [undefined, null, '   '].flatMap((title) =>
        [false, true].map((reverse) => ({ direction, title, reverse }))
      )
    )
  )(
    'checks DOI conflicts before filtering untitled metadata: $direction, $title, reverse=$reverse',
    async ({ direction, title, reverse }) => {
      const row = edge('9', direction)
      row[direction === 'references' ? 'cited' : 'citing'] += ' doi:10.1234/a'
      const papers = [
        metadata('9', { title: 'A missing DOI' }),
        metadata('9', { id: 'omid:br/9 doi:10.1234/b', title })
      ]
      const { finder } = fixture([
        indexIdentity(),
        json([row]),
        json(reverse ? papers.reverse() : papers)
      ])
      const result = await finder.run({ ...indexRequest, direction })
      expect(result).toMatchObject({ issue: 'response-invalid', records: [] })
      expect(result.resolutionToken).toBeUndefined()
    }
  )

  it.each(
    (['references', 'citations'] as const).flatMap((direction) =>
      ['A alias', 'Z alias'].flatMap((aliasTitle) =>
        [false, true].map((reverse) => ({ direction, aliasTitle, reverse }))
      )
    )
  )(
    'selects matching DOI metadata across alias titles and row order: $direction, $aliasTitle, reverse=$reverse',
    async ({ direction, aliasTitle, reverse }) => {
      const row = edge('9', direction)
      row[direction === 'references' ? 'cited' : 'citing'] += ' doi:10.1234/a'
      const papers = [
        metadata('9', { id: 'omid:br/9 doi:10.1234/b', title: aliasTitle }),
        metadata('9', { id: 'omid:br/9 doi:10.1234/A', title: 'M matching' }),
        metadata('9', { title: 'A missing DOI' })
      ]
      const { finder } = fixture([
        indexIdentity(),
        json([row]),
        json(reverse ? papers.reverse() : papers)
      ])
      const result = await finder.run({ ...indexRequest, direction })
      expect(result).toMatchObject({
        state: 'ready',
        records: [
          {
            paperId: 'opencitations:br/9',
            item: {
              title: 'M matching',
              identifiers: [{ scheme: 'doi', value: '10.1234/A' }]
            }
          }
        ]
      })
      expect(result.records).toHaveLength(1)
      expect(result.resolutionToken).toBeDefined()
    }
  )

  it.each(['references', 'citations'] as const)(
    'does not hide conflicting %s DOI evidence behind a metadata row without a DOI',
    async (direction) => {
      const row = edge('9', direction)
      row[direction === 'references' ? 'cited' : 'citing'] += ' doi:10.1234/a'
      const { finder } = fixture([
        indexIdentity(),
        json([row]),
        json([
          metadata('9', { title: 'A missing DOI' }),
          metadata('9', { id: 'omid:br/9 doi:10.1234/b', title: 'Z conflicting' })
        ])
      ])
      const result = await finder.run({ ...indexRequest, direction })
      expect(result).toMatchObject({ issue: 'response-invalid', records: [] })
      expect(result.resolutionToken).toBeUndefined()
    }
  )

  it.each(['references', 'citations'] as const)(
    'allows missing %s metadata DOI evidence when no row contradicts Index',
    async (direction) => {
      const row = edge('9', direction)
      row[direction === 'references' ? 'cited' : 'citing'] += ' doi:10.1234/a'
      const { finder } = fixture([indexIdentity(), json([row]), json([metadata('9')])])
      const result = await finder.run({ ...indexRequest, direction })
      expect(result).toMatchObject({
        state: 'ready',
        records: [{ paperId: 'opencitations:br/9', item: { identifiers: [] } }]
      })
      expect(result.resolutionToken).toBeDefined()
    }
  )

  it('does not publish a snapshot after the original root changes', async () => {
    const { finder, catalog } = fixture([indexIdentity(), json([edge()]), json([metadata('9')])])
    catalog.get
      .mockResolvedValueOnce(reference())
      .mockResolvedValueOnce({ ...reference(), metadataRevision: 2 })
    const result = await finder.run(indexRequest)
    expect(result).toMatchObject({ issue: 'reference-changed', records: [] })
    expect(result.resolutionToken).toBeUndefined()
  })

  it('bounds repeated partial Index citation body resets without publishing a snapshot or token', async () => {
    const diagnostics: LiteratureRelatedDiagnostic[] = []
    const partialBody = (id: string): Response => {
      const chunk = new TextEncoder().encode(`[${JSON.stringify(edge(id, 'citations'))},`)
      let sent = false
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!sent) {
                sent = true
                controller.enqueue(chunk)
              } else
                controller.error(
                  new TypeError('terminated', {
                    cause: Object.assign(new Error('Socket closed'), { code: 'UND_ERR_SOCKET' })
                  })
                )
            }
          },
          { highWaterMark: 0 }
        )
      )
    }
    const { finder, fetcher } = fixture(
      [
        indexIdentity(),
        json([edge()]),
        json([metadata('9')]),
        partialBody('7'),
        partialBody('6'),
        json([edge('8', 'citations')]),
        json([metadata('8')])
      ],
      reference(),
      (event) => diagnostics.push(event)
    )
    const first = await finder.run(indexRequest)
    expect(first.state).toBe('ready')
    expect(first.resolutionToken).toBeDefined()
    const citations = {
      ...indexRequest,
      direction: 'citations' as const,
      resolutionToken: first.resolutionToken
    }
    const failed = await finder.run(citations)
    expect(failed).toMatchObject({
      state: 'unavailable',
      issue: 'unavailable',
      provider: 'opencitations',
      opencitationsMode: 'index',
      records: []
    })
    expect(failed.resolutionToken).toBeUndefined()
    expect(failed.nextOffset).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(diagnostics).toMatchObject(
      [1, 2].map((attempt) => ({
        endpoint: 'citations',
        phase: 'body',
        status: 200,
        code: 'UND_ERR_SOCKET',
        attempt,
        outcome: 'failed',
        issue: 'unavailable'
      }))
    )
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics.every((event) => (event.bytes ?? 0) > 0)).toBe(true)

    // The original session remains usable, but an incomplete citation response
    // cannot replace a fresh complete snapshot or authorize its partial rows.
    expect(await finder.run(citations)).toMatchObject({
      state: 'ready',
      resolutionToken: first.resolutionToken,
      records: [{ paperId: 'opencitations:br/8' }]
    })
    expect(fetcher).toHaveBeenCalledTimes(7)
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('/index/v2/citations/'))
    ).toHaveLength(3)
  })

  it('keeps a hydrated Index snapshot private until the final root check succeeds', async () => {
    const { finder, catalog, fetcher } = fixture([indexIdentity(), json([])])
    const first = await finder.run(indexRequest)
    let instant = Date.now()
    vi.mocked(Date.now).mockImplementation(() => (instant += 1001))
    let finishRootCheck!: (value: DiscoveryReference) => void
    catalog.get.mockResolvedValueOnce(reference()).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRootCheck = resolve
        })
    )
    fetcher
      .mockResolvedValueOnce(json([edge('7', 'citations')]))
      .mockResolvedValueOnce(json([metadata('7')]))
    const controller = new AbortController()
    const citations = {
      ...indexRequest,
      direction: 'citations' as const,
      resolutionToken: first.resolutionToken
    }
    const pending = finder.run(citations, controller.signal)
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(finishRootCheck).toBeTypeOf('function'))
    controller.abort()
    finishRootCheck(reference())
    await rejection
    fetcher
      .mockResolvedValueOnce(json([edge('8', 'citations')]))
      .mockResolvedValueOnce(json([metadata('8')]))
    expect(await finder.run(citations)).toMatchObject({
      state: 'ready',
      records: [{ paperId: 'opencitations:br/8' }]
    })
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('/index/v2/citations/'))
    ).toHaveLength(2)
  })

  it('retains an Index direction snapshot when another direction finishes later', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => edge(String(index + 1)))
    const papers = Array.from({ length: 21 }, (_, index) => metadata(String(index + 1)))
    const { finder, fetcher } = fixture([indexIdentity(), json(rows), json(papers)])
    const first = await finder.run(indexRequest)
    let instant = Date.now()
    vi.mocked(Date.now).mockImplementation(() => (instant += 1001))
    let finishReferences!: (value: Response) => void
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.includes('/index/v2/citations/')) return json([edge('30', 'citations')])
      if (path.endsWith('br/30')) return json([metadata('30')])
      return new Promise((resolve) => {
        finishReferences = resolve
      })
    })
    const references = finder.run({
      ...indexRequest,
      resolutionToken: first.resolutionToken,
      offset: 20
    })
    await vi.waitFor(() => expect(finishReferences).toBeTypeOf('function'))
    const citations = {
      ...indexRequest,
      direction: 'citations' as const,
      resolutionToken: first.resolutionToken
    }
    expect(await finder.run(citations)).toMatchObject({
      state: 'ready',
      records: [{ paperId: 'opencitations:br/30' }]
    })
    finishReferences(json(papers))
    expect(await references).toMatchObject({
      state: 'ready',
      records: [{ paperId: 'opencitations:br/9' }]
    })
    const calls = fetcher.mock.calls.length
    expect(await finder.run({ ...citations, offset: 20 })).toMatchObject({
      state: 'ready',
      records: []
    })
    expect(fetcher).toHaveBeenCalledTimes(calls)
  })

  it('rejects a conflicting concurrently hydrated Index snapshot without granting its neighbors', async () => {
    const { finder, fetcher } = fixture([indexIdentity(), json([])])
    const first = await finder.run(indexRequest)
    let instant = Date.now()
    vi.mocked(Date.now).mockImplementation(() => (instant += 1001))
    let queries = 0
    const finish = new Map<string, (value: Response) => void>()
    fetcher.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname
      if (path.includes('/index/v2/citations/'))
        return json([edge(String(7 + queries++), 'citations')])
      const id = path.split('/').at(-1)!
      return new Promise((resolve) => {
        finish.set(id, resolve)
      })
    })
    const citations = {
      ...indexRequest,
      direction: 'citations' as const,
      resolutionToken: first.resolutionToken
    }
    const one = finder.run(citations)
    const two = finder.run({ ...citations, seedPaperId: first.seed!.paperId })
    await vi.waitFor(() => expect(finish.size).toBe(2))
    finish.get('7')!(json([metadata('7')]))
    expect(await one).toMatchObject({
      state: 'ready',
      records: [{ paperId: 'opencitations:br/7' }]
    })
    finish.get('8')!(json([metadata('8')]))
    expect(await two).toMatchObject({
      state: 'unavailable',
      issue: 'response-invalid',
      records: []
    })
    const calls = fetcher.mock.calls.length
    expect(await finder.run({ ...citations, seedPaperId: 'opencitations:br/8' })).toMatchObject({
      issue: 'expired',
      records: []
    })
    expect(fetcher).toHaveBeenCalledTimes(calls)
    fetcher.mockResolvedValueOnce(json([metadata('7')]))
    expect(await finder.run(citations)).toMatchObject({
      state: 'ready',
      records: [{ paperId: 'opencitations:br/7' }]
    })
    expect(queries).toBe(2)
  })

  it('does not cache a canceled direction snapshot in an existing Index session', async () => {
    const { finder, fetcher } = fixture([indexIdentity(), json([])])
    const first = await finder.run(indexRequest)
    const controller = new AbortController()
    fetcher.mockImplementationOnce(async () => new Promise<Response>(() => {}))
    const pending = finder.run(
      { ...indexRequest, direction: 'citations', resolutionToken: first.resolutionToken },
      controller.signal
    )
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3), { timeout: 2000 })
    controller.abort()
    await rejection
    fetcher
      .mockResolvedValueOnce(json([edge('8', 'citations')]))
      .mockResolvedValueOnce(json([metadata('8')]))
    expect(
      await finder.run({
        ...indexRequest,
        direction: 'citations',
        resolutionToken: first.resolutionToken
      })
    ).toMatchObject({
      state: 'ready',
      records: [{ paperId: 'opencitations:br/8' }]
    })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })
})
