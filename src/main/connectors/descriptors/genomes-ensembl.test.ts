import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ParserEngine } from '../engine'
import { GENOMES_ENSEMBL_TOOLS } from './genomes-ensembl'

// Mock Response factories: 200 JSON, and a non-ok status the engine turns into `HTTP <n> for <url>`.
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const tool = (id: string): (typeof GENOMES_ENSEMBL_TOOLS)[number] => {
  const t = GENOMES_ENSEMBL_TOOLS.find((x) => x.id === id)
  if (!t) throw new Error(`no tool ${id}`)
  return t
}

const run = (
  id: string,
  args: Record<string, unknown>,
  fetchImpl: ReturnType<typeof vi.fn>
): Promise<unknown> =>
  new ParserEngine({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retries: 0
  }).call(tool(id), args, {})

describe('ensembl_lookup', () => {
  it('routes a true stable ID to /lookup/id (species ignored)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ id: 'ENSG00000157764' }))
    const out = (await run(
      'ensembl_lookup',
      { query: 'ENSG00000157764', species: 'mus_musculus', expand: true },
      fetchImpl
    )) as { found: boolean; record: { id: string } }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/lookup/id/ENSG00000157764?expand=1')
    expect(url).not.toContain('/lookup/symbol/')
    expect(out.found).toBe(true)
    expect(out.record.id).toBe('ENSG00000157764')
  })

  it('routes an "ENS"-prefixed SYMBOL (ENSA / ENSAP1) to /lookup/symbol', async () => {
    for (const sym of ['ENSA', 'ENSAP1']) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ id: 'ENSG00000143420' }))
      await run('ensembl_lookup', { query: sym }, fetchImpl)
      const url = String(fetchImpl.mock.calls[0][0])
      expect(url).toContain(`/lookup/symbol/homo_sapiens/${sym}?expand=0`)
    }
  })

  it('routes a plain gene symbol to /lookup/symbol with the species', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ id: 'ENSG00000157764' }))
    await run('ensembl_lookup', { query: 'BRAF' }, fetchImpl)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/lookup/symbol/homo_sapiens/BRAF')
  })

  it('accepts a versioned stable ID and LRG id on the ID route', async () => {
    for (const q of ['ENSG00000157764.16', 'LRG_299']) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ id: q }))
      await run('ensembl_lookup', { query: q }, fetchImpl)
      expect(String(fetchImpl.mock.calls[0][0])).toContain(`/lookup/id/${encodeURIComponent(q)}`)
    }
  })

  it('maps an upstream 400 to found:false, record:null', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errRes(400))
    const out = (await run('ensembl_lookup', { query: 'NOSUCHGENE' }, fetchImpl)) as {
      found: boolean
      record: unknown
    }
    expect(out.found).toBe(false)
    expect(out.record).toBeNull()
  })
})

describe('ensembl_xrefs', () => {
  it('sorts by (dbname, primary_id) and passes external_db through', async () => {
    const rows = [
      { dbname: 'HGNC', primary_id: 'HGNC:1097', display_id: 'BRAF' },
      { dbname: 'EntrezGene', primary_id: '673', display_id: 'BRAF' },
      { dbname: 'EntrezGene', primary_id: '100', display_id: 'X' }
    ]
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(rows))
    const out = (await run(
      'ensembl_xrefs',
      { stable_id: 'ENSG00000157764', external_db: 'HGNC' },
      fetchImpl
    )) as { n_xrefs: number; xrefs: Array<Record<string, unknown>> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('external_db=HGNC')
    expect(out.n_xrefs).toBe(3)
    expect(out.xrefs.map((x) => `${x.dbname}:${x.primary_id}`)).toEqual([
      'EntrezGene:100',
      'EntrezGene:673',
      'HGNC:HGNC:1097'
    ])
  })

  it('maps an unknown-id 400 to n_xrefs:0 (does not throw)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errRes(400))
    const out = (await run('ensembl_xrefs', { stable_id: 'NOTANID' }, fetchImpl)) as {
      n_xrefs: number
      xrefs: unknown[]
    }
    expect(out.n_xrefs).toBe(0)
    expect(out.xrefs).toEqual([])
  })
})

