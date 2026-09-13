import { describe, expect, it, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { getDescriptor, validateToolArguments } from '../registry'

const notice = {
  DOI: '10.1038/nature13598',
  type: 'retraction',
  source: 'publisher',
  label: 'Retraction',
  updated: { 'date-parts': [[2014, 7, 2]] }
}
// Reduced real Crossref and DataCite payloads, checked against the public APIs on 2026-09-13.
const crossref = (fields: Record<string, unknown> = {}): unknown => ({
  status: 'ok',
  message: {
    DOI: '10.1038/nature12968',
    title: [
      'RETRACTED ARTICLE: Stimulus-triggered fate conversion of somatic cells into pluripotency'
    ],
    'updated-by': [notice, { ...notice, source: 'retraction-watch', 'record-id': '2081' }],
    ...fields
  }
})
const record = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '10.14454/qdd3-ps68',
  type: 'dois',
  attributes: {
    doi: '10.14454/qdd3-ps68',
    titles: [{ title: 'DataCite Metadata Schema Documentation' }],
    creators: [{ name: 'DataCite Metadata Working Group' }],
    publisher: { name: 'DataCite', publisherIdentifier: 'https://ror.org/04wxnsj81' },
    publicationYear: 2026,
    types: { resourceTypeGeneral: 'Text' },
    relatedIdentifiers: [
      {
        relatedIdentifier: '10.14454/3w3z-sa82',
        relatedIdentifierType: 'DOI',
        relationType: 'IsNewVersionOf'
      }
    ],
    ...fields
  }
})
const mockCall = (
  payload: unknown,
  status = 200
): {
  fetchImpl: ReturnType<typeof vi.fn>
  call: (method: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
} => {
  const fetchImpl = vi
    .fn()
    .mockImplementation(async () => new Response(JSON.stringify(payload), { status }))
  const engine = new ParserEngine({ fetchImpl, retries: 0 })
  return {
    fetchImpl,
    call: (method: string, args: Record<string, unknown>) => {
      const descriptor = getDescriptor('literature', method)!
      validateToolArguments(descriptor, args)
      return engine.call(descriptor, args, {}) as Promise<Record<string, unknown>>
    }
  }
}

describe('literature / DOI metadata', () => {
  it('normalizes DOI URLs and keeps bibliographic fields without inventing missing values', async () => {
    const { call, fetchImpl } = mockCall(crossref())
    const result = await call('crossref_get_work', { doi: ' HTTPS://DOI.ORG/10.1038/NATURE12968 ' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.1038%2Fnature12968')
    expect(result).toMatchObject({
      doi: '10.1038/nature12968',
      authors: [],
      publisher: null,
      published: null
    })
    expect(result.title).toEqual([expect.stringContaining('RETRACTED ARTICLE')])
  })

  it('preserves update direction, dates and duplicate notices from independent sources', async () => {
    const { call } = mockCall(
      crossref({
        'update-to': [{ ...notice, DOI: '10.1038/other' }],
        relation: { 'has-review': [] }
      })
    )
    const result = await call('crossref_get_updates', { doi: 'doi:10.1038/nature12968' })
    expect(result.updated_by).toEqual([
      notice,
      { ...notice, source: 'retraction-watch', 'record-id': '2081' }
    ])
    expect(result.update_to).toEqual([{ ...notice, DOI: '10.1038/other' }])
    expect(result.relation).toEqual({ 'has-review': [] })
  })

  it('reports absent update metadata without claiming a paper is reliable', async () => {
    const { call } = mockCall(crossref({ 'updated-by': undefined }))
    const result = await call('crossref_get_updates', { doi: '10.1038/nature12968' })
    expect(result.updated_by).toEqual([])
    expect(result.coverage_note).toContain('missing updates do not establish reliability')
    expect(result).not.toHaveProperty('is_retracted')
  })

  it.each(['crossref_get_work', 'crossref_get_updates', 'datacite_get_record'])(
    '%s rejects invalid identifiers before requesting anything',
    async (method) => {
      const { call, fetchImpl } = mockCall({})
      await expect(call(method, { doi: 'https://example.com/not-a-doi' })).rejects.toThrow(
        /valid DOI/
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('does not report malformed or mismatched upstream records as successful lookup results', async () => {
    await expect(
      mockCall({ message: {} }).call('crossref_get_work', { doi: '10.1038/nature12968' })
    ).rejects.toThrow()
    await expect(
      mockCall(crossref({ DOI: '10.1038/other' })).call('crossref_get_work', {
        doi: '10.1038/nature12968'
      })
    ).rejects.toThrow('different DOI')
    await expect(
      mockCall({ data: record() }).call('datacite_get_record', { doi: '10.14454/other' })
    ).rejects.toThrow('different DOI')
    await expect(
      mockCall({ data: { ...record(), id: '10.14454/other' } }).call('datacite_get_record', {
        doi: '10.14454/qdd3-ps68'
      })
    ).rejects.toThrow('different DOI')
  })

  it('keeps HTTP failures distinct from empty result sets', async () => {
    await expect(
      mockCall({}, 404).call('crossref_get_updates', { doi: '10.1038/nature12968' })
    ).rejects.toThrow('HTTP 404')
    await expect(
      mockCall({}, 503).call('datacite_search_records', { query: 'climate' })
    ).rejects.toThrow('HTTP 503')
  })

  it('preserves DataCite identifiers, rights, versions and structured publisher metadata', async () => {
    const { call, fetchImpl } = mockCall({
      data: record({ version: '4.7', rightsList: [{ rightsIdentifier: 'cc0-1.0' }] })
    })
    const result = await call('datacite_get_record', { doi: 'https://doi.org/10.14454/qdd3-ps68' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.datacite.org/dois/10.14454%2Fqdd3-ps68')
    expect(result.record).toMatchObject({
      version: '4.7',
      rights: [{ rightsIdentifier: 'cc0-1.0' }],
      related_identifiers: [{ relationType: 'IsNewVersionOf' }],
      publisher: { name: 'DataCite' },
      url: null
    })
  })

  it('requests one bounded page and combines query and related DOI without losing their scope', async () => {
    const { call, fetchImpl } = mockCall({ data: [record()], meta: { total: 12 } })
    const result = await call('datacite_search_records', {
      query: 'climate OR weather',
      related_doi: '10.14454/3w3z-sa82',
      resource_type: 'software',
      page_size: 2,
      page: 2
    })
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.searchParams.get('query')).toBe(
      '(climate OR weather) AND (relatedIdentifiers.relatedIdentifier:"10.14454/3w3z-sa82" AND relatedIdentifiers.relatedIdentifierType:DOI)'
    )
    expect(url.searchParams.get('resource-type-id')).toBe('software')
    expect(url.searchParams.get('page[size]')).toBe('2')
    expect(url.searchParams.get('page[number]')).toBe('2')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      api_total: 12,
      n_returned: 1,
      page: 2,
      next_page: 3,
      records_truncated: true
    })
  })

  it('handles no hits and the final page without inventing a continuation', async () => {
    expect(
      await mockCall({ data: [], meta: { total: 0 } }).call('datacite_search_records', {
        query: 'absent'
      })
    ).toMatchObject({ records: [], api_total: 0, next_page: null, records_truncated: false })
    expect(
      await mockCall({ data: [record()], meta: { total: 1 } }).call('datacite_search_records', {
        query: 'schema'
      })
    ).toMatchObject({ next_page: null, records_truncated: false })
    expect(
      await mockCall({ data: [record()], meta: { total: 10001 } }).call('datacite_search_records', {
        query: 'schema',
        page_size: 100,
        page: 100
      })
    ).toMatchObject({ next_page: null, records_truncated: true })
  })

  it('rejects invalid paging and missing queries before network access', async () => {
    const { call, fetchImpl } = mockCall({})
    expect(() => call('datacite_search_records', {})).toThrow(/invalid_arguments/)
    expect(() => call('datacite_search_records', { query: 'x', page_size: 101 })).toThrow(
      /invalid_arguments/
    )
    await expect(call('datacite_search_records', { query: ' ', page: 1 })).rejects.toThrow(
      'query or related_doi'
    )
    await expect(
      call('datacite_search_records', { query: 'x', page_size: 100, page: 101 })
    ).rejects.toThrow('10,000')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { data: [], meta: {} },
    { data: [], meta: { total: 2 } },
    { data: [record()], meta: { total: 0 } }
  ])('rejects invalid list envelopes and inconsistent totals', async (payload) => {
    await expect(
      mockCall(payload).call('datacite_search_records', { query: 'x' })
    ).rejects.toThrow()
  })
})

describe.skipIf(!process.env.LIVE_API)('literature / DOI LIVE', () => {
  it.each([
    ['crossref_get_work', { doi: '10.1038/nature12968' }],
    ['crossref_get_updates', { doi: '10.1038/nature12968' }],
    ['datacite_get_record', { doi: '10.14454/qdd3-ps68' }],
    ['datacite_search_records', { query: 'climate', page_size: 2 }]
  ] as const)(
    '%s returns the documented public result',
    async (method, args) => {
      const descriptor = getDescriptor('literature', method)!
      validateToolArguments(descriptor, args)
      const result = (await new ParserEngine().call(descriptor, args, {})) as Record<
        string,
        unknown
      >
      if (method === 'crossref_get_work') expect(result.doi).toBe('10.1038/nature12968')
      if (method === 'crossref_get_updates')
        expect(result.updated_by).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ DOI: '10.1038/nature13598', type: 'retraction' })
          ])
        )
      if (method === 'datacite_get_record')
        expect(result.record).toMatchObject({ doi: '10.14454/qdd3-ps68' })
      if (method === 'datacite_search_records')
        expect(result).toMatchObject({ n_returned: 2, records_truncated: true, next_page: 2 })
    },
    45000
  )
})
