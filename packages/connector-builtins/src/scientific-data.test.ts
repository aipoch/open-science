import { describe, expect, it, vi } from 'vitest'
import { createConnectorRegistry, ParserEngine, type ToolDescriptor } from '@aipoch/connector-core'
import { EUROPEPMC_TOOLS } from './literature-europepmc'
import { RESEARCH_DATASET_TOOLS } from './research-datasets'
import { MOLECULAR_DATA_TOOLS } from './molecular-data'
import { HGNC_TOOLS } from './genes-hgnc'
import { officialFileLinks } from './official-file-links'

const tools = [
  ...EUROPEPMC_TOOLS,
  ...RESEARCH_DATASET_TOOLS,
  ...MOLECULAR_DATA_TOOLS,
  ...HGNC_TOOLS
]
const registry = createConnectorRegistry(tools)
const descriptor = (connector: string, id: string): ToolDescriptor =>
  registry.getDescriptor(connector, id)!
async function execute(
  connector: string,
  id: string,
  body: unknown,
  args?: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; fetchImpl: ReturnType<typeof vi.fn<typeof fetch>> }> {
  const tool = descriptor(connector, id)
  const input = args ?? tool.exampleArgs!
  registry.validateToolArguments(tool, input)
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    typeof body === 'string' ? new Response(body) : Response.json(body)
  )
  const result = await new ParserEngine({ fetchImpl, retries: 0 }).call(tool, input, {
    ncbiApiKey: 'secret-sentinel',
    ncbiEmail: 'private-sentinel'
  })
  return { result: result as Record<string, unknown>, fetchImpl }
}

