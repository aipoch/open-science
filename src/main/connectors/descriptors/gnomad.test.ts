import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { GNOMAD_TOOLS } from './gnomad'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('gnomad', () => {
  it('POSTs a GraphQL query + variables and parses gene variants', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        data: {
          gene: {
            gene_id: 'ENSG00000169174',
            symbol: 'PCSK9',
            chrom: '1',
            start: 55039475,
            stop: 55064852,
            variants: [
              {
                variant_id: '1-55039774-C-T',
                pos: 55039774,
                ref: 'C',
                alt: 'T',
                rsids: ['rs28362263'],
                exome: { ac: 5, an: 251312, af: 0.0000199 },
                genome: { ac: 1, an: 152180, af: 0.0000066 }
              }
            ]
          }
        }
      })
    )
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { gene_symbol: 'PCSK9' },
      {}
    )) as {
      gene_id: string
      symbol: string
      dataset: string
      n_variants_total: number
      returned: number
      variants: Array<{ variant_id: string; exome: unknown; genome: unknown }>
    }

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://gnomad.broadinstitute.org/api')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string) as { query: string; variables: unknown }
    expect(body.query).toContain('query GeneVariants')
    expect(body.query).toContain('variants(dataset: $dataset)')
    expect(body.variables).toEqual({ symbol: 'PCSK9', geneId: null, dataset: 'gnomad_r4' })

    expect(out.gene_id).toBe('ENSG00000169174')
    expect(out.symbol).toBe('PCSK9')
    expect(out.dataset).toBe('gnomad_r4')
    expect(out.n_variants_total).toBe(1)
    expect(out.returned).toBe(1)
    expect(out.variants).toEqual([
      {
        variant_id: '1-55039774-C-T',
        pos: 55039774,
        ref: 'C',
        alt: 'T',
        rsids: ['rs28362263'],
        exome: { ac: 5, an: 251312, af: 0.0000199 },
        genome: { ac: 1, an: 152180, af: 0.0000066 }
      }
    ])
  })

  it('bounds the variant payload to the limit while reporting the true total', async () => {
    const makeVariant = (i: number): unknown => ({
      variant_id: `1-${55039774 + i}-C-T`,
      pos: 55039774 + i,
      ref: 'C',
      alt: 'T',
      rsids: [],
      exome: null,
      genome: null
    })
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        data: {
          gene: {
            gene_id: 'ENSG00000169174',
            symbol: 'PCSK9',
            chrom: '1',
            start: 55039475,
            stop: 55064852,
            variants: Array.from({ length: 30 }, (_, i) => makeVariant(i))
          }
        }
      })
    )
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { gene_symbol: 'PCSK9', limit: 10 },
      {}
    )) as { n_variants_total: number; returned: number; variants: unknown[] }

    expect(out.n_variants_total).toBe(30)
    expect(out.returned).toBe(10)
    expect(out.variants).toHaveLength(10)
  })

  it('defaults the limit to 25 when unspecified', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        data: {
          gene: {
            gene_id: 'ENSG00000169174',
            symbol: 'PCSK9',
            variants: Array.from({ length: 40 }, (_, i) => ({
              variant_id: `1-${55039774 + i}-C-T`,
              pos: 55039774 + i,
              ref: 'C',
              alt: 'T',
              rsids: [],
              exome: null,
              genome: null
            }))
          }
        }
      })
    )
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool,
      { gene_symbol: 'PCSK9' },
      {}
    )) as {
      n_variants_total: number
      returned: number
    }

    expect(out.n_variants_total).toBe(40)
    expect(out.returned).toBe(25)
  })

  it('honors an explicit dataset arg', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ data: { gene: { gene_id: 'g1', variants: [] } } }))
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    await new ParserEngine({ fetchImpl }).call(
      tool,
      { gene_symbol: 'BRCA1', dataset: 'gnomad_r2_1' },
      {}
    )
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { variables: { dataset: string } }
    expect(body.variables.dataset).toBe('gnomad_r2_1')
  })

  it('returns an empty compact result when the gene is absent (data null), keyed by symbol', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ data: { gene: null } }))
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    const out = (await new ParserEngine({ fetchImpl }).call(tool, { gene_symbol: 'NOPE' }, {})) as {
      symbol: string
      gene_id: null
      n_variants: number
      variants: unknown[]
    }
    expect(out.symbol).toBe('NOPE')
    expect(out.gene_id).toBeNull()
    expect(out.n_variants).toBe(0)
    expect(out.variants).toEqual([])
  })

  it('returns an empty compact result on a "gene not found" GraphQL error, keyed by symbol', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({ data: { gene: null }, errors: [{ message: 'Gene not found' }] })
      )
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    const out = (await new ParserEngine({ fetchImpl }).call(tool, { gene_symbol: 'NOPE' }, {})) as {
      symbol: string
      n_variants: number
    }
    expect(out.symbol).toBe('NOPE')
    expect(out.n_variants).toBe(0)
  })

  it('throws on a non-not-found GraphQL error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'query complexity too high' }] }))
    const tool = GNOMAD_TOOLS.find((t) => t.id === 'gnomad_gene_variants')!
    await expect(
      new ParserEngine({ fetchImpl }).call(tool, { gene_symbol: 'PCSK9' }, {})
    ).rejects.toThrow(/query complexity too high/)
  })
})
