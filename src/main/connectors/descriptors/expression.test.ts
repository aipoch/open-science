import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import { EXPRESSION_TOOLS } from './expression'
import type { ToolDescriptor } from '../types'

const tool = (id: string): ToolDescriptor => EXPRESSION_TOOLS.find((t) => t.id === id)!
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

describe('expression / gtex_resolve_gene', () => {
  it('builds the reference/gene URL and parses gene rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: [
          {
            geneSymbol: 'BRCA2',
            gencodeId: 'ENSG00000139618.14',
            gencodeVersion: 'v26',
            genomeBuild: 'GRCh38/hg38'
          }
        ],
        paging_info: { numberOfPages: 1, page: 0, maxItemsPerPage: 250, totalNumberOfItems: 1 }
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gtex_resolve_gene'),
      { geneId: 'BRCA2' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gtexportal.org/api/v2/reference/gene?geneId=BRCA2'
    )
    expect(out).toEqual([
      {
        gene_symbol: 'BRCA2',
        gencode_id: 'ENSG00000139618.14',
        gencode_version: 'v26',
        genome_build: 'GRCh38/hg38'
      }
    ])
  })

  it('returns an empty array when there is no data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gtex_resolve_gene'),
      { geneId: 'NOPE' },
      {}
    )
    expect(out).toEqual([])
  })
})

describe('expression / gtex_gene_expression', () => {
  it('builds the medianGeneExpression URL (with default dataset) and parses tissue medians', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonRes({
        data: [
          {
            median: 0.578425,
            tissueSiteDetailId: 'Adipose_Subcutaneous',
            datasetId: 'gtex_v8',
            gencodeId: 'ENSG00000139618.14',
            geneSymbol: 'BRCA2',
            unit: 'TPM'
          },
          {
            median: 0.372348,
            tissueSiteDetailId: 'Adipose_Visceral_Omentum',
            datasetId: 'gtex_v8',
            gencodeId: 'ENSG00000139618.14',
            geneSymbol: 'BRCA2',
            unit: 'TPM'
          }
        ]
      })
    )
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gtex_gene_expression'),
      { gencodeId: 'ENSG00000139618.14' },
      {}
    )
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://gtexportal.org/api/v2/expression/medianGeneExpression?gencodeId=ENSG00000139618.14&datasetId=gtex_v8'
    )
    expect(out).toEqual([
      { tissue: 'Adipose_Subcutaneous', median_tpm: 0.578425, unit: 'TPM' },
      { tissue: 'Adipose_Visceral_Omentum', median_tpm: 0.372348, unit: 'TPM' }
    ])
  })

  it('honors an explicit datasetId override', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('gtex_gene_expression'),
      { gencodeId: 'ENSG00000139618.14', datasetId: 'gtex_v10' },
      {}
    )
    const url = fetchImpl.mock.calls[0][0] as string
    expect(url).toContain('datasetId=gtex_v10')
  })

  it('returns an empty array when there is no data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ data: [] }))
    const out = await new ParserEngine({ fetchImpl }).call(
      tool('gtex_gene_expression'),
      { gencodeId: 'ENSG00000000000.0' },
      {}
    )
    expect(out).toEqual([])
  })
})
