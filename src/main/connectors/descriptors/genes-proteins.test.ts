import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GENES_PROTEINS_TOOLS } from './genes-proteins'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

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
    expect(url).toContain(encodeURIComponent('(accession:P04637)OR(accession:P38398)'))
    expect(url).toContain('fields=accession,id')
    expect(url).toContain('format=tsv')
    expect(out.n_records).toBe(2)
    expect(out.records[0]).toEqual({ Entry: 'P04637', 'Entry Name': 'P53_HUMAN' })
    expect(out.records[1]).toEqual({ Entry: 'P38398', 'Entry Name': 'BRCA1_HUMAN' })
  })

  it('fasta mode (default when no fields/format): per-accession map + missing', async () => {
    const fasta =
      '>sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens\nMEEPQSD\nAAAA\n' +
      '>sp|P38398|BRCA1_HUMAN Breast cancer type 1 OS=Homo sapiens\nMDLSAL\n'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(fasta))
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

  it('txt mode: flat-file split on // and secondary accessions from AC lines both map', async () => {
    const txt =
      'ID   BRCA1_HUMAN             Reviewed;        1863 AA.\n' +
      'AC   P38398; E9PFZ0; O15129;\n' +
      'DE   RecName: Full=Breast cancer;\n' +
      '//\n'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(txt))
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

  it('chunks large accession lists across multiple requests', async () => {
    const accessions = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(5, '0')}`)
    const fetchImpl = vi.fn().mockResolvedValue(textRes('Entry\n'))
    await run('get_uniprot_entries', { accessions, fields: ['accession'] }, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
