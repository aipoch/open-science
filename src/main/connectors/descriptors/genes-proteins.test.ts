import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_PROTEINS_TOOLS } from './genes-proteins'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response
const statusRes = (status: number): Response => ({ ok: false, status }) as Response

const tool = (id: string): (typeof GENES_PROTEINS_TOOLS)[number] => {
  const t = GENES_PROTEINS_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({ fetchImpl: fetchImpl as unknown as typeof fetch }).call(tool(id), args, {})

describe('search_uniprot_entries', () => {
  const entry = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    primaryAccession: 'P04637',
    entryType: 'UniProtKB reviewed (Swiss-Prot)',
    uniProtkbId: 'P53_HUMAN',
    proteinDescription: {
      recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } },
      alternativeNames: [{ fullName: { value: 'Tumor suppressor p53' } }]
    },
    genes: [{ geneName: { value: 'TP53' }, synonyms: [{ value: 'P53' }] }],
    organism: { taxonId: 9606, scientificName: 'Homo sapiens' },
    sequence: { length: 393 },
    ...patch
  })
  const response = (
    results: unknown[] = [entry()],
    headers: Record<string, string> = {}
  ): Response => new Response(JSON.stringify({ results }), { headers })
  const nextLink = (cursor = 'next-token'): string =>
    `<https://rest.uniprot.org/uniprotkb/search?fields=accession,id&cursor=${encodeURIComponent(cursor)}>; rel="next"`

  it('combines structured filters, preserves metadata and makes one bounded request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(undefined, {
        'x-total-results': '1',
        'x-uniprot-release': '2026_03'
      })
    )
    const out = await run(
      'search_uniprot_entries',
      {
        gene: ' TP53 ',
        protein_name: 'tumor antigen',
        organism_id: 9606,
        reviewed: true,
        page_size: 10
      },
      fetchImpl
    )
    expect(out).toEqual({
      filters: { gene: 'TP53', protein_name: 'tumor antigen', organism_id: 9606, reviewed: true },
      query:
        'active:true AND gene_exact:"TP53" AND protein_name:"tumor antigen" AND organism_id:9606 AND reviewed:true',
      page_size: 10,
      n_records: 1,
      total_results: 1,
      has_more: false,
      next_cursor: null,
      release: '2026_03',
      records: [
        {
          accession: 'P04637',
          entry_name: 'P53_HUMAN',
          reviewed: true,
          protein_names: ['Cellular tumor antigen p53', 'Tumor suppressor p53'],
          gene_names: ['TP53', 'P53'],
          organism_id: 9606,
          organism_name: 'Homo sapiens',
          length: 393
        }
      ]
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://rest.uniprot.org/uniprotkb/search')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      size: '10',
      sort: 'accession asc',
      format: 'json'
    })
    expect(url.searchParams.get('fields')).toBe(
      'accession,id,reviewed,protein_name,gene_names,organism_id,organism_name,length'
    )
    expect(url.searchParams.has('cursor')).toBe(false)
  })

  it.each([{ gene: 'Trp53' }, { protein_name: 'kinase' }, { organism_id: 10090 }])(
    'accepts a standalone filter without human or reviewed defaults: %j',
    async (args) => {
      const fetchImpl = vi.fn().mockResolvedValue(response([]))
      await expect(run('search_uniprot_entries', args, fetchImpl)).resolves.toMatchObject({
        page_size: 25,
        n_records: 0,
        total_results: null,
        has_more: false,
        next_cursor: null
      })
      const query = new URL(fetchImpl.mock.calls[0][0]).searchParams.get('query')!
      expect(query).not.toContain('9606')
      expect(query).not.toContain('reviewed:')
    }
  )

  it('retains unreviewed submitted names, multiple genes and missing optional metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response([
        entry({
          entryType: 'UniProtKB unreviewed (TrEMBL)',
          proteinDescription: { submissionNames: [{ fullName: { value: 'Submitted name' } }] },
          genes: [
            {
              geneName: { value: 'A' },
              synonyms: [{ value: 'A' }],
              orderedLocusNames: [{ value: 'locus1' }]
            },
            { geneName: { value: 'B' }, orfNames: [{ value: 'orf1' }] }
          ],
          organism: undefined,
          sequence: undefined,
          uniProtkbId: undefined
        })
      ])
    )
    await expect(
      run('search_uniprot_entries', { organism_id: 10090, reviewed: false }, fetchImpl)
    ).resolves.toMatchObject({
      filters: { reviewed: false },
      records: [
        {
          reviewed: false,
          entry_name: null,
          protein_names: ['Submitted name'],
          gene_names: ['A', 'locus1', 'B', 'orf1'],
          organism_id: null,
          organism_name: null,
          length: null
        }
      ]
    })
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('query')).toContain(
      'reviewed:false'
    )
  })

  it('represents absent names as empty arrays', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response([entry({ genes: undefined, proteinDescription: undefined })]))
    await expect(run('search_uniprot_entries', { gene: 'TP53' }, fetchImpl)).resolves.toMatchObject(
      {
        records: [{ gene_names: [], protein_names: [] }]
      }
    )
  })

  it('returns an opaque next cursor and rebuilds the next request without fetching the Link URL', async () => {
    const cursor = 'opaque+/token=='
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(undefined, { link: nextLink(cursor), 'x-total-results': '2' })
      )
      .mockResolvedValueOnce(
        response([entry({ primaryAccession: 'P38398' })], { 'x-total-results': '2' })
      )
    const args = { organism_id: 9606, page_size: 1 }
    const first = (await run('search_uniprot_entries', args, fetchImpl)) as { next_cursor: string }
    expect(first).toMatchObject({
      next_cursor: cursor,
      has_more: true,
      n_records: 1,
      total_results: 2
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(
      run('search_uniprot_entries', { ...args, cursor: first.next_cursor }, fetchImpl)
    ).resolves.toMatchObject({ has_more: false, next_cursor: null })
    const firstUrl = new URL(fetchImpl.mock.calls[0][0])
    const secondUrl = new URL(fetchImpl.mock.calls[1][0])
    expect(secondUrl.searchParams.get('cursor')).toBe(cursor)
    secondUrl.searchParams.delete('cursor')
    expect(secondUrl.toString()).toBe(firstUrl.toString())
  })

  it.each(['a', '𠮷', '😀'])(
    'uses Unicode code points for both text filters: %s',
    async (character) => {
      for (const field of ['gene', 'protein_name']) {
        const fetchImpl = vi.fn().mockResolvedValue(response([]))
        await expect(
          run('search_uniprot_entries', { [field]: character.repeat(200) }, fetchImpl)
        ).resolves.toMatchObject({ n_records: 0 })
        fetchImpl.mockClear()
        await expect(
          run('search_uniprot_entries', { [field]: character.repeat(201) }, fetchImpl)
        ).rejects.toThrow(/200 Unicode/)
        expect(fetchImpl).not.toHaveBeenCalled()
      }
    }
  )

  it.each([
    {},
    { reviewed: true },
    { gene: '' },
    { gene: '   ' },
    { gene: '\u3000' },
    { gene: '\u00a0' },
    { gene: 'TP53" OR reviewed:true' },
    { gene: 'TP*' },
    { gene: 'TP?' },
    { gene: 'TP\\53' },
    { gene: 'TP\n53' },
    { protein_name: false },
    { organism_id: '9606' },
    { organism_id: 0 },
    { organism_id: 2.5 },
    { organism_id: 2147483648 },
    { gene: 'A', reviewed: 'false' },
    { gene: 'A', page_size: 0 },
    { gene: 'A', page_size: 501 },
    { gene: 'A', page_size: '1' },
    { gene: 'A', cursor: '' },
    { gene: 'A', cursor: 'has space' },
    { gene: 'A', cursor: 'x'.repeat(4097) }
  ])('rejects invalid executor arguments before HTTP: %j', async (args) => {
    const fetchImpl = vi.fn()
    await expect(run('search_uniprot_entries', args, fetchImpl)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    {},
    { results: null },
    { results: [null] },
    { results: [{}] },
    { results: [entry(), entry()] },
    { results: [entry({ primaryAccession: 'invalid' })] },
    { results: [entry({ entryType: 'inactive' })] },
    { results: [entry({ genes: {} })] },
    { results: [entry({ proteinDescription: 'wrong' })] },
    { results: [entry({ organism: { taxonId: '9606' } })] },
    { results: [entry({ sequence: { length: -1 } })] }
  ])('rejects malformed response data: %j', async (body) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
    await expect(run('search_uniprot_entries', { gene: 'TP53' }, fetchImpl)).rejects.toThrow(
      /Invalid UniProt search response/
    )
  })

  it.each([
    { entryType: ['UniProtKB reviewed (Swiss-Prot)'] },
    { entryType: ['UniProtKB unreviewed (TrEMBL)'] },
    { entryType: [['UniProtKB reviewed (Swiss-Prot)']] },
    { entryType: [['UniProtKB unreviewed (TrEMBL)']] },
    { entryType: null },
    { entryType: undefined },
    { entryType: 1 },
    { entryType: true },
    { entryType: {} }
  ])('rejects non-string entryType without coercing it: %j', async (patch) => {
    const fetchImpl = vi.fn().mockResolvedValue(response([entry(patch)]))
    await expect(
      run('search_uniprot_entries', { gene: 'TP53', reviewed: true }, fetchImpl)
    ).rejects.toThrow('Invalid UniProt search response: missing or invalid entryType')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects more rows than requested', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response([entry(), entry({ primaryAccession: 'P38398' })]))
    await expect(
      run('search_uniprot_entries', { organism_id: 9606, page_size: 1 }, fetchImpl)
    ).rejects.toThrow(/oversized/)
  })

  it.each<Record<string, string>>([
    { 'x-total-results': '-1' },
    { 'x-total-results': '0' },
    { 'x-total-results': '1.5' },
    { 'x-total-results': '9007199254740992' },
    { 'x-total-results': '2' },
    { link: 'not-a-link' },
    { link: '<https://evil.example/search?cursor=x>; rel="next"' },
    { link: '<https://rest.uniprot.org/other?cursor=x>; rel="next"' },
    { link: '<http://rest.uniprot.org/uniprotkb/search?cursor=x>; rel="next"' },
    { link: '<https://rest.uniprot.org/uniprotkb/search>; rel="next"' },
    { link: nextLink('current') },
    { link: nextLink() + ', ' + nextLink('another') }
  ])('rejects broken pagination metadata: %j', async (headers) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(undefined, headers))
    const args =
      headers.link === nextLink('current') ? { gene: 'TP53', cursor: 'current' } : { gene: 'TP53' }
    await expect(run('search_uniprot_entries', args, fetchImpl)).rejects.toThrow(
      /Invalid UniProt search response/
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty page with a continuation cursor', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([], { link: nextLink() }))
    await expect(run('search_uniprot_entries', { gene: 'TP53' }, fetchImpl)).rejects.toThrow(
      /empty page/
    )
  })

  it.each([400, 404, 429, 500])(
    'propagates HTTP %i without treating it as an empty search',
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('{}', { status }))
      await expect(
        new ParserEngine({ fetchImpl, retries: 0 }).call(
          tool('search_uniprot_entries'),
          { gene: 'TP53' },
          {}
        )
      ).rejects.toThrow(`HTTP ${status}`)
    }
  )

  it('does not cache empty results', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response())
    const args = { gene: 'TP53' }
    await expect(run('search_uniprot_entries', args, fetchImpl)).resolves.toMatchObject({
      n_records: 0
    })
    await expect(run('search_uniprot_entries', args, fetchImpl)).resolves.toMatchObject({
      n_records: 1
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe.skipIf(!process.env.LIVE_API)('UniProt live discovery', () => {
  it('searches a protein-name phrase independently of a gene filter', async () => {
    const out = (await new ParserEngine().call(
      tool('search_uniprot_entries'),
      {
        protein_name: 'tumor antigen p53',
        organism_id: 9606,
        reviewed: true
      },
      {}
    )) as { records: Array<{ accession: string }> }
    expect(out.records.some((row) => row.accession === 'P04637')).toBe(true)
  }, 120_000)

  it('discovers reviewed human TP53 and passes its accession to existing FASTA retrieval', async () => {
    const engine = new ParserEngine()
    const out = (await engine.call(
      tool('search_uniprot_entries'),
      { gene: 'TP53', organism_id: 9606, reviewed: true },
      {}
    )) as { records: Array<{ accession: string }> }
    expect(out.records).toEqual([
      expect.objectContaining({
        accession: 'P04637',
        reviewed: true,
        organism_id: 9606,
        length: 393
      })
    ])
    await expect(
      engine.call(
        tool('get_uniprot_entries'),
        { accessions: [out.records[0].accession], format: 'fasta' },
        {}
      )
    ).resolves.toMatchObject({
      n_found: 1,
      missing: [],
      records: { P04637: expect.stringContaining('>sp|P04637|') }
    })
  }, 120_000)

  it('discovers mouse Trp53 without a human default', async () => {
    const out = (await new ParserEngine().call(
      tool('search_uniprot_entries'),
      { gene: 'Trp53', organism_id: 10090, reviewed: true },
      {}
    )) as { records: unknown[] }
    expect(out.records).toEqual([
      expect.objectContaining({ accession: 'P02340', organism_id: 10090, reviewed: true })
    ])
  }, 120_000)

  it('continues an unreviewed mouse search using the returned cursor', async () => {
    const engine = new ParserEngine()
    const args = { organism_id: 10090, reviewed: false, page_size: 2 }
    type Page = {
      next_cursor: string
      records: Array<{ accession: string; reviewed: boolean; protein_names: string[] }>
    }
    const first = (await engine.call(tool('search_uniprot_entries'), args, {})) as Page
    expect(first.next_cursor).toBeTruthy()
    expect(first.records).toHaveLength(2)
    const second = (await engine.call(
      tool('search_uniprot_entries'),
      { ...args, cursor: first.next_cursor },
      {}
    )) as Page
    expect(second.records).toHaveLength(2)
    expect(
      [...first.records, ...second.records].every(
        (row) => !row.reviewed && row.protein_names.length > 0
      )
    ).toBe(true)
    expect(new Set([...first.records, ...second.records].map((row) => row.accession)).size).toBe(4)
  }, 120_000)
})

describe('query_genes', () => {
  it('POSTs the batch body, orders records (input then _id), and computes not_found', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      // mygene batch: unordered hits incl. a multi-match on "A" and a notfound on "C".
      expect(init?.method).toBe('POST')
      return Promise.resolve(
        jsonRes([
          { query: 'B', _id: '20', symbol: 'BB' },
          { query: 'A', _id: '3', symbol: 'AA3' },
          { query: 'A', _id: '15', symbol: 'AA15' },
          { query: 'C', notfound: true }
        ])
      )
    })
    const out = (await run(
      'query_genes',
      { terms: ['A', 'B', 'C'], scopes: 'symbol,alias', species: 'human' },
      fetchImpl
    )) as {
      n_input: number
      n_records: number
      not_found: string[]
      records: Array<{ query: string; _id: string }>
    }
    // Body carries q, scopes, species and the default field set.
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.q).toEqual(['A', 'B', 'C'])
    expect(body.scopes).toBe('symbol,alias')
    expect(body.species).toBe('human')
    expect(body.fields).toBe('symbol,name,taxid,entrezgene,ensembl.gene')
    // URL is the mygene POST /query endpoint.
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://mygene.info/v3/query')

    expect(out.n_input).toBe(3)
    expect(out.n_records).toBe(3)
    expect(out.not_found).toEqual(['C'])
    // A(pos0) before B(pos1); within A, _id "15" sorts before "3" (string order).
    expect(out.records.map((r) => r.query)).toEqual(['A', 'A', 'B'])
    expect(out.records.map((r) => r._id)).toEqual(['15', '3', '20'])
  })

  it('forwards an explicit fields value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes([{ query: 'TP53', _id: '7157' }]))
    await run('query_genes', { terms: ['TP53'], fields: 'all' }, fetchImpl)
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.fields).toBe('all')
    expect(body.scopes).toBeUndefined()
  })

  it('rejects a term containing a comma without calling the API', async () => {
    const fetchImpl = vi.fn()
    await expect(run('query_genes', { terms: ['TP53', 'A,B'] }, fetchImpl)).rejects.toThrow(/comma/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('short-circuits an empty terms array', async () => {
    const fetchImpl = vi.fn()
    const out = (await run('query_genes', { terms: [] }, fetchImpl)) as { n_input: number }
    expect(out.n_input).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('chunks batches larger than 1000 terms into multiple POSTs', async () => {
    const terms = Array.from({ length: 1500 }, (_, i) => `G${i}`)
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).q as string[]
      return Promise.resolve(jsonRes(q.map((query, i) => ({ query, _id: String(i) }))))
    })
    const out = (await run('query_genes', { terms }, fetchImpl)) as { n_records: number }
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.n_records).toBe(1500)
  })
})

