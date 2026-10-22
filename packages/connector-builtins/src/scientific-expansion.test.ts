import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectorRegistry, ParserEngine, type ToolDescriptor } from '@aipoch/connector-core'
import { HGNC_TOOLS } from './genes-hgnc'
import { PUBTATOR_TOOLS } from './pubmed-pubtator'
import { DGIDB_TOOLS } from './clinical-genomics-dgidb'
import { RNACENTRAL_TOOLS } from './rna-rnacentral'
import { ORPHADATA_TOOLS } from './orphadata'
import { rateLimitedJson } from './rate-limited-json'

const tools = [
  ...HGNC_TOOLS,
  ...PUBTATOR_TOOLS,
  ...DGIDB_TOOLS,
  ...RNACENTRAL_TOOLS,
  ...ORPHADATA_TOOLS
]
const registry = createConnectorRegistry(tools)
const execute = async (
  tool: ToolDescriptor,
  body: unknown,
  args = tool.exampleArgs!
): Promise<{ result: unknown; fetchImpl: ReturnType<typeof vi.fn> }> => {
  registry.validateToolArguments(tool, args)
  const fetchImpl = vi.fn().mockImplementation(async () => Response.json(body))
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, args, {})
  return { result, fetchImpl }
}
const hgncRecord = {
  hgnc_id: 'HGNC:11998',
  symbol: 'TP53',
  name: 'tumor protein p53',
  status: 'Approved',
  alias_symbol: ['P53'],
  date_modified: '2026-01-01'
}
const hgnc = (docs: unknown[]): Record<string, unknown> => ({
  responseHeader: { status: 0 },
  response: { numFound: docs.length, docs }
})
const bioC = {
  PubTator3: [
    {
      id: '29355051',
      passages: [
        {
          offset: 0,
          text: 'Gene and drug',
          annotations: [
            { id: '1', locations: [{ offset: 0, length: 4 }], infons: { identifier: '1' } }
          ],
          relations: [{ nodes: [{ refid: '1', role: 'subject' }] }]
        }
      ]
    }
  ]
}
const search = {
  results: [{ pmid: 123, title: 'Evidence', text_hl: 'Gene and drug' }],
  page_size: 10,
  current: 2,
  count: 21,
  total_pages: 3
}
const rna = { rnacentral_id: 'URS0000000001', length: 4, sequence: 'ACGU', is_active: false }
const xrefs = {
  count: 3,
  next: 'https://rnacentral.org/api/v1/rna/URS0000000001/xrefs/?page=2',
  previous: null,
  results: [
    {
      upi: rna.rnacentral_id,
      database: 'ENA',
      taxid: 9606,
      first_seen: '2026-01-01',
      accession: { id: 'ABC.1', seq_version: 1 }
    }
  ]
}
const association = {
  drug: { name: 'DRUG', conceptId: 'rxcui:1' },
  interactionScore: 0,
  interactionTypes: [{ type: 'inhibitor', directionality: null }],
  interactionAttributes: [{ name: 'Evidence', value: 'experimental' }],
  publications: [{ pmid: 123 }],
  sources: [{ sourceDbName: 'source', sourceDbVersion: '2026', license: 'CC0', licenseLink: null }]
}
const dgidb = {
  data: {
    genes: {
      pageInfo: { endCursor: 'next', hasNextPage: true },
      nodes: [{ name: 'BRAF', conceptId: 'hgnc:1097', interactions: [association] }]
    }
  }
}
const orpha = (results: unknown): Record<string, unknown> => ({
  data: {
    __count: 1,
    __licence: {
      identifier: 'CC-BY-4.0',
      name: 'Creative Commons Attribution 4.0',
      link: 'https://creativecommons.org/licenses/by/4.0'
    },
    results
  },
  datasetCategory: { name: 'Orphadata', lang: 'en' }
})
const genes = {
  ORPHAcode: 166024,
  Date: '2026-06-23',
  DisorderGeneAssociation: [
    {
      Gene: { Symbol: 'KIF7', ExternalReference: [{ Source: 'HGNC', Reference: '30497' }] },
      DisorderGeneAssociationType: 'Disease-causing germline mutation(s) in',
      DisorderGeneAssociationStatus: 'Assessed',
      SourceOfValidation: '22587682[PMID]'
    }
  ]
}
const phenotypes = {
  Date: '2026-06-23',
  ValidationDate: '2026-01-01',
  Disorder: {
    ORPHAcode: 58,
    HPODisorderAssociation: [
      {
        HPO: { HPOId: 'HP:0000256', HPOTerm: 'Macrocephaly' },
        HPOFrequency: 'Excluded (0%)',
        DiagnosticCriteria: null
      }
    ]
  }
}

afterEach(() => vi.useRealTimers())

