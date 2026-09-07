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
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('id=35486828%2C21458665')
  })

  it('normalizes and de-duplicates identifiers before fetching metadata', async () => {
    const fetchFn = vi.fn(async () => new Response(pubmedResponse))
    const resolver = new LiteratureReferenceResolver(fetchFn as typeof fetch)

    const result = await resolver.resolve(['PMID:35486828', 'pmid:35486828'])

    expect(result).toHaveLength(1)
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
