import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { VARIANTS_DBSNP_TOOLS } from './variants-dbsnp'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response
// A non-ok Response the ParserEngine turns into `HTTP <status> for <url>`; 404 is non-retryable.
const errRes = (status: number): Response =>
  ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({})
  }) as unknown as Response

const getRsids = VARIANTS_DBSNP_TOOLS.find((t) => t.id === 'dbsnp_get_rsids')!
const searchRegion = VARIANTS_DBSNP_TOOLS.find((t) => t.id === 'dbsnp_search_by_region')!

// A trimmed but structurally faithful RefSNP payload for rs7412: merged nothing, one primary
// placement on GRCh38 + one on GRCh37, one alt allele with a frequency study, a ClinVar xref and gene.
const rs7412Payload = {
  refsnp_id: '7412',
  create_date: '2000-09-19T17:02Z',
  last_update_date: '2022-10-13T09:26Z',
  last_update_build_id: 156,
  citations: [11226315, 12031152],
  mane_select_ids: ['NM_000041.4'],
  primary_snapshot_data: {
    variant_type: 'snv',
    placements_with_allele: [
      {
        seq_id: 'NC_000019.10',
        is_ptlp: true,
        placement_annot: {
          seq_id_traits_by_assembly: [{ is_chromosome: true, assembly_name: 'GRCh38.p14' }]
        },
        alleles: [
          {
            allele: {
              spdi: {
                seq_id: 'NC_000019.10',
                position: 44908821,
                deleted_sequence: 'C',
                inserted_sequence: 'C'
              }
            },
            hgvs: 'NC_000019.10:g.44908822C='
          },
          {
            allele: {
              spdi: {
                seq_id: 'NC_000019.10',
                position: 44908821,
                deleted_sequence: 'C',
                inserted_sequence: 'T'
              }
            },
            hgvs: 'NC_000019.10:g.44908822C>T'
          }
        ]
      },
      {
        seq_id: 'NC_000019.9',
        is_ptlp: false,
        placement_annot: {
          seq_id_traits_by_assembly: [{ is_chromosome: true, assembly_name: 'GRCh37.p13' }]
        },
        alleles: [
          {
            allele: {
              spdi: {
                seq_id: 'NC_000019.9',
                position: 45412078,
                deleted_sequence: 'C',
                inserted_sequence: 'C'
              }
            }
          },
          {
            allele: {
              spdi: {
                seq_id: 'NC_000019.9',
                position: 45412078,
                deleted_sequence: 'C',
                inserted_sequence: 'T'
              }
            }
          }
        ]
      }
    ],
    allele_annotations: [
      {}, // reference-allele slot (skipped)
      {
        frequency: [
          { study_name: 'GnomAD', study_version: 4, allele_count: 9000, total_count: 100000 },
          { study_name: 'GnomAD', study_version: 4, allele_count: 9000, total_count: 100000 }, // dupe
          { study_name: 'ALFA', study_version: 1, allele_count: 500, total_count: 10000 }
        ],
        clinical: [
          {
            accession_version: 'RCV000019456.30',
            clinical_significances: ['benign'],
            review_status: 'reviewed by expert panel',
            last_evaluated_date: '2021-01-01',
            disease_names: ['Familial hypercholesterolemia']
          }
        ],
        assembly_annotation: [
          {
            genes: [
              {
                locus: 'APOE',
                id: 348,
                name: 'apolipoprotein E',
                orientation: 'plus',
                rnas: [
                  {
                    id: 'NM_000041.4',
                    hgvs: 'NM_000041.4:c.526C>T',
                    sequence_ontology: [{ name: 'missense_variant' }],
                    protein: {
                      sequence_ontology: [{ name: 'missense_variant' }],
                      variant: {
                        spdi: {
                          seq_id: 'NP_000032.1',
                          position: 175,
                          deleted_sequence: 'R',
                          inserted_sequence: 'C'
                        }
                      }
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('dbsnp_get_rsids', () => {
  it('distills a live RefSNP record: placements, alleles, frequencies, clinvar, genes', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes(rs7412Payload))
    const out = (await new ParserEngine({ fetchImpl }).call(
      getRsids,
      { rsids: ['rs7412'] },
      { ncbiEmail: 'x@y.org' }
    )) as {
      n_requested: number
      records: Array<{
        rsid: string
        status: string
        n_citations: number
        citations_truncated: boolean
        variant_type: string
        mane_select_ids: string[]
        placements: Array<{
          assembly: string
          chrom: string
          position: number
          ref: string
          alts: string[]
          is_primary: boolean
        }>
        alleles: Array<{
          allele: string
          ref: string
          spdi: string
          frequencies: Array<{ study: string; af: number }>
          clinvar: Array<{ rcv_accession: string }>
          genes: Array<{
            symbol: string
            consequences: string[]
            mane_select: Array<{ protein_spdi: string }>
          }>
        }>
      }>
      not_found: string[]
      not_processed: string[]
    }

    // Variation Services host + email carried as a query string.
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('/variation/v0/refsnp/7412')
    expect(url).toContain('email=x%40y.org')

    expect(out.n_requested).toBe(1)
    expect(out.not_found).toEqual([])
    expect(out.not_processed).toEqual([])
    const rec = out.records[0]
    expect(rec.rsid).toBe('rs7412')
    expect(rec.status).toBe('live')
    expect(rec.variant_type).toBe('snv')
    expect(rec.n_citations).toBe(2)
    expect(rec.citations_truncated).toBe(false)
    expect(rec.mane_select_ids).toEqual(['NM_000041.4'])

    // Placements: GRCh38 primary first, GRCh37 second; SPDI 0-based -> 1-based position.
    expect(rec.placements.map((p) => p.assembly)).toEqual(['GRCh38', 'GRCh37'])
    expect(rec.placements[0]).toMatchObject({
      assembly: 'GRCh38',
      chrom: '19',
      position: 44908822,
      ref: 'C',
      alts: ['T'],
      is_primary: true
    })
    expect(rec.placements[1].is_primary).toBe(false)

    // Single alt allele (reference row dropped); annotation aligned by index i=1.
    expect(rec.alleles).toHaveLength(1)
    const alt = rec.alleles[0]
    expect(alt.allele).toBe('T')
    expect(alt.ref).toBe('C')
    expect(alt.spdi).toBe('NC_000019.10:44908821:C:T')
    // Frequencies deduped by (study, version); af = ac/tc; sorted by study.
    expect(alt.frequencies).toEqual([
      { study: 'ALFA', study_version: 1, allele_count: 500, total_count: 10000, af: 0.05 },
      { study: 'GnomAD', study_version: 4, allele_count: 9000, total_count: 100000, af: 0.09 }
    ])
    expect(alt.clinvar[0].rcv_accession).toBe('RCV000019456.30')
    expect(alt.genes[0].symbol).toBe('APOE')
    expect(alt.genes[0].consequences).toEqual(['missense_variant'])
    expect(alt.genes[0].mane_select[0].protein_spdi).toBe('NP_000032.1:175:R:C')
  })

  it('status merged -> merged_into, no placements/alleles', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        refsnp_id: '52826',
        citations: [],
        merged_snapshot_data: { merged_into: ['267606617'] }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      getRsids,
      { rsids: ['rs52826'] },
      { ncbiEmail: 'x@y.org' }
    )) as { records: Array<{ status: string; merged_into: string[]; placements?: unknown }> }
    expect(out.records[0].status).toBe('merged')
    expect(out.records[0].merged_into).toEqual(['rs267606617'])
    expect(out.records[0].placements).toBeUndefined()
  })

  it('status no_data when no primary_snapshot_data', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ refsnp_id: '999', citations: [] }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      getRsids,
      { rsids: ['rs999'] },
      { ncbiEmail: 'x@y.org' }
    )) as { records: Array<{ status: string }> }
    expect(out.records[0].status).toBe('no_data')
  })

  it('caps citations at 20 and flags citations_truncated', async () => {
    const many = Array.from({ length: 25 }, (_, i) => 1000 + i)
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ refsnp_id: '1', citations: many }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      getRsids,
      { rsids: ['rs1'] },
      { ncbiEmail: 'x@y.org' }
    )) as {
      records: Array<{
        n_citations: number
        citations_pmids: number[]
        citations_truncated: boolean
      }>
    }
    expect(out.records[0].n_citations).toBe(25)
    expect(out.records[0].citations_pmids).toHaveLength(20)
    expect(out.records[0].citations_truncated).toBe(true)
  })

  it('not_found (HTTP 404) is separate from a processed record', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(rs7412Payload))
      .mockResolvedValueOnce(errRes(404))
    const out = (await new ParserEngine({ fetchImpl, retries: 0 }).call(
      getRsids,
      { rsids: ['rs7412', 'rs0'] },
      { ncbiEmail: 'x@y.org' }
    )) as { records: unknown[]; not_found: string[]; not_processed: string[] }
    expect(out.records).toHaveLength(1)
    expect(out.not_found).toEqual(['rs0'])
    expect(out.not_processed).toEqual([])
  })

  it('missing contact email -> contact_email_required (no fetch, no throw)', async () => {
    const fetchImpl = vi.fn()
    const out = (await new ParserEngine({ fetchImpl }).call(
      getRsids,
      { rsids: ['rs7412'] },
      {}
    )) as {
      error: string
    }
    expect(out.error).toBe('contact_email_required')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blank/empty rsids -> all-empty result, never throws', async () => {
    const fetchImpl = vi.fn()
    const out = (await new ParserEngine({ fetchImpl }).call(
      getRsids,
      { rsids: ['  ', ''] },
      { ncbiEmail: 'x@y.org' }
    )) as { n_requested: number; records: unknown[] }
    expect(out).toEqual({ n_requested: 0, records: [], not_found: [], not_processed: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a malformed rsID token', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        getRsids,
        { rsids: ['notanrsid'] },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/not an rsID/)
  })
})

