import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine } from '@aipoch/connector-core'
import { TCIA_TOOLS } from './tcia'
import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry.test-helper'
const registry = createConnectorRegistry(TCIA_TOOLS)
const row = {
  id: 42113,
  collection_short_title: '4D-Lung',
  collection_title: 'Lung images',
  collection_doi: '10.7937/example',
  data_types: ['CT'],
  cancer_types: ['NSCLC'],
  cancer_locations: ['Lung'],
  collection_downloads: [
    {
      'download url': 'https://example.org/data.tcia',
      'download requirements': { label: 'TCIA Data Retriever' },
      license: { label: 'CC BY 3.0' }
    }
  ]
}
const page = (
  results = [row],
  total = results.length
): {
  page: number
  per_page: number
  total: number
  total_pages: number
  results: (typeof row)[]
} => ({
  page: 1,
  per_page: 20,
  total,
  total_pages: Math.ceil(total / 20),
  results
})
async function call(
  index: number,
  body: unknown,
  args: Record<string, unknown>
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  const tool = TCIA_TOOLS[index]!
  registry.validateToolArguments(tool, args)
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    typeof body === 'string' ? new Response(body) : Response.json(body)
  )
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
  return { result, fetchImpl }
}
describe('TCIA', () => {
  it('is separately registered and default off', () => {
    expect(CONNECTOR_CATALOG.find((x) => x.id === 'tcia')).toMatchObject({
      defaultEnabled: false,
      requiresNcbi: false
    })
    expect(getConnectorTools('tcia')).toHaveLength(3)
  })
  it.each(TCIA_TOOLS)('$id validates the public boundary', (tool) => {
    expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
    expect(() => registry.validateToolArguments(tool, {})).toThrow()
    expect(() =>
      registry.validateToolArguments(tool, { ...tool.exampleArgs, url: 'http://localhost' })
    ).toThrow()
  })
  it('preserves pagination, licenses and downloader requirements', async () => {
    const { result, fetchImpl } = await call(0, page([row], 21), {
      query: 'Lung & CT',
      page_size: 20
    })
    expect(result).toMatchObject({
      total: 21,
      next_page: 2,
      records_truncated: true,
      collections: [{ collection_downloads: row.collection_downloads }]
    })
    const params = new URL(String(fetchImpl.mock.calls[0]![0])).searchParams
    expect(params.get('search')).toBe('Lung & CT')
    expect(params.get('fields')).not.toContain('program')
  })
  it('normalizes TCIA false sentinels for unspecified download requirements', async () => {
    const data = {
      ...row,
      collection_downloads: [
        { ...row.collection_downloads[0], 'download requirements': { label: false, url: false } }
      ]
    }
    const { result } = await call(0, page([data] as unknown as (typeof row)[]), {
      query: 'LIDC-IDRI',
      page_size: 20
    })
    expect(result).toMatchObject({
      collections: [
        { collection_downloads: [{ 'download requirements': { label: null, url: null } }] }
      ]
    })
  })
  it('retains valid TCIA collections with absent modality, download URL and size', async () => {
    const data = {
      ...row,
      data_types: [false],
      collection_downloads: [
        { ...row.collection_downloads[0], 'download url': '', 'download size': [] }
      ]
    }
    const { result } = await call(1, page([data] as unknown as (typeof row)[]), {
      short_title: '4D-Lung'
    })
    expect(result).toMatchObject({
      collection: {
        id: 42113,
        data_types: [],
        collection_downloads: [{ 'download url': null, 'download size': null }]
      }
    })
    for (const malformed of [
      { 'download url': 'javascript:alert(1)' },
      { 'download size': ['unexpected'] }
    ]) {
      const invalid = {
        ...row,
        collection_downloads: [{ ...row.collection_downloads[0], ...malformed }]
      }
      await expect(
        call(1, page([invalid] as unknown as (typeof row)[]), { short_title: '4D-Lung' })
      ).rejects.toThrow()
    }
  })
  it('rejects inconsistent pagination and malformed success responses', async () => {
    await expect(call(0, { ...page(), page: 2 }, { query: 'Lung', page_size: 20 })).rejects.toThrow(
      /inconsistent/
    )
    await expect(call(0, { error: 'upstream' }, { query: 'Lung' })).rejects.toThrow()
    await expect(call(0, '<html>challenge</html>', { query: 'Lung' })).rejects.toThrow()
  })
  it('does not pick the first loosely matching search record', async () => {
    const other = { ...row, id: 2, collection_short_title: 'Other' }
    const { result, fetchImpl } = await call(1, page([other, row]), { short_title: '4d-Lung' })
    expect(result).toMatchObject({ collection: { id: 42113 }, lookup_complete: true })
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.has('include')).toBe(false)
    expect((await call(1, page([other], 100), { short_title: '4D-Lung' })).result).toMatchObject({
      collection: null,
      lookup_complete: false
    })
    await expect(call(1, page([row, row]), { short_title: '4D-Lung' })).rejects.toThrow(/ambiguous/)
  })
  it('distinguishes complete no-match results and bounds per-record lists', async () => {
    expect((await call(1, page([]), { short_title: 'missing' })).result).toMatchObject({
      collection: null,
      lookup_complete: true
    })
    const large = {
      ...row,
      collection_downloads: Array.from({ length: 11 }, () => row.collection_downloads[0])
    }
    const { result } = await call(1, page([large]), { short_title: '4D-Lung' })
    expect(result).toMatchObject({ collection: { details_truncated: true } })
    expect((result as { collection: typeof row }).collection.collection_downloads).toHaveLength(10)
  })
  const series = {
    'Series UID': '1.2.3',
    Collection: '4D-Lung',
    'Subject ID': 'P1',
    'Study UID': '1.2',
    Modality: 'CT',
    'Number of Images': '50',
    'File Size': '26405988'
  }
  it('keeps size and exact series identity, omitting unsolicited fields', async () => {
    expect(
      (await call(2, [{ ...series, unbounded: 'omit' }], { series_uid: '1.2.3' })).result
    ).toEqual({ source_url: expect.any(String), series })
    await expect(
      call(2, [{ ...series, 'Series UID': '1.2.4' }], { series_uid: '1.2.3' })
    ).rejects.toThrow(/different series/)
  })
  it.each(['', '[]'])('recognizes NBIA empty response %j', async (raw) => {
    expect((await call(2, raw, { series_uid: '1.2.3' })).result).toMatchObject({ series: null })
  })
  it.each(['null', '{}', '<html>error</html>'])(
    'rejects malformed NBIA success %j',
    async (raw) => {
      await expect(call(2, raw, { series_uid: '1.2.3' })).rejects.toThrow()
    }
  )
  it('rejects oversized responses before parsing', async () => {
    await expect(call(2, ' '.repeat(2_000_001), { series_uid: '1.2.3' })).rejects.toThrow()
  })
  it.each([
    [0, { query: ' ' }],
    [0, { query: 'x', page_size: 21 }],
    [2, { series_uid: '1.2/../../' }]
  ] as const)('rejects invalid inputs', (index, args) => {
    expect(() => registry.validateToolArguments(TCIA_TOOLS[index]!, args)).toThrow()
  })
})
