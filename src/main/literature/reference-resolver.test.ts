import { describe, expect, it, vi } from 'vitest'

import { LiteratureReferenceResolver } from './reference-resolver'

const pubmedResponse = `PMID- 35486828
TI  - A PubMed paper.
AB  - The complete abstract from PubMed.
FAU - Example, Alice
DP  - 2022 Apr
JT  - Example Journal

PMID- 21458665
TI  - Mapping cancer origins.
AB  - Cancer comprises a bewildering assortment of diseases.
FAU - Gilbertson, Richard J
DP  - 2011 Apr 1
JT  - Cell
LID - 10.1016/j.cell.2011.03.019 [doi]
`

describe('LiteratureReferenceResolver', () => {
  it('resolves the reported Springer PDF DOI into a complete unsaved reference', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            DOI: '10.1007/s11914-026-00956-3',
            type: 'journal-article',
            title: ['Metabolism in Tumour-Induced Bone Disease'],
            abstract: '<jats:p>Bone cells adapt to tumour metabolism.</jats:p>',
            'container-title': ['Current Osteoporosis Reports'],
            published: { 'date-parts': [[2026, 2, 16]] },
            volume: '24',
            issue: '1',
            'article-number': '8',
            author: [
              { given: 'Renee T.', family: 'Ormsby' },
              { given: 'Claire M.', family: 'Edwards' }
            ]
          }
        })
      )
    )
    const [result] = await new LiteratureReferenceResolver(fetchFn).resolve([
      'doi:10.1007/s11914-026-00956-3'
    ])
    expect(result.item).toMatchObject({
      title: 'Metabolism in Tumour-Induced Bone Disease',
      abstract: 'Bone cells adapt to tumour metabolism.',
      containerTitle: 'Current Osteoporosis Reports',
      issuedYear: 2026,
      issuedText: '2026-02-16',
      typeFields: { volume: '24', issue: '1', pages: '8' },
      creators: [
        expect.objectContaining({ familyName: 'Ormsby' }),
        expect.objectContaining({ familyName: 'Edwards' })
      ]
    })
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      'https://api.crossref.org/works/10.1007%2Fs11914-026-00956-3',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('resolves a compact mixed identifier batch and preserves input order', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('efetch.fcgi')) return new Response(pubmedResponse)
      return new Response(
        JSON.stringify({
          message: {
            DOI: '10.1000/example',
            type: 'journal-article',
            title: ['A Crossref paper'],
            'container-title': ['Crossref Journal'],
            issued: { 'date-parts': [[2024, 2, 3]] },
            author: [{ given: 'Bob', family: 'Example' }]
          }
        })
      )
    })
    const resolver = new LiteratureReferenceResolver(fetchFn as typeof fetch)

    const result = await resolver.resolve(['pmid:35486828', 'doi:10.1000/EXAMPLE', 'pmid:21458665'])

    expect(result.map(({ item }) => item.title)).toEqual([
      'A PubMed paper.',
      'A Crossref paper',
      'Mapping cancer origins.'
    ])
    expect(result[0]?.item.abstract).toBe('The complete abstract from PubMed.')
    expect(result[1]?.item.identifiers).toContainEqual({
      scheme: 'doi',
      value: '10.1000/example',
      isPrimary: true
    })
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('id=35486828%2C21458665')
  })

  it('fetches normalized identifiers once while preserving input positions', async () => {
    const fetchFn = vi.fn(async () => new Response(pubmedResponse))
    const resolver = new LiteratureReferenceResolver(fetchFn as typeof fetch)

    const result = await resolver.resolve(['PMID:35486828', 'pmid:35486828'])

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(result[1])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported, invalid, and unresolved identifiers explicitly', async () => {
    const resolver = new LiteratureReferenceResolver(
      vi.fn(async () => new Response(pubmedResponse)) as typeof fetch
    )

    await expect(resolver.resolve(['arxiv:2401.00001'])).rejects.toThrow('UNSUPPORTED_REFERENCE')
    await expect(resolver.resolve(['pmid:not-a-number'])).rejects.toThrow('INVALID_PMID')
    await expect(resolver.resolve(['pmid:999'])).rejects.toThrow('REFERENCE_NOT_FOUND')
  })
})

it.each(['doi:10.1234/cancelled', 'pmid:12345'])(
  'aborts metadata fetch for %s',
  async (reference) => {
    const controller = new AbortController()
    let fetchSignal: AbortSignal | undefined
    let finish!: (response: Response) => void
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      fetchSignal = options?.signal ?? undefined
      return new Promise((resolve, reject) => {
        finish = resolve
        fetchSignal!.addEventListener('abort', () => reject(fetchSignal!.reason), { once: true })
      })
    })
    const reason = new Error('Stopped lookup')
    const outcome = new LiteratureReferenceResolver(fetchFn)
      .resolve([reference], controller.signal)
      .catch((error: unknown) => error)
    controller.abort(reason)
    try {
      expect(fetchSignal?.aborted).toBe(true)
    } finally {
      finish(new Response(''))
      await outcome
    }
    expect(await outcome).toBe(reason)
  }
)