describe('ensembl_vep_variant', () => {
  const vepResult = {
    input: 'rs7412',
    assembly_name: 'GRCh38',
    seq_region_name: '19',
    start: 44908822,
    end: 44908822,
    strand: 1,
    allele_string: 'C/T',
    most_severe_consequence: 'missense_variant',
    colocated_variants: [{ id: 'rs7412', allele_string: 'C/T', somatic: 0, clin_sig: ['benign'] }],
    regulatory_feature_consequences: [{ x: 1 }],
    transcript_consequences: [
      { transcript_id: 't1', gene_id: 'G1', gene_symbol: 'APOE', impact: 'MODIFIER' },
      { transcript_id: 't2', gene_id: 'G1', gene_symbol: 'APOE', impact: 'MODERATE' },
      { transcript_id: 't3', gene_id: 'G2', gene_symbol: 'TOMM40', impact: 'HIGH' },
      { transcript_id: 't4', gene_id: 'G2', gene_symbol: 'TOMM40', impact: 'LOW' }
    ]
  }

  it('sorts most-severe-first, truncates, and summarizes per-gene worst impact', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([vepResult]))
    const out = (await run(
      'ensembl_vep_variant',
      { variant_id: 'rs7412', max_consequences: 2 },
      fetchImpl
    )) as {
      query: string
      n_results: number
      results: Array<Record<string, unknown>>
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/vep/homo_sapiens/id/rs7412')
    expect(out.query).toBe('rs7412')
    const r = out.results[0]
    // Top-2 by severity: HIGH then MODERATE.
    const tcs = r.transcript_consequences as Array<Record<string, unknown>>
    expect(tcs.map((t) => t.impact)).toEqual(['HIGH', 'MODERATE'])
    expect(r.n_transcript_consequences).toBe(4)
    expect(r.transcript_consequences_truncated).toBe(true)
    // Per-gene worst impact over the FULL list, sorted by severity.
    expect(r.genes).toEqual([
      { gene_id: 'G2', gene_symbol: 'TOMM40', worst_impact: 'HIGH', n_transcripts: 2 },
      { gene_id: 'G1', gene_symbol: 'APOE', worst_impact: 'MODERATE', n_transcripts: 2 }
    ])
    expect(r.n_regulatory_feature_consequences).toBe(1)
    expect(r.n_motif_feature_consequences).toBe(0)
    expect((r.colocated_variants as unknown[]).length).toBe(1)
  })

  it('builds the region+allele route and reports the query', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([{ ...vepResult, input: 'region' }]))
    const out = (await run(
      'ensembl_vep_variant',
      { region: '7:140753336-140753336', allele: 'T' },
      fetchImpl
    )) as { query: string }
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/vep/homo_sapiens/region/7:140753336-140753336/T'
    )
    expect(out.query).toBe('7:140753336-140753336 T')
  })

  it('throws when neither variant_id nor region+allele is supplied', async () => {
    const fetchImpl = vi.fn()
    await expect(run('ensembl_vep_variant', { region: '7:1-1' }, fetchImpl)).rejects.toThrow(
      /variant_id or both region and allele/
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensembl_homology', () => {
  it('resolves a symbol to a stable ID first, then queries /homology/id and sorts rows', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/lookup/symbol/')) {
        return Promise.resolve(jsonRes({ id: 'ENSG00000157764' }))
      }
      return Promise.resolve(
        jsonRes({
          data: [
            {
              homologies: [
                { species: 'mus_musculus', id: 'ENSMUSG2', type: 'ortholog_one2one' },
                { species: 'mus_musculus', id: 'ENSMUSG1', type: 'ortholog_one2one' },
                { species: 'gallus_gallus', id: 'ENSGALG1', type: 'ortholog_one2one' }
              ]
            }
          ]
        })
      )
    })
    const out = (await run(
      'ensembl_homology',
      { gene_symbol: 'BRAF', target_species: 'mus_musculus', max_homologies: 2 },
      fetchImpl
    )) as {
      gene_id: string
      n_total: number
      homologies_truncated: boolean
      homologies: Array<Record<string, unknown>>
    }
    const homologyUrl = String(
      fetchImpl.mock.calls.find((c) => String(c[0]).includes('/homology/id/'))![0]
    )
    expect(homologyUrl).toContain('/homology/id/homo_sapiens/ENSG00000157764')
    expect(homologyUrl).toContain('format=condensed')
    expect(homologyUrl).toContain('target_species=mus_musculus')
    expect(out.gene_id).toBe('ENSG00000157764')
    expect(out.n_total).toBe(3)
    expect(out.homologies_truncated).toBe(true)
    // Sorted by (species, id), then capped at 2.
    expect(out.homologies.map((h) => h.id)).toEqual(['ENSGALG1', 'ENSMUSG1'])
  })

  it('throws when both gene_symbol and gene_id (or neither) are provided', async () => {
    const fetchImpl = vi.fn()
    await expect(
      run('ensembl_homology', { gene_symbol: 'BRAF', gene_id: 'ENSG1' }, fetchImpl)
    ).rejects.toThrow(/exactly one/)
    await expect(run('ensembl_homology', {}, fetchImpl)).rejects.toThrow(/exactly one/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensembl_sequence', () => {
  it('computes length + sha256 for a stable-ID sequence', async () => {
    const seq = 'ACGTACGTAC'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENSG1', desc: 'chr7', molecule: 'dna', seq }))
    const out = (await run(
      'ensembl_sequence',
      { stable_id: 'ENSG1', seq_type: 'genomic' },
      fetchImpl
    )) as { length: number; sha256: string; seq?: string; seq_omitted?: boolean }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sequence/id/ENSG1?type=genomic')
    expect(out.length).toBe(seq.length)
    expect(out.sha256).toBe(createHash('sha256').update(seq, 'utf8').digest('hex'))
    expect(out.seq).toBe(seq)
    expect(out.seq_omitted).toBeUndefined()
  })

  it('omits seq (keeps length/sha256) past max_bytes', async () => {
    const seq = 'ACGTACGTAC'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ id: 'ENSG1', desc: 'chr7', molecule: 'dna', seq }))
    const out = (await run(
      'ensembl_sequence',
      { stable_id: 'ENSG1', max_bytes: 5 },
      fetchImpl
    )) as { length: number; sha256: string; seq?: string; seq_omitted?: boolean }
    expect(out.seq).toBeUndefined()
    expect(out.seq_omitted).toBe(true)
    expect(out.length).toBe(seq.length)
    expect(out.sha256).toBe(createHash('sha256').update(seq, 'utf8').digest('hex'))
  })

  it('uses the region route (always genomic) and ignores seq_type', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ id: 'chromosome:GRCh38:7:1:10:1', molecule: 'dna', seq: 'ACGTACGTAC' })
      )
    const out = (await run(
      'ensembl_sequence',
      { region: '7:1-10', species: 'homo_sapiens', seq_type: 'protein' },
      fetchImpl
    )) as { seq_type: string }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/sequence/region/homo_sapiens/7:1-10')
    expect(out.seq_type).toBe('genomic')
  })

  it('maps an unknown stable ID (400) to found:false with null fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errRes(400))
    const out = (await run('ensembl_sequence', { stable_id: 'ENSGBAD' }, fetchImpl)) as {
      found: boolean
      id: unknown
      length: number
    }
    expect(out.found).toBe(false)
    expect(out.id).toBeNull()
    expect(out.length).toBe(0)
  })

  it('throws when neither stable_id nor region is provided', async () => {
    const fetchImpl = vi.fn()
    await expect(run('ensembl_sequence', {}, fetchImpl)).rejects.toThrow(/stable_id or region/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ensembl_overlap_region', () => {
  it('sorts by (start, id), caps, and reports n_total', async () => {
    const rows = [
      { id: 'ENSG_B', start: 200, biotype: 'protein_coding' },
      { id: 'ENSG_A', start: 100, biotype: 'protein_coding' },
      { id: 'ENSG_C', start: 100, biotype: 'lincRNA' }
    ]
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(rows))
    const out = (await run(
      'ensembl_overlap_region',
      { region: '7:1-1000', feature: 'gene', max_features: 2 },
      fetchImpl
    )) as { n_total: number; features_truncated: boolean; features: Array<Record<string, unknown>> }
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/overlap/region/homo_sapiens/7:1-1000?feature=gene'
    )
    expect(out.n_total).toBe(3)
    expect(out.features_truncated).toBe(true)
    // Sorted (start asc, then id): A(100), C(100), B(200) -> capped to first 2.
    expect(out.features.map((f) => f.id)).toEqual(['ENSG_A', 'ENSG_C'])
  })

  it('returns n_total:0 for an empty region', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes([]))
    const out = (await run(
      'ensembl_overlap_region',
      { region: '7:1-2', feature: 'regulatory' },
      fetchImpl
    )) as { n_total: number; features: unknown[] }
    expect(out.n_total).toBe(0)
    expect(out.features).toEqual([])
  })
})
