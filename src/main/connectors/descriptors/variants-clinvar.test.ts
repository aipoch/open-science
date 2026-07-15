import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { VARIANTS_CLINVAR_TOOLS } from './variants-clinvar'
import type { ToolDescriptor } from '../types'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const tool = (id: string): ToolDescriptor => VARIANTS_CLINVAR_TOOLS.find((t) => t.id === id)!

// A rich esummary doc for variation 45122, exercising all three classification axes + gold stars +
// conditions + locations. Modeled on the real db=clinvar esummary shape.
const richDoc = {
  uid: '45122',
  accession: 'VCV000045122',
  accession_version: 'VCV000045122.3',
  title: 'NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)',
  obj_type: 'single nucleotide variant',
  protein_change: 'V600E',
  genes: [{ symbol: 'BRAF', geneid: '673', strand: '-' }],
  molecular_consequence_list: ['missense variant'],
  variation_set: [
    {
      variant_type: 'single nucleotide variant',
      canonical_spdi: 'NC_000007.14:140753335:A:T',
      cdna_change: 'c.1799T>A',
      variation_xrefs: [
        { db_source: 'dbSNP', db_id: '113488022' },
        { db_source: 'OMIM', db_id: '164757.0001' }
      ],
      allele_freq_set: [{ source: 'TOPMED', minor_allele: 'T', value: '0.00001' }],
      variation_loc: [
        {
          status: 'current',
          assembly_name: 'GRCh38',
          chr: '7',
          band: '7q34',
          start: '140753336',
          stop: '140753336',
          ref: 'A',
          alt: 'T'
        },
        {
          status: 'previous',
          assembly_name: 'GRCh37',
          chr: '7',
          start: '140453136',
          stop: '140453136',
          ref: 'A',
          alt: 'T'
        }
      ]
    }
  ],
  supporting_submissions: { scv: ['SCV1', 'SCV2', 'SCV3'], rcv: ['RCV000019428'] },
  germline_classification: {
    description: 'Pathogenic',
    review_status: 'criteria provided, multiple submitters, no conflicts',
    last_evaluated: '2022/10/12 00:00',
    trait_set: [
      {
        trait_name: 'Melanoma',
        trait_xrefs: [{ db_source: 'MedGen', db_id: 'C0025202' }]
      }
    ]
  },
  clinical_impact_classification: {
    description: 'Tier I - Strong',
    review_status: 'reviewed by expert panel',
    last_evaluated: '2023/01/05 00:00',
    fda_recognized_database: 'OncoKB',
    trait_set: [{ trait_name: 'Colorectal cancer', trait_xrefs: [] }]
  },
  oncogenicity_classification: {
    description: 'Oncogenic',
    review_status: 'criteria provided, single submitter',
    last_evaluated: '1/01/01 00:00',
    trait_set: []
  }
}