describe('scientific data-source contracts', () => {
  it.each(tools)('$connector/$id has a bounded, credential-free schema-valid example', (tool) => {
    expect(tool.credentialKeys).toEqual([])
    expect(tool.maxResponseBytes).toBe(2_000_000)
    expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
    expect(() =>
      registry.validateToolArguments(tool, { ...tool.exampleArgs, unexpected: true })
    ).toThrow()
    expect(() => registry.validateToolArguments(tool, {})).toThrow()
  })

  it.each([
    [HGNC_TOOLS[0], { symbol: '*' }],
    [HGNC_TOOLS[1], { symbol: '../x' }],
    [PUBTATOR_TOOLS[0], { pmids: ['1,2'] }],
    [PUBTATOR_TOOLS[0], { pmids: ['1', '1'] }],
    [PUBTATOR_TOOLS[0], { pmids: Array.from({ length: 11 }, (_, n) => String(n + 1)) }],
    [PUBTATOR_TOOLS[1], { query: ' ', page: 0 }],
    [DGIDB_TOOLS[0], { name: 'BRAF', after: '' }],
    [RNACENTRAL_TOOLS[0], { urs: 'URS0000000001/../../' }],
    [RNACENTRAL_TOOLS[1], { urs: 'URS0000000001', page_size: 101 }],
    [ORPHADATA_TOOLS[0], { orphacode: '58' }],
    [ORPHADATA_TOOLS[1], { orphacode: 0 }]
  ] as const)('rejects invalid input for $0.id', (tool, args) => {
    expect(() => registry.validateToolArguments(tool, args)).toThrow(/invalid_arguments/)
  })

  it('preserves HGNC ambiguity, withdrawn status and modification dates without another fetch', async () => {
    const body = hgnc([hgncRecord, { ...hgncRecord, hgnc_id: 'HGNC:2', status: 'Entry Withdrawn' }])
    const { result, fetchImpl } = await execute(HGNC_TOOLS[1], body)
    expect(result).toMatchObject(body)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://rest.genenames.org/fetch/alias_symbol/P53')
    expect((await execute(HGNC_TOOLS[0], hgnc([]))).result).toMatchObject({
      response: { docs: [] }
    })
    await expect(
      execute(HGNC_TOOLS[0], { ...body, response: { numFound: 3, docs: [] } })
    ).rejects.toThrow(/incomplete/)
  })

  it('retains BioC offsets and relations and identifies missing PMIDs', async () => {
    const { result, fetchImpl } = await execute(PUBTATOR_TOOLS[0], bioC, {
      pmids: ['29355051', '123']
    })
    expect(result).toMatchObject({ ...bioC, missing_pmids: ['123'] })
    expect(fetchImpl.mock.calls[0][0]).toContain(
      '/publications/export/biocjson?pmids=29355051%2C123'
    )
    expect(fetchImpl.mock.calls[0][1].method).toBeUndefined()
    await expect(
      execute(PUBTATOR_TOOLS[0], { PubTator3: [{ ...bioC.PubTator3[0], id: '999' }] })
    ).rejects.toThrow(/unrequested/)
  })

  it('encodes PubTator relation queries, returns one page and does not invent a page-size argument', async () => {
    const args = { query: 'relations:ANY|@CHEMICAL_Doxorubicin|@DISEASE_Neoplasms', page: 2 }
    const { result, fetchImpl } = await execute(PUBTATOR_TOOLS[1], search, args)
    expect(result).toMatchObject({ ...search, next_page: 3 })
    expect(Object.fromEntries(new URL(fetchImpl.mock.calls[0][0]).searchParams)).toEqual({
      text: args.query,
      page: '2'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(execute(PUBTATOR_TOOLS[1], search, { query: 'cancer', page: 1 })).rejects.toThrow(
      /unexpected page/
    )
    expect(
      (
        await execute(PUBTATOR_TOOLS[1], {
          ...search,
          results: [],
          count: 0,
          current: 1,
          total_pages: 0
        })
      ).result
    ).toMatchObject({ next_page: null })
  })

  it('uses GraphQL variables and retains DGIdb evidence and cursors', async () => {
    const { result, fetchImpl } = await execute(DGIDB_TOOLS[0], dgidb, {
      name: 'BRAF"}',
      after: 'previous'
    })
    expect(result).toMatchObject({ ...dgidb.data.genes, next_cursor: 'next' })
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(request.variables).toEqual({ name: 'BRAF"}', after: 'previous' })
    expect(request.query).toContain('genes(names: [$name], first: 1, after: $after)')
    expect(request.query).not.toContain('BRAF')
    const drug = {
      data: { drugs: { pageInfo: { endCursor: null, hasNextPage: false }, nodes: [] } }
    }
    expect((await execute(DGIDB_TOOLS[1], drug)).result).toMatchObject({
      nodes: [],
      next_cursor: null
    })
    await expect(
      execute(DGIDB_TOOLS[0], { ...dgidb, errors: [{ message: 'partial failure' }] })
    ).rejects.toThrow(/GraphQL errors/)
    await expect(execute(DGIDB_TOOLS[0], dgidb, { name: 'BRAF', after: 'next' })).rejects.toThrow(
      /non-advancing/
    )
  })

  it('pins RNAcentral v1, retains obsolete records and pages cross-database mappings', async () => {
    expect((await execute(RNACENTRAL_TOOLS[0], rna)).result).toMatchObject({
      api_version: 'v1',
      record: rna
    })
    const { result, fetchImpl } = await execute(RNACENTRAL_TOOLS[1], xrefs, {
      urs: rna.rnacentral_id,
      page_size: 2,
      page: 1
    })
    expect(result).toMatchObject({ ...xrefs, next_page: 2 })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://rnacentral.org/api/v1/rna/URS0000000001/xrefs/?format=json&page=1&page_size=2'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      (await execute(RNACENTRAL_TOOLS[1], { ...xrefs, next: null, results: [], count: 0 })).result
    ).toMatchObject({ next_page: null })
    await expect(
      execute(RNACENTRAL_TOOLS[0], { ...rna, rnacentral_id: 'URS0000000002' })
    ).rejects.toThrow(/different accession/)
  })

  it('preserves Orphadata dates, validation sources, licensing and excluded frequency', async () => {
    for (const [tool, payload, route] of [
      [ORPHADATA_TOOLS[0], genes, 'rd-associated-genes'],
      [ORPHADATA_TOOLS[1], phenotypes, 'rd-phenotypes']
    ] as const) {
      const body = orpha(payload)
      const { result, fetchImpl } = await execute(tool, body)
      expect(result).toMatchObject({
        ...body,
        source: 'Orphadata / Orphanet',
        api_version: '1.0.0'
      })
      expect(fetchImpl.mock.calls[0][0]).toContain(`${route}/orphacodes/`)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
    await expect(execute(ORPHADATA_TOOLS[0], orpha({ ...genes, ORPHAcode: 999 }))).rejects.toThrow(
      /different ORPHAcode/
    )
  })

  it.each(tools)('$connector/$id rejects malformed responses', async (tool) => {
    await expect(execute(tool, { unexpected: [] })).rejects.toThrow()
  })

  it.each(tools)(
    '$connector/$id propagates HTTP 404 and cancellation before dispatch',
    async (tool) => {
      const fetchImpl = vi.fn().mockImplementation(async () => new Response('', { status: 404 }))
      const engine = new ParserEngine({ fetchImpl, retries: 0 })
      await expect(engine.call(tool, tool.exampleArgs!, {})).rejects.toThrow(/404/)
      fetchImpl.mockClear()
      await expect(
        engine.call(tool, tool.exampleArgs!, {}, AbortSignal.abort(new Error('cancelled')))
      ).rejects.toThrow('cancelled')
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('spaces concurrent requests and cancels queued requests without consuming a future slot', async () => {
    vi.useFakeTimers()
    const read = rateLimitedJson(334)
    const ctx = {
      fetchText: vi.fn().mockResolvedValue('{}'),
      credentials: {}
    } as unknown as Parameters<typeof read>[0]
    const abort = new AbortController()
    const first = read(ctx, 'https://example.org/1')
    const cancelled = read({ ...ctx, signal: abort.signal }, 'https://example.org/2')
    const rejection = expect(cancelled).rejects.toThrow('cancelled')
    const third = read(ctx, 'https://example.org/3')
    const fourth = read(ctx, 'https://example.org/4')
    abort.abort(new Error('cancelled'))
    await rejection
    await first
    expect(ctx.fetchText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(333)
    expect(ctx.fetchText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await third
    expect(ctx.fetchText).toHaveBeenCalledTimes(2)
    expect(ctx.fetchText).toHaveBeenLastCalledWith('https://example.org/3', 'application/json', {
      retry: false
    })
    await vi.advanceTimersByTimeAsync(333)
    expect(ctx.fetchText).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await fourth
    expect(ctx.fetchText).toHaveBeenCalledTimes(3)
    expect(ctx.fetchText).toHaveBeenLastCalledWith('https://example.org/4', 'application/json', {
      retry: false
    })
  })

  it.each(tools)(
    '$connector/$id aborts in-flight transport and rejects oversized bodies',
    async (tool) => {
      const controller = new AbortController()
      const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
        controller.abort(new Error('cancelled in flight'))
        init.signal.throwIfAborted()
      })
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(
          tool,
          tool.exampleArgs!,
          {},
          controller.signal
        )
      ).rejects.toThrow('cancelled in flight')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const large = vi.fn().mockImplementation(async () => new Response('x'.repeat(2_000_001)))
      await expect(
        new ParserEngine({ fetchImpl: large, retries: 0 }).call(tool, tool.exampleArgs!, {})
      ).rejects.toThrow(/2000000-byte limit/)
      expect(large).toHaveBeenCalledTimes(1)
    }
  )

  it('does not retry rate-limited providers behind their admission gate', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(
        async () => new Response('', { status: 429, headers: { 'retry-after': '10' } })
      )
    await expect(
      new ParserEngine({ fetchImpl }).call(PUBTATOR_TOOLS[1], { query: 'cancer' }, {})
    ).rejects.toThrow(/429.*Retry after 10s/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
