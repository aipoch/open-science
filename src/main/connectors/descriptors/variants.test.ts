import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { VARIANTS_TOOLS } from './variants'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('variants', () => {
  it('esearch + esummary, includes etiquette', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ esearchresult: { count: '2', idlist: ['1', '2'] } }))
      .mockResolvedValueOnce(
        jsonRes({
          result: {
            '1': {
              title: 'NM_007294.3:c.5075_5277dup',
              germline_classification: { description: 'Likely pathogenic' },
              genes: [{ symbol: 'BRCA1' }]
            },
            '2': {
              title: 'NM_007294.4(BRCA1):c.5467+200G>A',
              germline_classification: { description: 'Uncertain significance' },
              genes: [{ symbol: 'BRCA1' }]
            }
          }
        })
      )
    const tool = VARIANTS_TOOLS.find((t) => t.id === 'clinvar_search')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { term: 'BRCA1', retmax: 2 },
      { ncbiEmail: 'x@y.org' }
    )) as {
      count: number
      records: unknown[]
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(fetchImpl.mock.calls[0][0]).toContain('db=clinvar')
    expect(out.count).toBe(2)
    expect(out.records).toEqual([
      {
        uid: '1',
        title: 'NM_007294.3:c.5075_5277dup',
        clinical_significance: 'Likely pathogenic',
        gene: 'BRCA1'
      },
      {
        uid: '2',
        title: 'NM_007294.4(BRCA1):c.5467+200G>A',
        clinical_significance: 'Uncertain significance',
        gene: 'BRCA1'
      }
    ])
  })

  it('dbsnp_get_variant: esummary db=snp, includes etiquette, strips rs prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        result: {
          '7412': {
            snp_id: 7412,
            chr: '19',
            chrpos: '19:44908822',
            spdi: 'NC_000019.10:44908821:C:T',
            genes: [{ name: 'APOE' }],
            clinical_significance:
              'drug-response,risk-factor,benign,likely-benign,uncertain-significance,pathogenic,other'
          }
        }
      })
    )
    const tool = VARIANTS_TOOLS.find((t) => t.id === 'dbsnp_get_variant')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { rsid: 'rs7412' },
      { ncbiEmail: 'x@y.org' }
    )) as {
      rsid: string
      chr: string
      pos: number
      alleles: string
      gene: string
      clinical_significance: string
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('email=x%40y.org')
    expect(fetchImpl.mock.calls[0][0]).toContain('db=snp')
    expect(fetchImpl.mock.calls[0][0]).toContain('id=7412')
    expect(out).toEqual({
      rsid: 'rs7412',
      chr: '19',
      pos: 44908822,
      alleles: 'C>T',
      gene: 'APOE',
      clinical_significance:
        'drug-response,risk-factor,benign,likely-benign,uncertain-significance,pathogenic,other'
    })
  })

  it('dbsnp_get_variant: accepts a bare rs number (no rs prefix)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        result: {
          '7412': {
            snp_id: 7412,
            chr: '19',
            chrpos: '19:44908822',
            spdi: 'NC_000019.10:44908821:C:T'
          }
        }
      })
    )
    const tool = VARIANTS_TOOLS.find((t) => t.id === 'dbsnp_get_variant')!
    const out = (await new ParserEngine({ fetchImpl }).call(tool, { rsid: '7412' }, {})) as {
      rsid: string
    }
    expect(fetchImpl.mock.calls[0][0]).toContain('id=7412')
    expect(out.rsid).toBe('rs7412')
  })
})