describe('variants-clinvar', () => {
  it('clinvar_search: esearch -> esummary, full record shape, etiquette', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '1', idlist: ['45122'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc, uids: ['45122'] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'BRAF V600E', max_records: 50 },
      { ncbiEmail: 'x@y.org' }
    )) as {
      term: string
      total: number
      truncated: boolean
      records: Array<Record<string, unknown>>
    }

    // esearch db=clinvar with etiquette; esummary follows.
    expect(fetchImpl.mock.calls[0][0]).toContain('esearch.fcgi?db=clinvar')
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(fetchImpl.mock.calls[1][0]).toContain('esummary.fcgi?db=clinvar')
    expect(out.total).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.records).toHaveLength(1)
    const r = out.records[0]
    expect(r.variation_id).toBe(45122)
    expect(r.accession).toBe('VCV000045122')
    expect(r.rsids).toEqual(['rs113488022'])
    expect(r.other_xrefs).toEqual([{ db: 'OMIM', id: '164757.0001' }])
    expect(r.n_submissions).toBe(3)
    expect(r.canonical_spdi).toBe('NC_000007.14:140753335:A:T')
    expect(r.molecular_consequences).toEqual(['missense variant'])
    // germline: gold_stars 2, date normalized, condition xrefs preserved.
    expect(r.germline_classification).toEqual({
      description: 'Pathogenic',
      review_status: 'criteria provided, multiple submitters, no conflicts',
      gold_stars: 2,
      last_evaluated: '2022-10-12',
      fda_recognized_database: null,
      conditions: [{ name: 'Melanoma', xrefs: [{ db: 'MedGen', id: 'C0025202' }] }]
    })
    // clinical_impact: gold_stars 3, fda db surfaced.
    expect(r.clinical_impact_classification).toMatchObject({
      description: 'Tier I - Strong',
      gold_stars: 3,
      fda_recognized_database: 'OncoKB'
    })
    // oncogenicity: single submitter -> 1 star; the 1/01/01 sentinel -> null date.
    expect(r.oncogenicity_classification).toMatchObject({
      description: 'Oncogenic',
      gold_stars: 1,
      last_evaluated: null
    })
    // GRCh38 + GRCh37 locations both present.
    expect(r.locations).toEqual([
      {
        status: 'current',
        assembly: 'GRCh38',
        chrom: '7',
        band: '7q34',
        start: 140753336,
        stop: 140753336,
        ref: 'A',
        alt: 'T'
      },
      {
        status: 'previous',
        assembly: 'GRCh37',
        chrom: '7',
        band: null,
        start: 140453136,
        stop: 140453136,
        ref: 'A',
        alt: 'T'
      }
    ])
  })

  it('clinvar_search: truncation flagged when total > returned page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '250', idlist: ['45122'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'BRCA1', max_records: 1 },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; truncated: boolean; records: unknown[] }
    expect(out.total).toBe(250)
    expect(out.truncated).toBe(true)
    expect(out.records).toHaveLength(1)
  })

  it('clinvar_search: no match -> total 0, empty records, no throw', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '0', idlist: [] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'zzzznomatch' },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; records: unknown[] }
    expect(out.total).toBe(0)
    expect(out.records).toEqual([])
    // esummary is never called when there are no UIDs.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('clinvar_search: dropped summary doc -> missing_uids, not a truncation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['45122', '99999'] } }))
      .mockResolvedValueOnce(
        jsonRes({
          result: { '45122': richDoc, '99999': { uid: '99999', error: 'cannot get document' } }
        })
      )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_search'),
      { query: 'BRAF' },
      { ncbiEmail: 'x@y.org' }
    )) as { truncated: boolean; missing_uids: string[]; records: unknown[] }
    expect(out.records).toHaveLength(1)
    expect(out.missing_uids).toEqual(['99999'])
    // count == idlist length -> not truncated, even though a doc was dropped.
    expect(out.truncated).toBe(false)
  })

  it('clinvar_get_records: VCV/RCV/bare-id forms, requested_as, not_found for unknown RCV', async () => {
    const rcvDoc = { ...richDoc, uid: '12345', accession: 'VCV000012345' }
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      // RCV resolution esearch calls: RCV000019428 -> variation 45122; RCV000099999 -> nothing.
      if (url.includes('esearch.fcgi')) {
        if (url.includes('RCV000019428'))
          return Promise.resolve(jsonRes({ esearchresult: { idlist: ['45122'] } }))
        return Promise.resolve(jsonRes({ esearchresult: { idlist: [] } }))
      }
      // esummary for the two resolved UIDs (45122 from VCV+RCV, 12345 from bare id).
      return Promise.resolve(jsonRes({ result: { '45122': richDoc, '12345': rcvDoc } }))
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_records'),
      { accessions: ['VCV000045122.3', 'RCV000019428', '12345', 'RCV000099999'] },
      { ncbiEmail: 'x@y.org' }
    )) as {
      n_requested: number
      records: Array<Record<string, unknown>>
      not_found: string[]
      not_processed: string[]
    }
    expect(out.n_requested).toBe(4)
    expect(out.not_found).toEqual(['RCV000099999'])
    expect(out.not_processed).toEqual([])
    // Sorted by variation_id; VCV + RCV both map to 45122 (one record, two requested_as).
    expect(out.records.map((r) => r.variation_id)).toEqual([12345, 45122])
    const merged = out.records.find((r) => r.variation_id === 45122)!
    expect(merged.requested_as).toEqual(['VCV000045122.3', 'RCV000019428'])
    expect(out.records.find((r) => r.variation_id === 12345)!.requested_as).toEqual(['12345'])
  })

  it('clinvar_get_records: dedupe by unique set + duplicate count', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_records'),
      { accessions: ['45122', 'VCV000045122', '45122'] },
      { ncbiEmail: 'x@y.org' }
    )) as { n_requested: number; n_unique: number; n_duplicate_skipped: number; records: unknown[] }
    expect(out.n_requested).toBe(3)
    expect(out.n_unique).toBe(2)
    expect(out.n_duplicate_skipped).toBe(1)
    expect(out.records).toHaveLength(1)
  })

  it('clinvar_get_records: missing_uids distinct from not_found (VCV summary dropped)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ result: { '45122': { uid: '45122', error: 'dropped' } } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_get_records'),
      { accessions: ['VCV000045122'] },
      { ncbiEmail: 'x@y.org' }
    )) as { records: unknown[]; missing_uids: string[]; not_found: string[] }
    expect(out.records).toEqual([])
    expect(out.missing_uids).toEqual(['VCV000045122'])
    expect(out.not_found).toEqual([])
  })

  it('clinvar_get_records: rsID input is rejected (throws)', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new ParserEngine({ fetchImpl }).call(
        tool('clinvar_get_records'),
        { accessions: ['rs121913529'] },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/rsID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('clinvar_variant_by_rsid: one rsID -> all VCVs, lowercased, etiquette', async () => {
    const doc2 = { ...richDoc, uid: '45123', accession: 'VCV000045123' }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['45122', '45123'] } }))
      .mockResolvedValueOnce(jsonRes({ result: { '45122': richDoc, '45123': doc2 } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_variant_by_rsid'),
      { rsid: 'RS121913529' },
      { ncbiEmail: 'x@y.org' }
    )) as {
      rsid: string
      total: number
      truncated: boolean
      records: Array<Record<string, unknown>>
    }
    // rsID lowercased into the esearch term.
    expect(fetchImpl.mock.calls[0][0]).toContain('term=rs121913529')
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(out.rsid).toBe('rs121913529')
    expect(out.total).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.records.map((r) => r.variation_id)).toEqual([45122, 45123])
  })

  it('clinvar_variant_by_rsid: total 0 means no ClinVar record, no throw', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '0', idlist: [] } }))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('clinvar_variant_by_rsid'),
      { rsid: 'rs999999999' },
      { ncbiEmail: 'x@y.org' }
    )) as { total: number; records: unknown[] }
    expect(out.total).toBe(0)
    expect(out.records).toEqual([])
  })

  it('clinvar_variant_by_rsid: non-rsID input throws', async () => {
    await expect(
      new ParserEngine({ fetchImpl: vi.fn() }).call(
        tool('clinvar_variant_by_rsid'),
        { rsid: 'VCV000045122' },
        { ncbiEmail: 'x@y.org' }
      )
    ).rejects.toThrow(/not an rsID/)
  })

  it('contact_email_required: no ncbiEmail -> structured result, never a throw, no fetch', async () => {
    const fetchImpl = vi.fn()
    for (const [id, args] of [
      ['clinvar_search', { query: 'BRCA1' }],
      ['clinvar_get_records', { accessions: ['VCV000045122'] }],
      ['clinvar_variant_by_rsid', { rsid: 'rs7412' }]
    ] as const) {
      const out = (await new ParserEngine({ fetchImpl }).call(tool(id), args, {})) as {
        error: string
        message: string
      }
      expect(out.error).toBe('contact_email_required')
      expect(out.message).toMatch(/contact email/i)
    }
    // Gate fires before any network call across all three tools.
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
