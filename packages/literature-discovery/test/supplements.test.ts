import { describe, expect, it, vi } from 'vitest'
import { LiteratureSupplementFinder } from '../src/supplements.js'
import { discoveryReferenceSchema } from '../src/contracts.js'
import {
  getSupplementDoi,
  mergeSupplementResults,
  literatureSupplementRequestSchema,
  type LiteratureSupplementRequest
} from '../src/supplement-contracts.js'
import { parseSupplementXml } from '../src/supplement-xml.js'

const doi = '10.1101/2025.09.25.675916'
const item = discoveryReferenceSchema.parse({
  id: 'paper',
  metadataRevision: 1,
  attachments: [],
  item: {
    itemType: 'journalArticle',
    title: 'Paper',
    identifiers: [{ scheme: 'doi', value: doi }]
  }
})
const request = (
  provider: LiteratureSupplementRequest['provider']
): LiteratureSupplementRequest => ({ itemId: 'paper', expectedMetadataRevision: 1, provider })
const json = (value: unknown): Response => Response.json(value)
const fig = {
  id: 33876346,
  title: 'Behavioural data',
  doi: '10.6084/m9.figshare.33876346.v1',
  resource_doi: null,
  related_materials: [{ identifier_type: 'DOI', relation: 'IsSupplementTo', identifier: doi }],
  files: [
    { name: 'README.md', size: 2212 },
    { name: 'neural_priors_behavior.tsv', size: 1319441 }
  ],
  license: { name: 'CC BY 4.0' }
}
const data = {
  id: fig.doi,
  attributes: {
    doi: fig.doi,
    titles: [{ title: 'Behavioural data' }],
    relatedIdentifiers: [
      { relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo', relatedIdentifier: doi }
    ],
    rightsList: [{ rights: 'CC BY 4.0' }]
  }
}
const setup = (
  fetcher: typeof fetch
): { finder: LiteratureSupplementFinder; get: ReturnType<typeof vi.fn> } => {
  const get = vi.fn().mockResolvedValue(item)
  return { finder: new LiteratureSupplementFinder({ fetch: fetcher, catalog: { get } }), get }
}
const article = (content: string, identity = doi): string =>
  `<article xmlns:xlink="http://www.w3.org/1999/xlink"><front><article-meta><article-id pub-id-type="doi">${identity}</article-id></article-meta></front><body>${content}</body></article>`
const supplement =
  '<supplementary-material id="s1"><label>File S1</label><caption><p>Data table</p></caption><media xlink:href="supplement.xls"/></supplementary-material>'

describe('supplementary material search', () => {
  it('finds new-field-only Figshare records and fetches metadata without files', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/search')) {
        const body = JSON.parse(String(init?.body))
        expect(init?.redirect).toBe('error')
        expect(init?.credentials).toBe('omit')
        return json(body.resource_doi ? [] : [{ id: fig.id }])
      }
      expect(String(url)).toBe(`https://api.figshare.com/v2/articles/${fig.id}`)
      return json(fig)
    })
    const { finder } = setup(fetcher)
    const result = await finder.run(request('figshare'))
    expect(result.state).toBe('complete')
    expect(result.records[0]).toMatchObject({
      files: [
        { name: 'README.md', sizeBytes: 2212 },
        { name: 'neural_priors_behavior.tsv', sizeBytes: 1319441 }
      ]
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).search_for).toBe(`"${doi}"`)
  })
  it.each(['References', 'IsVersionOf'])(
    'rejects Figshare %s relations even with a matching legacy DOI',
    async (relation) => {
      const { finder } = setup(
        vi.fn<typeof fetch>(async (url) =>
          json(
            String(url).endsWith('/search')
              ? [{ id: fig.id }]
              : {
                  ...fig,
                  resource_doi: doi,
                  related_materials: [{ identifier_type: 'DOI', identifier: doi, relation }]
                }
          )
        )
      )
      expect((await finder.run(request('figshare'))).records).toEqual([])
    }
  )
  it('issues an expiring item-bound download ID instead of accepting a renderer URL', async () => {
    const { finder } = setup(
      vi.fn<typeof fetch>(async (url) =>
        json(
          String(url).endsWith('/search')
            ? [{ id: fig.id }]
            : {
                ...fig,
                files: [
                  { name: 'data.csv', download_url: 'https://ndownloader.figshare.com/files/123' }
                ]
              }
        )
      )
    )
    const response = await finder.run(request('figshare'))
    const id = response.records[0].files![0].downloadId!
    expect(id).toBeTruthy()
    expect(finder.getDownload(id, 'paper', 1)).toMatchObject({
      filename: 'data.csv',
      url: 'https://ndownloader.figshare.com/files/123'
    })
    expect(() => finder.getDownload(id, 'other', 1)).toThrow()
    expect(() => finder.getDownload(id, 'paper', 2)).toThrow()
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000)
    try {
      expect(() => finder.getDownload(id, 'paper', 1)).toThrow('expired')
    } finally {
      now.mockRestore()
    }
  })
  it('retains Figshare records when its legacy query fails', async () => {
    const { finder } = setup(
      vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith('/search'))
          return JSON.parse(String(init?.body)).resource_doi
            ? new Response('', { status: 503 })
            : json([{ id: fig.id }])
        return json(fig)
      })
    )
    expect(await finder.run(request('figshare'))).toMatchObject({
      state: 'partial',
      issues: ['unavailable'],
      records: [{ id: String(fig.id) }]
    })
  })
  it('does not accept an unrelated Figshare detail returned for the requested ID', async () => {
    const { finder } = setup(
      vi.fn<typeof fetch>(async (url) =>
        json(String(url).endsWith('/search') ? [{ id: fig.id }] : { ...fig, id: 1 })
      )
    )
    expect(await finder.run(request('figshare'))).toMatchObject({
      records: [],
      state: 'partial',
      issues: ['response-invalid']
    })
  })
  it('isolates outages and merges exact DOIs without merging version and concept records', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('datacite')
        ? json({
            data: [
              data,
              {
                ...data,
                id: '10.6084/m9.figshare.33876346',
                attributes: { ...data.attributes, doi: '10.6084/m9.figshare.33876346' }
              }
            ]
          })
        : new Response('', { status: 503 })
    )
    const { finder } = setup(fetcher)
    const [figResult, dataResult] = await Promise.all([
      finder.run(request('figshare')),
      finder.run(request('datacite'))
    ])
    expect(figResult.state).toBe('unavailable')
    expect(dataResult.records).toHaveLength(2)
    expect(dataResult.records[0].files).toBeUndefined()
    const merged = mergeSupplementResults([
      dataResult,
      {
        ...figResult,
        state: 'complete',
        records: [{ ...dataResult.records[0], files: [{ name: 'real.tsv', sizeBytes: 4 }] }]
      }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      providers: ['figshare', 'datacite'],
      files: [{ name: 'real.tsv', sizeBytes: 4 }]
    })
    const query = new URL(
      String(fetcher.mock.calls.find(([url]) => String(url).includes('datacite'))![0])
    ).searchParams.get('query')
    expect(query).toBe(`relatedIdentifiers.relatedIdentifier:"${doi}"`)
  })
  it('requires the DOI, identifier type and IsSupplementTo on the same DataCite relation', async () => {
    const { finder } = setup(
      vi.fn<typeof fetch>(async () =>
        json({
          data: [
            {
              ...data,
              attributes: {
                ...data.attributes,
                relatedIdentifiers: [
                  {
                    relatedIdentifierType: 'DOI',
                    relationType: 'References',
                    relatedIdentifier: doi
                  },
                  {
                    relatedIdentifierType: 'URL',
                    relationType: 'IsSupplementTo',
                    relatedIdentifier: doi
                  },
                  {
                    relatedIdentifierType: 'DOI',
                    relationType: 'IsSupplementTo',
                    relatedIdentifier: '10.1234/other'
                  }
                ]
              }
            }
          ]
        })
      )
    )
    expect((await finder.run(request('datacite'))).records).toEqual([])
  })
  it('marks repeating pages as incomplete and preserves the first page', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ data: Array.from({ length: 25 }, () => data) })
    )
    const { finder } = setup(fetcher)
    expect(await finder.run(request('datacite'))).toMatchObject({
      state: 'partial',
      issues: ['search-incomplete'],
      records: [{ id: data.id }]
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('reads explicit article supplements without fetching a ZIP or media URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/search?'))
        return json({ hitCount: 1, resultList: { result: [{ doi, pmcid: 'PMC3384632' }] } })
      expect(String(url)).toMatch(/\/PMC3384632\/fullTextXML$/u)
      return new Response(article(supplement))
    })
    const { finder } = setup(fetcher)
    expect(await finder.run(request('europe-pmc'))).toMatchObject({
      state: 'complete',
      records: [{ evidence: 'article-section', files: [{ name: 'supplement.xls' }] }]
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('reports unavailable article XML separately from an empty completed search', async () => {
    const { finder } = setup(
      vi.fn<typeof fetch>(async () => json({ hitCount: 1, resultList: { result: [{ doi }] } }))
    )
    expect(await finder.run(request('europe-pmc'))).toMatchObject({
      state: 'partial',
      issues: ['full-text-unavailable']
    })
  })
  it('retains bounded XML results and reports an incomplete search when records overflow', async () => {
    const { finder } = setup(
      vi.fn<typeof fetch>(async (url) =>
        String(url).includes('/search?')
          ? json({ hitCount: 1, resultList: { result: [{ doi, pmcid: 'PMC3384632' }] } })
          : new Response(
              article(
                Array.from({ length: 51 }, (_, index) =>
                  supplement.replace('supplement.xls', `supplement-${index}.xls`)
                ).join('')
              )
            )
      )
    )
    const result = await finder.run(request('europe-pmc'))
    expect(result).toMatchObject({ state: 'partial', issues: ['search-incomplete'] })
    expect(result.records).toHaveLength(50)
    expect(result.records[0].files).toMatchObject([
      { name: 'supplement-0.xls', downloadId: expect.any(String) }
    ])
  })
  it('retains the first 100 XML filenames and marks the file inventory incomplete', () => {
    const media = Array.from(
      { length: 101 },
      (_, index) => `<media xlink:href="file-${index}.csv"/>`
    ).join('')
    const result = parseSupplementXml(
      article(`<supplementary-material>${media}</supplementary-material>`),
      doi,
      'PMC1'
    )
    expect(result.truncated).toBe(true)
    expect(result.records[0].files).toHaveLength(100)
    expect(result.records[0].files?.[99].name).toBe('file-99.csv')
  })
  it('deduplicates repeated article sections referencing the same supplement file', () => {
    expect(parseSupplementXml(article(supplement.repeat(2)), doi, 'PMC1').records).toHaveLength(1)
  })
  it('rejects reference-list DOI matches, nested article supplements, entity declarations and malformed XML', () => {
    expect(
      parseSupplementXml(
        article(`<sub-article>${supplement}</sub-article>${supplement}`),
        doi,
        'PMC1'
      ).records
    ).toHaveLength(1)
    expect(() => parseSupplementXml(article(supplement, '10.1234/wrong'), doi, 'PMC1')).toThrow(
      'DOI mismatch'
    )
    expect(() =>
      parseSupplementXml(
        '<article><back><article-id pub-id-type="doi">' + doi + '</article-id></back></article>',
        doi,
        'PMC1'
      )
    ).toThrow('DOI mismatch')
    expect(() =>
      parseSupplementXml(
        '<!DOCTYPE article [<!ENTITY x "bad">]>' + article(supplement),
        doi,
        'PMC1'
      )
    ).toThrow('entity')
    expect(() => parseSupplementXml(article(supplement).slice(0, -10), doi, 'PMC1')).toThrow()
  })
  it.each(['revision', 'deleted', 'doi'])(
    'discards results when reference %s changes during I/O',
    async (change) => {
      const { finder, get } = setup(vi.fn<typeof fetch>(async () => json({ data: [data] })))
      get.mockResolvedValueOnce(item).mockResolvedValueOnce({
        ...item,
        ...(change === 'revision'
          ? { metadataRevision: 2 }
          : change === 'deleted'
            ? { deletedAt: 42 }
            : { item: { ...item.item, identifiers: [{ scheme: 'doi', value: '10.1234/new' }] } })
      })
      expect(await finder.run(request('datacite'))).toMatchObject({
        state: 'unavailable',
        records: [],
        issues: [change === 'deleted' ? 'reference-unavailable' : 'reference-changed']
      })
    }
  )
  it('does not query with missing, invalid or conflicting DOI identifiers', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const { finder, get } = setup(fetcher)
    for (const values of [[], ['invalid'], [doi, '10.1234/another']]) {
      get.mockResolvedValue({
        ...item,
        item: { ...item.item, identifiers: values.map((value) => ({ scheme: 'doi', value })) }
      })
      expect(await finder.run(request('figshare'))).toMatchObject({
        issues: ['doi-required'],
        records: []
      })
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      getSupplementDoi([
        { scheme: 'doi', value: `https://doi.org/${doi}` },
        { scheme: 'doi', value: doi }
      ])
    ).toBe(doi)
  })
  it('enforces rate-limit cooldown without blocking another provider', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('datacite')
        ? new Response('', { status: 429, headers: { 'Retry-After': '60' } })
        : json([])
    )
    const { finder } = setup(fetcher)
    const limited = await finder.run(request('datacite'))
    expect(limited).toMatchObject({ state: 'unavailable', issues: ['rate-limited'] })
    expect(limited.retryAt).toBeGreaterThan(Date.now() + 55_000)
    await finder.run(request('datacite'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await finder.run(request('figshare'))).state).toBe('complete')
  })
  it('caps response bytes and cancels oversized bodies', async () => {
    const cancel = vi.fn()
    const { finder } = setup(
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
              },
              cancel
            })
          )
      )
    )
    expect(await finder.run(request('datacite'))).toMatchObject({
      state: 'unavailable',
      issues: ['search-incomplete']
    })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('propagates caller cancellation and rejects caller-supplied fetch URLs', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const { finder } = setup(fetcher)
    const abort = new AbortController()
    abort.abort()
    await expect(finder.run(request('datacite'), abort.signal)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      literatureSupplementRequestSchema.safeParse({
        ...request('datacite'),
        url: 'http://localhost'
      }).success
    ).toBe(false)
  })

  it('bounds the total UTF-8 reply size across many individually valid detail responses', async () => {
    const files = Array.from({ length: 100 }, () => ({ name: '\u6587'.repeat(2048), size: 1 }))
    const { finder } = setup(
      vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith('/search'))
          return json(
            JSON.parse(String(init?.body)).page === 1
              ? Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }))
              : []
          )
        const id = Number(String(url).split('/').pop())
        return json({ ...fig, id, doi: `10.1234/supplement-${id}`, files })
      })
    )
    const result = await finder.run(request('figshare'))
    expect(result.state).toBe('partial')
    expect(result.issues).toContain('search-incomplete')
    expect(result.records.length).toBeGreaterThan(0)
    expect(result.records.length).toBeLessThan(25)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(11 * 1024 * 1024)
  })

  it('cancels an in-flight fetch when the caller disappears', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    const { finder } = setup(fetcher)
    const abort = new AbortController()
    const pending = finder.run(request('datacite'), abort.signal)
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    abort.abort()
    await rejected
  })
})
