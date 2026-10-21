import { describe, expect, it, vi, type Mock } from 'vitest'
import { createConnectorRegistry, ParserEngine, type ToolDescriptor } from '@aipoch/connector-core'
import { RXNORM_TOOLS } from './rxnorm'
import { DAILYMED_TOOLS } from './dailymed'
import { BIOSAMPLES_TOOLS } from './biosamples'
import { WIKIPATHWAYS_TOOLS } from './wikipathways'
import { CONNECTOR_CATALOG } from './catalog'
import { getConnectorTools } from './registry.test-helper'

const tools = [...RXNORM_TOOLS, ...DAILYMED_TOOLS, ...BIOSAMPLES_TOOLS, ...WIKIPATHWAYS_TOOLS]
const registry = createConnectorRegistry(tools)
async function execute(
  tool: ToolDescriptor,
  body: unknown,
  args = tool.exampleArgs!
): Promise<{ result: unknown; fetchImpl: Mock<typeof fetch> }> {
  registry.validateToolArguments(tool, args)
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body))
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
  return { result, fetchImpl }
}
const meta = { current_page: '1', total_pages: '2', total_elements: '2', next_page: '2' }
const spl = { setid: '9aa7140c-012c-4ea6-866d-4732e915dab6', title: 'EDECRIN' }
const version = { spl_version: '3', published_date: 'Sep 26, 2012' }
const sample = {
  accession: 'SAMD00023550',
  name: 'HB1119',
  characteristics: { organism: [{ text: 'Homo sapiens' }] },
  externalReferences: [{ url: 'https://www.ebi.ac.uk/ena/data/view/SAMD00023550' }],
  update: '2022-03-29T15:00:11.042Z'
}
const bioUrl = 'https://www.ebi.ac.uk/biosamples/samples'
const bio = {
  _embedded: { samples: [sample] },
  _links: {
    self: { href: `${bioUrl}?text=leukaemia&applyCurations=true&size=5&cursor=*` },
    next: {
      href: `${bioUrl}?text=leukaemia&applyCurations=true&size=5&cursor=AoEsU0FNRDAwMDIzNTUx`
    }
  }
}
const pathway = {
  id: 'WP534',
  url: 'https://www.wikipathways.org/instance/WP534',
  name: 'Glycolysis and gluconeogenesis',
  species: 'Homo sapiens',
  revision: '2026-03-21'
}
const info = { ...pathway, authors: 'Community', description: 'Source summary...', citedIn: '123' }