describe('dbsnp_search_by_region', () => {
  it('builds the esearch db=snp term (GRCh38 -> CPOS) and lists rsids in Entrez order', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ esearchresult: { count: '3', idlist: ['769450', '429358', '7412'] } })
      )
    const out = (await new ParserEngine({ fetchImpl }).call(
      searchRegion,
      { chrom: 'chr19', start: 44905000, stop: 44910000, max_rsids: 500 },
      { ncbiEmail: 'x@y.org' }
    )) as {
      chrom: string
      assembly: string
      term: string
      total: number
      n_returned: number
      truncated: boolean
      rsids: string[]
    }
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('esearch.fcgi?db=snp')
    expect(url).toContain('retmax=500')
    expect(url).toContain('email=x%40y.org')
    // term is URL-encoded in the request.
    expect(decodeURIComponent(url)).toContain(
      '19[CHR] AND 44905000:44910000[CPOS] AND homo sapiens[ORGN]'
    )

    expect(out.chrom).toBe('19') // chr prefix stripped
    expect(out.assembly).toBe('GRCh38')
    expect(out.term).toBe('19[CHR] AND 44905000:44910000[CPOS] AND homo sapiens[ORGN]')
    expect(out.total).toBe(3)
    expect(out.n_returned).toBe(3)
    expect(out.truncated).toBe(false)
    // rsids kept in Entrez (esearch idlist) order, prefixed with rs.
    expect(out.rsids).toEqual(['rs769450', 'rs429358', 'rs7412'])
  })

  it('GRCh37 selects the CPOS_GRCH37 positional index', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '0', idlist: [] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      searchRegion,
      { chrom: '19', start: 45408000, stop: 45413000, assembly: 'GRCh37' },
      { ncbiEmail: 'x@y.org' }
    )) as { assembly: string; term: string; truncated: boolean }
    expect(out.assembly).toBe('GRCh37')
    expect(out.term).toContain('[CPOS_GRCH37]')
    expect(out.truncated).toBe(false)
  })

  it('flags truncated when total exceeds the returned prefix', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '500', idlist: ['1', '2'] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      searchRegion,
      { chrom: '1', start: 1, stop: 1000, max_rsids: 2 },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; n_returned: number; truncated: boolean }
    expect(out.total).toBe(500)
    expect(out.n_returned).toBe(2)
    expect(out.truncated).toBe(true)
  })

  it('rejects a span over 1 Mb', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        searchRegion,
        { chrom: '1', start: 1, stop: 2_000_002 },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/exceeds/)
  })

  it('rejects a bad chromosome', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        searchRegion,
        { chrom: '23', start: 1, stop: 100 },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/bad chromosome/)
  })

  it('missing contact email -> contact_email_required (no fetch)', async () => {
    const fetchImpl = vi.fn()
    const out = (await new ParserEngine({ fetchImpl }).call(
      searchRegion,
      { chrom: '19', start: 1, stop: 100 },
      {}
    )) as { error: string }
    expect(out.error).toBe('contact_email_required')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