describe('get_uniprot_entries', () => {
  it('fields mode: TSV OR-query, column->value records, format ignored', async () => {
    const tsv = 'Entry\tEntry Name\nP04637\tP53_HUMAN\nP38398\tBRCA1_HUMAN'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(tsv))
    const out = (await run(
      'get_uniprot_entries',
      { accessions: ['P04637', 'P38398'], fields: ['accession', 'id'], format: 'fasta' },
      fetchImpl
    )) as { n_records: number; records: Array<Record<string, string>> }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/uniprotkb/search?query=')
    expect(url).toContain(
      encodeURIComponent(
        '(((accession:P04637)OR(sec_acc:P04637))OR((accession:P38398)OR(sec_acc:P38398))) AND active:true'
      )
    )
    expect(url).toContain('fields=accession,id')
    expect(url).toContain('format=tsv')
    expect(out.n_records).toBe(2)
    expect(out.records[0]).toEqual({ Entry: 'P04637', 'Entry Name': 'P53_HUMAN' })
    expect(out.records[1]).toEqual({ Entry: 'P38398', 'Entry Name': 'BRCA1_HUMAN' })
  })

  it('fields mode: queries active records through secondary accessions', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes('Entry\tEntry Name\nP04637\tP53_HUMAN\n'))
    const out = (await run(
      'get_uniprot_entries',
      { accessions: ['Q15086'], fields: ['accession', 'id'] },
      fetchImpl
    )) as { n_records: number; records: Array<Record<string, string>> }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain(
      encodeURIComponent('(((accession:Q15086)OR(sec_acc:Q15086))) AND active:true')
    )
    expect(out.n_records).toBe(1)
    expect(out.records[0]).toEqual({ Entry: 'P04637', 'Entry Name': 'P53_HUMAN' })
  })

  it('fasta mode (default when no fields/format): per-accession map + missing', async () => {
    const fasta =
      '>sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens\nMEEPQSD\nAAAA\n' +
      '>sp|P38398|BRCA1_HUMAN Breast cancer type 1 OS=Homo sapiens\nMDLSAL\n'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(fasta)).mockResolvedValue(textRes(''))
    const out = (await run(
      'get_uniprot_entries',
      { accessions: ['P04637', 'P38398', 'P99999'] },
      fetchImpl
    )) as { format: string; n_found: number; missing: string[]; records: Record<string, string> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('format=fasta')
    expect(out.format).toBe('fasta')
    expect(out.n_found).toBe(2)
    expect(out.missing).toEqual(['P99999'])
    expect(out.records.P04637).toContain('>sp|P04637|P53_HUMAN')
    expect(out.records.P04637).toContain('MEEPQSD')
    expect(out.records.P38398).toContain('>sp|P38398|BRCA1_HUMAN')
    expect(out.records.P99999).toBeUndefined()
  })

  it('fasta mode: resolves a secondary accession through the direct endpoint', async () => {
    const fasta = '>sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens\nMEEPQSD\n'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textRes(fasta))
      .mockResolvedValueOnce(textRes(fasta))
    const out = (await run('get_uniprot_entries', { accessions: ['Q15086'] }, fetchImpl)) as {
      n_found: number
      missing: string[]
      records: Record<string, string>
    }
    const searchUrl = String(fetchImpl.mock.calls[0][0])
    expect(searchUrl).toContain(
      encodeURIComponent('(((accession:Q15086)OR(sec_acc:Q15086))) AND active:true')
    )
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'https://rest.uniprot.org/uniprotkb/Q15086.fasta'
    )
    expect(out.n_found).toBe(1)
    expect(out.missing).toEqual([])
    expect(out.records.Q15086).toContain('>sp|P04637|P53_HUMAN')
  })

  it('txt mode: flat-file split on // and secondary accessions from AC lines both map', async () => {
    const txt =
      'ID   BRCA1_HUMAN             Reviewed;        1863 AA.\n' +
      'AC   P38398; E9PFZ0; O15129;\n' +
      'DE   RecName: Full=Breast cancer;\n' +
      '//\n'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(txt)).mockResolvedValue(textRes(''))
    const out = (await run(
      'get_uniprot_entries',
      { accessions: ['P38398', 'O15129', 'P00000'], format: 'txt' },
      fetchImpl
    )) as { format: string; n_found: number; missing: string[]; records: Record<string, string> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('format=txt')
    expect(out.format).toBe('txt')
    // Primary and secondary accession both resolve to the same record block.
    expect(out.records.P38398).toContain('ID   BRCA1_HUMAN')
    expect(out.records.O15129).toBe(out.records.P38398)
    expect(out.n_found).toBe(2)
    expect(out.missing).toEqual(['P00000'])
  })

  it('txt mode: resolves a secondary-only accession through the direct endpoint', async () => {
    const txt =
      'ID   P53_HUMAN               Reviewed;         393 AA.\n' + 'AC   P04637; Q15086;\n' + '//\n'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes('')).mockResolvedValueOnce(textRes(txt))
    const out = (await run(
      'get_uniprot_entries',
      { accessions: ['Q15086'], format: 'txt' },
      fetchImpl
    )) as { n_found: number; missing: string[]; records: Record<string, string> }
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://rest.uniprot.org/uniprotkb/Q15086.txt')
    expect(out.n_found).toBe(1)
    expect(out.missing).toEqual([])
    expect(out.records.Q15086).toContain('AC   P04637; Q15086;')
  })

  it('direct fallback reports 400/404 as missing but propagates server failures', async () => {
    const missingFetch = vi
      .fn()
      .mockResolvedValueOnce(textRes(''))
      .mockResolvedValueOnce(statusRes(400))
    const missing = (await run(
      'get_uniprot_entries',
      { accessions: ['Q0Q0Q0Q0Q0'] },
      missingFetch
    )) as { n_found: number; missing: string[] }
    expect(missing.n_found).toBe(0)
    expect(missing.missing).toEqual(['Q0Q0Q0Q0Q0'])

    const failingFetch = vi
      .fn()
      .mockResolvedValueOnce(textRes(''))
      .mockResolvedValue(statusRes(500))
    await expect(
      run('get_uniprot_entries', { accessions: ['Q15086'] }, failingFetch)
    ).rejects.toThrow('HTTP 500')
  })

  it('chunks large accession lists across multiple requests', async () => {
    const accessions = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(5, '0')}`)
    const fetchImpl = vi.fn().mockResolvedValue(textRes('Entry\n'))
    await run('get_uniprot_entries', { accessions, fields: ['accession'] }, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