describe('optional research providers', () => {
  it.each(['rxnorm', 'dailymed', 'biosamples', 'wikipathways'])(
    '%s is separately registered and default off',
    (id) => {
      expect(CONNECTOR_CATALOG.find((entry) => entry.id === id)).toMatchObject({
        defaultEnabled: false,
        requiresNcbi: false
      })
      expect(getConnectorTools(id)).toHaveLength(2)
    }
  )

  it.each(tools)(
    '$connector/$id bounds responses and validates examples and required arguments',
    (tool) => {
      expect(tool.credentialKeys).toEqual([])
      expect(tool.maxResponseBytes).toBe(2_000_000)
      expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
      expect(() => registry.validateToolArguments(tool, {})).toThrow()
      expect(() =>
        registry.validateToolArguments(tool, { ...tool.exampleArgs, url: 'http://localhost' })
      ).toThrow()
    }
  )

  it.each([
    [RXNORM_TOOLS[0], { name: '  ' }],
    [RXNORM_TOOLS[0], { name: 'aspirin', search: 9 }],
    [RXNORM_TOOLS[1], { rxcui: '../1' }],
    [DAILYMED_TOOLS[0], { drug_name: 'aspirin', page: 0 }],
    [DAILYMED_TOOLS[0], { drug_name: 'aspirin', page_size: 101 }],
    [DAILYMED_TOOLS[1], { setid: 'not-a-set-id' }],
    [BIOSAMPLES_TOOLS[0], { query: 'leukaemia', cursor: '' }],
    [BIOSAMPLES_TOOLS[0], { query: 'leukaemia', page_size: 101 }],
    [BIOSAMPLES_TOOLS[1], { accession: 'SAMD1/../../' }],
    [WIKIPATHWAYS_TOOLS[0], { query: '  ' }],
    [WIKIPATHWAYS_TOOLS[0], { query: 'glycolysis', limit: 101 }],
    [WIKIPATHWAYS_TOOLS[0], { query: 'glycolysis', offset: -1 }],
    [WIKIPATHWAYS_TOOLS[1], { id: 'WP1?query=x' }]
  ] as const)('rejects invalid arguments for $0.id', (tool, args) => {
    expect(() => registry.validateToolArguments(tool, args)).toThrow(/invalid_arguments/)
  })

  it('preserves ambiguous RxNorm matches and encodes names without broadening active scope', async () => {
    const { result, fetchImpl } = await execute(
      RXNORM_TOOLS[0],
      { idGroup: { rxnormId: ['1', '2'] } },
      { name: 'A&B #drug', search: 2 }
    )
    expect(result).toMatchObject({ search: 2, rxcuis: ['1', '2'] })
    expect(Object.fromEntries(new URL(String(fetchImpl.mock.calls[0][0])).searchParams)).toEqual({
      name: 'A&B #drug',
      allsrc: '0',
      search: '2'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    for (const idGroup of [{}, { rxnormId: null }])
      expect((await execute(RXNORM_TOOLS[0], { idGroup })).result).toMatchObject({ rxcuis: [] })
  })

  it('checks RxCUI identity and distinguishes inactive concepts', async () => {
    const properties = { rxcui: '1191', name: 'aspirin', tty: 'IN', synonym: '', suppress: 'N' }
    expect((await execute(RXNORM_TOOLS[1], { properties })).result).toMatchObject({ properties })
    expect((await execute(RXNORM_TOOLS[1], {})).result).toMatchObject({ properties: null })
    await expect(
      execute(RXNORM_TOOLS[1], { properties: { ...properties, rxcui: '2' } })
    ).rejects.toThrow(/different RxCUI/)
  })

  it('keeps DailyMed dates, versions and explicit page boundaries', async () => {
    const { result, fetchImpl } = await execute(
      DAILYMED_TOOLS[0],
      { metadata: meta, data: [{ ...spl, ...version }] },
      { drug_name: 'A&B', rxcui: '1191', page_size: 1 }
    )
    expect(result).toMatchObject({ data: [{ ...spl, ...version }], next_page: 2 })
    expect(Object.fromEntries(new URL(String(fetchImpl.mock.calls[0][0])).searchParams)).toEqual({
      drug_name: 'A&B',
      rxcui: '1191',
      page: '1',
      pagesize: '1'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      (
        await execute(DAILYMED_TOOLS[0], {
          metadata: { ...meta, total_pages: '0', total_elements: '0', next_page: 'null' },
          data: []
        })
      ).result
    ).toMatchObject({ next_page: null, data: [] })
    await expect(
      execute(DAILYMED_TOOLS[0], { metadata: { ...meta, current_page: '2' }, data: [] })
    ).rejects.toThrow(/unexpected page/)
    await expect(
      execute(DAILYMED_TOOLS[0], { metadata: { ...meta, next_page: '1' }, data: [] })
    ).rejects.toThrow(/invalid next page/)
    await expect(
      execute(
        DAILYMED_TOOLS[0],
        {
          metadata: meta,
          data: [
            { ...spl, ...version },
            { ...spl, ...version }
          ]
        },
        { drug_name: 'x', page_size: 1 }
      )
    ).rejects.toThrow()
  })

  it('accepts current DailyMed numeric fields, non-RFC SET IDs and null archived titles', async () => {
    const metadata = { current_page: 1, total_pages: 1, total_elements: 1, next_page: 'null' }
    const row = {
      ...spl,
      setid: '113e8e06-16f2-9341-e063-6294a90af349',
      ...version,
      spl_version: 3
    }
    expect((await execute(DAILYMED_TOOLS[0], { metadata, data: [row] })).result).toMatchObject({
      data: [row]
    })
    const data = { spl: { ...spl, title: null }, history: [{ ...version, spl_version: 3 }] }
    expect((await execute(DAILYMED_TOOLS[1], { metadata, data })).result).toMatchObject({ data })
  })

  it('preserves DailyMed history and verifies the requested label identity', async () => {
    const data = { spl, history: [version] }
    const { result, fetchImpl } = await execute(DAILYMED_TOOLS[1], {
      metadata: { ...meta, next_page: null },
      data
    })
    expect(result).toMatchObject({ data, next_page: null })
    expect(fetchImpl.mock.calls[0][0]).toContain(`/spls/${spl.setid}/history.json?`)
    await expect(
      execute(DAILYMED_TOOLS[1], {
        metadata: meta,
        data: { ...data, spl: { ...spl, setid: 'fdbfe194-b845-42c5-bb87-a48118bc72e7' } }
      })
    ).rejects.toThrow(/different SET ID/)
  })

  it('preserves BioSamples provenance and follows cursor tokens with unchanged filters', async () => {
    const { result, fetchImpl } = await execute(BIOSAMPLES_TOOLS[0], bio)
    expect(result).toMatchObject({ samples: [sample], next_cursor: 'AoEsU0FNRDAwMDIzNTUx' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('cursor')).toBe('*')
    expect(
      (await execute(BIOSAMPLES_TOOLS[0], { _links: { self: bio._links.self } })).result
    ).toMatchObject({ samples: [], next_cursor: null })
    const { fetchImpl: nextFetch } = await execute(
      BIOSAMPLES_TOOLS[0],
      { ...bio, _links: { self: bio._links.self } },
      { query: 'leukaemia', page_size: 5, cursor: 'a+b/=' }
    )
    expect(new URL(String(nextFetch.mock.calls[0][0])).searchParams.get('cursor')).toBe('a+b/=')
    expect((await execute(BIOSAMPLES_TOOLS[1], sample)).result).toMatchObject({ sample })
    await expect(execute(BIOSAMPLES_TOOLS[1], { ...sample, accession: 'SAMD1' })).rejects.toThrow(
      /different accession/
    )
  })

  it.each([
    bio._links.self.href,
    bio._links.next.href.replace('www.ebi.ac.uk', 'example.org'),
    bio._links.next.href.replace('leukaemia', 'other'),
    bio._links.next.href.replace('size=5', 'size=100')
  ])('rejects non-advancing or changed BioSamples next links: %s', async (href) => {
    await expect(
      execute(BIOSAMPLES_TOOLS[0], { ...bio, _links: { ...bio._links, next: { href } } })
    ).rejects.toThrow(/BioSamples returned/)
  })

  it('filters WikiPathways snapshots locally and returns only one bounded slice', async () => {
    const pathways = [
      pathway,
      { ...pathway, id: 'WP535' },
      { ...pathway, id: 'WP536', species: 'Mus musculus' }
    ]
    const { result, fetchImpl } = await execute(
      WIKIPATHWAYS_TOOLS[0],
      { organisms: [{ pathways }] },
      { query: 'GLYCOLYSIS', species: 'homo sapiens', limit: 1 }
    )
    expect(result).toMatchObject({
      total: 2,
      next_offset: 1,
      pathways: [pathway],
      pagination: 'local_snapshot'
    })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://www.wikipathways.org/json/listPathways.json')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      (
        await execute(
          WIKIPATHWAYS_TOOLS[0],
          { organisms: [{ pathways }] },
          { query: 'WP534', offset: 1 }
        )
      ).result
    ).toMatchObject({ pathways: [], next_offset: null })
    expect((await execute(WIKIPATHWAYS_TOOLS[1], { pathwayInfo: [info] })).result).toMatchObject({
      pathway: info
    })
    expect((await execute(WIKIPATHWAYS_TOOLS[1], { pathwayInfo: [] })).result).toMatchObject({
      pathway: null
    })
    await expect(execute(WIKIPATHWAYS_TOOLS[1], { pathwayInfo: [info, info] })).rejects.toThrow(
      /duplicate/
    )
  })

  it.each(tools)('$connector/$id fails closed on malformed upstream responses', async (tool) => {
    await expect(execute(tool, { unexpected: true })).rejects.toThrow()
  })

  it.each(tools)(
    '$connector/$id propagates HTTP failures, cancellation and byte limits',
    async (tool) => {
      const fetchImpl = vi.fn(
        async () => new Response('', { status: 429, headers: { 'retry-after': '10' } })
      )
      const engine = new ParserEngine({ fetchImpl, retries: 0 })
      await expect(engine.call(tool, tool.exampleArgs!, {})).rejects.toThrow(/429/)
      fetchImpl.mockClear()
      await expect(
        engine.call(tool, tool.exampleArgs!, {}, AbortSignal.abort(new Error('cancelled')))
      ).rejects.toThrow('cancelled')
      expect(fetchImpl).not.toHaveBeenCalled()
      const large = vi.fn(async () => new Response('x'.repeat(2_000_001)))
      await expect(
        new ParserEngine({ fetchImpl: large, retries: 0 }).call(tool, tool.exampleArgs!, {})
      ).rejects.toThrow(/2000000-byte limit/)
    }
  )
})