describe('native scientific data contracts', () => {
  it.each(tools)(
    '$connector/$id has a valid example and no Python or credential prerequisite',
    (tool) => {
      expect(() => registry.validateToolArguments(tool, tool.exampleArgs!)).not.toThrow()
      expect(tool.credentialKeys).toEqual([])
      expect(tool.requiredCredential).toBeUndefined()
      expect(tool.returns).toBeTruthy()
    }
  )

  it.each(['nhanes', 'charls', 'chns', 'seer', 'mimic', 'eicu', 'faers', 'gbd'])(
    'returns declared %s access guidance without a network request or authorization claim',
    async (dataset) => {
      const { result, fetchImpl } = await execute('research-datasets', 'get_dataset_access', null, {
        dataset
      })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(result.authorization_verified).toBe(false)
      expect(result.live_verified).toBe(false)
      expect(result.source_url).toMatch(/^https:/)
    }
  )

  it('preserves Europe PMC query, core abstract and cursor without forwarding NCBI credentials', async () => {
    const { result, fetchImpl } = await execute(
      'europepmc',
      'search_europepmc',
      {
        hitCount: 23,
        nextCursorMark: 'next-token',
        resultList: { result: [{ id: '123', abstractText: 'Actual available abstract' }] }
      },
      { query: 'TP53 AND "liver fibrosis"', cursor: 'opaque+cursor', page_size: 2 }
    )
    const url = new URL(String(fetchImpl.mock.calls[0][0]))
    expect(url.searchParams.get('query')).toBe('TP53 AND "liver fibrosis"')
    expect(url.searchParams.get('cursorMark')).toBe('opaque+cursor')
    expect(url.searchParams.get('resultType')).toBe('core')
    expect(url.href).not.toContain('sentinel')
    expect(result).toMatchObject({
      total_count: 23,
      returned_count: 1,
      next_cursor: 'next-token',
      continuation_available: true
    })
    expect(result.records).toMatchObject([{ abstractText: 'Actual available abstract' }])
  })

  it('rejects malformed Europe PMC responses and blank queries', async () => {
    await expect(execute('europepmc', 'search_europepmc', {})).rejects.toThrow()
    await expect(execute('europepmc', 'search_europepmc', {}, { query: '  ' })).rejects.toThrow(
      'blank'
    )
  })

  it('discovers NHANES data and real documentation links, excluding script/comment/external links', async () => {
    const html = `<script><a href="/nchs/evil.XPT">ignored</a></script><!-- <a href="/nchs/comment.XPT"> -->
      <a data-href="/nchs/fake.XPT" title="href='fake.XPT'">not a link</a>
      <a title="value > text" href='/nchs/data/DEMO_J.XPT'>data</a><a href="/nchs/nhanes/2017-2018/DEMO_J.htm">docs</a>
      <a href="https://example.org/nchs/external.XPT">external</a><a href="/nchs/data/DEMO_J.XPT">duplicate</a>`
    const { result } = await execute('research-datasets', 'list_nhanes_files', html)
    expect(result.files).toEqual([
      {
        filename: 'DEMO_J.XPT',
        url: 'https://wwwn.cdc.gov/nchs/data/DEMO_J.XPT',
        documentation_url: 'https://wwwn.cdc.gov/nchs/nhanes/2017-2018/DEMO_J.htm'
      }
    ])
  })

  it.each(['<title>Just a moment...</title>', '<html>No download links</html>'])(
    'does not call a challenge or changed page an empty dataset',
    async (html) => {
      await expect(execute('research-datasets', 'list_nhanes_files', html)).rejects.toThrow()
    }
  )

  it('keeps PhysioNet discovery within the chosen public demo and supports child directories', async () => {
    const { result, fetchImpl } = await execute(
      'research-datasets',
      'list_physionet_demo_files',
      '<a href="../">parent</a><a href="hosp/">hosp</a><a href="https://physionet.org/files/mimiciv/3.1/patients.csv.gz">full</a>',
      { dataset: 'mimic' }
    )
    expect(result.files).toEqual([
      {
        filename: 'hosp',
        url: 'https://physionet.org/files/mimic-iv-demo/2.2/hosp/',
        directory: true
      }
    ])
    expect(result.full_data_authorized).toBe(false)
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://physionet.org/files/mimic-iv-demo/2.2/'
    )
    await expect(
      execute('research-datasets', 'list_physionet_demo_files', '', {
        dataset: 'eicu',
        directory: 'hosp'
      })
    ).rejects.toThrow('root only')
  })

  it('paginates the public drug/event partition manifest and rejects unexpected file authorities', async () => {
    const payload = (file: string): unknown => ({
      results: {
        drug: {
          event: {
            partitions: [
              { file },
              { file: 'https://download.open.fda.gov/drug/event/part-2.json.zip' }
            ]
          }
        }
      }
    })
    const { result } = await execute(
      'drug-regulatory',
      'list_faers_bulk_files',
      payload('https://download.open.fda.gov/drug/event/part-1.json.zip'),
      { limit: 1 }
    )
    expect(result).toMatchObject({ total_files: 2, returned_count: 1, next_offset: 1 })
    await expect(
      execute('drug-regulatory', 'list_faers_bulk_files', payload('https://example.org/part.zip'))
    ).rejects.toThrow('Unexpected')
  })

  it('labels CTD file references as a maintained, unverified subset', async () => {
    const { result, fetchImpl } = await execute('ctd', 'list_ctd_reports', null)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result).toMatchObject({ live_verified: false, catalog_scope: 'maintained_subset' })
    expect(result.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ filename: 'CTD_pathways.tsv.gz' })])
    )
  })

  it('retains per-library ChEA3 ranking and unknown recognized input count', async () => {
    const { result, fetchImpl } = await execute(
      'chea3',
      'rank_transcription_factors',
      { A: [{ TF: 'TP53' }, { TF: 'STAT1' }] },
      { genes: ['TP53', 'TP53'], top_n: 1 }
    )
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).gene_set).toEqual(['TP53'])
    expect(result.recognized_gene_count).toBeNull()
    expect(result.libraries).toMatchObject({ A: { total_records: 2, truncated: true } })
  })

  it('does not retry the ChEA3 POST on a transient HTTP failure', async () => {
    const tool = descriptor('chea3', 'rank_transcription_factors')
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('unavailable', { status: 503 }))
    await expect(
      new ParserEngine({ fetchImpl, retries: 2 }).call(tool, tool.exampleArgs!, {})
    ).rejects.toThrow('HTTP 503')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('preserves ambiguous bioDBnet outputs and treats upstream error objects as errors', async () => {
    const { result, fetchImpl } = await execute('biodbnet', 'convert_ids', [
      { 'Gene Symbol': 'TP53', 'Gene ID': '7157; other' }
    ])
    expect(result.result).toMatchObject([{ 'Gene ID': '7157; other' }])
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('inputValues')).toBe('TP53')
    await expect(
      execute('biodbnet', 'convert_ids', [{ Error: 'Invalid input node' }])
    ).rejects.toThrow('error response')
  })

  it('retains HGNC field ambiguity, service metadata and file provenance', async () => {
    const info = await execute('genes', 'get_hgnc_service_info', { searchableFields: ['symbol'] })
    expect(info.result.service).toMatchObject({ searchableFields: ['symbol'] })
    const found = await execute(
      'genes',
      'query_hgnc_field',
      { response: { numFound: 2, docs: [{ symbol: 'A' }, { symbol: 'B' }] } },
      { field: 'prev_symbol', value: 'OLD', max_rows: 1 }
    )
    expect(found.result).toMatchObject({ num_found: 2, truncated: true })
    const files = await execute('genes', 'list_hgnc_files', {
      kind: 'storage#objects',
      items: [
        {
          name: 'hgnc/tsv/tsv/hgnc_complete_set.txt',
          size: '100',
          etag: 'identity',
          md5Hash: 'declared'
        }
      ],
      nextPageToken: 'next'
    })
    expect(files.result.next_cursor).toBe('next')
    expect(files.result.files).toMatchObject([
      {
        bytes: '100',
        md5_base64: 'declared',
        etag: 'identity'
      }
    ])
    expect(files.result.checksum_note).toContain('no file was downloaded')
  })

  it('bounds SPARQL results while rejecting remote datasets, updates and blank input', async () => {
    const { result, fetchImpl } = await execute(
      'cellosaurus',
      'query_knowledge_graph',
      {
        head: { vars: ['s'] },
        results: {
          bindings: [{ s: { type: 'uri', value: 'a' } }, { s: { type: 'uri', value: 'b' } }]
        }
      },
      { query: 'PREFIX x: <https://example.org/> SELECT ?s WHERE { ?s a x:Cell }', max_rows: 1 }
    )
    expect(result.truncated).toBe(true)
    expect(result.records).toHaveLength(1)
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      accept: 'application/sparql-results+json'
    })
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('query')).toContain(
      'LIMIT 2'
    )
    for (const query of [
      'SELECT * WHERE { SERVICE <https://example.org> {?s ?p ?o} }',
      'DELETE WHERE {?s ?p ?o}',
      'SELECT * FROM <https://example.org> WHERE {?s ?p ?o}'
    ]) {
      await expect(execute('cellosaurus', 'query_knowledge_graph', {}, { query })).rejects.toThrow(
        'local-graph'
      )
    }
  })

  it.each([
    'SELECT ?s WHERE { ?s ?p "derived from liver" }',
    "SELECT ?s WHERE { ?s ?p 'SERVICE FROM' }",
    'SELECT ?s WHERE { ?s ?p """first line\nFROM liver # literal\nlast line""" }',
    "SELECT ?s WHERE { ?s ?p '''first line\nSERVICE description''' }",
    'SELECT ?s WHERE { ?s ?p "escaped \\" FROM" }',
    'PREFIX x: <https://example.org/FROM#SERVICE> SELECT ?from WHERE { ?from x:from ?service } # FROM ignored'
  ])('allows keywords in SPARQL data without rewriting it: %s', async (query) => {
    const { fetchImpl } = await execute(
      'cellosaurus',
      'query_knowledge_graph',
      { head: { vars: ['s'] }, results: { bindings: [] } },
      { query }
    )
    const sent = new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('query')!
    expect(sent).toContain(
      query.replace(/^PREFIX\s+\w+:\s*<[^>]+>\s*/, '').split(' # FROM ignored')[0]
    )
    if (query.startsWith('PREFIX')) expect(sent).toContain('<https://example.org/FROM#SERVICE>')
    expect(sent).toContain('LIMIT 21')
  })

  it.each([
    'SELECT ?s WHERE { ?s ?p "SERVICE" . SERVICE <https://example.org/> { ?s ?p ?o } }',
    'SELECT ?s FROM <https://example.org/FROM> WHERE { ?s ?p "FROM" }',
    'SELECT ?s WHERE { # ignored\n SERVICE <https://example.org/> { ?s ?p ?o } }'
  ])('still rejects actual SPARQL federation/datasets: %s', async (query) => {
    await expect(execute('cellosaurus', 'query_knowledge_graph', {}, { query })).rejects.toThrow(
      'local-graph'
    )
  })

  it('rejects CLASTR responses with no accepted loci or partially ignored input', async () => {
    await expect(
      execute(
        'cellosaurus',
        'search_str_similarity',
        {
          parameters: { markers: [] },
          results: []
        },
        { markers: { UNKNOWN: '12' } }
      )
    ).rejects.toThrow('did not recognize')
    await expect(
      execute(
        'cellosaurus',
        'search_str_similarity',
        {
          parameters: { markers: [{ name: 'D5S818' }] },
          results: []
        },
        { markers: { D5S818: '12', UNKNOWN: '13' } }
      )
    ).rejects.toThrow('ignored submitted STR markers: UNKNOWN')
    await expect(execute('cellosaurus', 'search_str_similarity', {})).rejects.toThrow()
  })

  it('preserves valid CLASTR matches and genuine zero-match results', async () => {
    for (const results of [[], [{ accession: 'CVCL_6341', bestScore: 100 }]]) {
      const payload = {
        parameters: { markers: [{ name: 'D5S818', alleles: [{ value: '12' }] }] },
        results
      }
      const { result } = await execute('cellosaurus', 'search_str_similarity', payload, {
        markers: { D5S818: '12' },
        min_markers: 1
      })
      expect(result.result).toEqual(payload)
    }
  })

  it('rejects HTML RDF responses and prevents STR marker option smuggling', async () => {
    await expect(
      execute('cellosaurus', 'get_cell_line_rdf', '<!DOCTYPE html><html>challenge</html>')
    ).rejects.toThrow('RDF')
    await expect(
      execute('cellosaurus', 'search_str_similarity', {}, { markers: { species: '12' } })
    ).rejects.toThrow('replace CLASTR options')
  })

  it('rejects credential fields and invalid identifier batches before dispatch', () => {
    expect(() =>
      registry.validateToolArguments(descriptor('research-datasets', 'get_dataset_access'), {
        dataset: 'charls',
        cookie: 'secret'
      })
    ).toThrow()
    expect(() =>
      registry.validateToolArguments(descriptor('biodbnet', 'convert_ids'), {
        input_type: 'genesymbol',
        values: ['TP53,MYC'],
        outputs: ['geneid']
      })
    ).toThrow()
  })
})

describe('official anchor file references', () => {
  it('ignores signed, credential-bearing and insecure links without inventing a replacement', () => {
    const html =
      '<a href="http://official.test/a.txt">a</a><a href="https://u:p@official.test/a.txt">b</a><a href="https://official.test/a.txt?token=secret">c</a>'
    expect(() => officialFileLinks(html, 'https://official.test/', () => true)).toThrow(
      'No supported'
    )
  })
})