it('falls back from a Crossref 404 to the matching DataCite DOI', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).hostname === 'api.crossref.org'
      ? new Response('', { status: 404 })
      : Response.json({
          data: {
            attributes: {
              doi: '10.1234/dataset',
              titles: [{ title: 'Measured data' }],
              types: { resourceTypeGeneral: 'Dataset' },
              publicationYear: 2024,
              publisher: { name: 'Archive' },
              descriptions: [
                { descriptionType: 'Abstract', description: 'Observed values from the experiment.' }
              ],
              creators: [{ name: 'Example Consortium', nameType: 'Organizational' }]
            }
          }
        })
  )
  const [result] = await new LiteratureReferenceResolver(fetchFn).resolve(['doi:10.1234/dataset'])
  expect(result.item).toMatchObject({
    itemType: 'dataset',
    title: 'Measured data',
    abstract: 'Observed values from the experiment.',
    typeFields: { publisher: 'Archive' }
  })
  expect(result.source.provider).toBe('datacite')
  expect(fetchFn).toHaveBeenCalledTimes(2)
})

it.each(['10.1234/other', undefined])(
  'does not accept an unmatched Europe PMC DOI: %s',
  async (doi) => {
    const fetchFn = vi.fn<typeof fetch>(async (url) =>
      new URL(String(url)).hostname === 'api.crossref.org'
        ? Response.json({ message: { DOI: '10.1234/requested', title: ['Requested paper'] } })
        : Response.json({
            resultList: {
              result: [
                {
                  id: '123',
                  source: 'MED',
                  doi,
                  title: 'Other paper',
                  abstractText: 'Wrong evidence.'
                }
              ]
            }
          })
    )
    const result = await new LiteratureReferenceResolver(fetchFn).lookup('doi:10.1234/requested')
    expect(result.item.abstract).toBe('')
    expect(result.sources).toHaveLength(1)
  }
)

it('does not select one of multiple exact DOI matches arbitrarily', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).hostname === 'api.crossref.org'
      ? Response.json({ message: { DOI: '10.1234/requested', title: ['Requested paper'] } })
      : Response.json({
          resultList: {
            result: ['123', '456'].map((id) => ({
              id,
              source: 'MED',
              doi: '10.1234/requested',
              title: 'A candidate',
              abstractText: 'Ambiguous evidence.'
            }))
          }
        })
  )
  expect(
    (await new LiteratureReferenceResolver(fetchFn).lookup('doi:10.1234/requested')).item.abstract
  ).toBe('')
})

it('keeps supplemental source attribution in the Agent discovery receipt', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).hostname === 'api.crossref.org'
      ? Response.json({ message: { DOI: '10.1234/requested', title: ['Requested paper'] } })
      : Response.json({
          resultList: {
            result: [
              {
                id: '123',
                source: 'MED',
                doi: '10.1234/requested',
                title: 'Requested paper',
                abstractText: 'Verified evidence.'
              }
            ]
          }
        })
  )
  const [result] = await new LiteratureReferenceResolver(fetchFn).resolve(['doi:10.1234/requested'])
  expect(result.item.abstract).toBe('Verified evidence.')
  expect(result.source.rawMetadata.supplementalSources).toEqual([
    expect.objectContaining({ provider: 'europe-pmc', externalId: '123' })
  ])
})

it('escapes DOI suffixes as a single Europe PMC query literal', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).hostname === 'api.crossref.org'
      ? Response.json({ message: { title: ['Paper'] } })
      : Response.json({ resultList: { result: [] } })
  )
  await new LiteratureReferenceResolver(fetchFn).lookup('doi:10.1234/a"OR*')
  expect(new URL(String(fetchFn.mock.calls[1][0])).searchParams.get('query')).toBe(
    'DOI:"10.1234/a\\"or*"'
  )
})

it('preserves a registration-agency rate limit when Crossref and Europe PMC have no record', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).hostname === 'api.datacite.org'
      ? new Response('', { status: 429 })
      : new URL(String(url)).hostname === 'api.crossref.org'
        ? new Response('', { status: 404 })
        : Response.json({ resultList: { result: [] } })
  )
  await expect(
    new LiteratureReferenceResolver(fetchFn).resolve(['doi:10.1234/dataset'])
  ).rejects.toThrow('429')
})
